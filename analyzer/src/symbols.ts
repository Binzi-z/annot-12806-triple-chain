/**
 * symbols.ts —— 自建符号表与跨文件解析。
 *
 * 输入是 extract 阶段产出的纯数据 FileFact，输出一个 GlobalIndex：
 *  - 每个文件的 import 绑定到「真实 workspace 文件 + 导出名」；
 *  - 调用链（自由函数名 / ns.member）解析到具体 FunctionFact；
 *  - 顶层配置常量可按名取到 ValueExpr，供 config.ts 做常量折叠。
 *
 * 解析不到的 workspace 导入登记 unresolved-import；外部库（sax/xml2js/...）
 * 属于环境依赖，按 external 处理而不是未决。
 */
import type {
  ExportSpec,
  FileFact,
  FunctionFact,
  ImportSpec,
  TaintToken,
  ValueExpr,
} from "./types.ts";
import { EXTERNAL_XML_MODULES } from "./constants.ts";
import { resolveModule, type RepoLayout } from "./workspace.ts";

export type CallResolution =
  | { kind: "function"; id: string }
  | { kind: "external"; module: string; member: string }
  | { kind: "unknown"; reason: string };

interface ExportBinding {
  file: string;
  exportName: string;
  localName: string;
}

export class GlobalIndex {
  /** 文件 -> 本地名 -> 解析后的导出绑定。 */
  private importBindings = new Map<string, Map<string, ExportBinding | { external: string }>>();
  private nsBindings = new Map<string, Map<string, string>>(); // file -> local ns -> target file
  private funcById = new Map<string, FunctionFact>();
  private fileByPath = new Map<string, FileFact>();
  /** file -> 扁平化导出表（导出名 -> 绑定），barrel 的 export * 只合并一次，之后查询 O(1)。 */
  private flatExports = new Map<string, Map<string, ExportBinding>>();
  /** (fromFile::specifier) -> 模块解析结果，缓存文件系统解析。 */
  private moduleMemo = new Map<string, ReturnType<typeof resolveModule>>();
  /** file -> export * 已解析到的目标文件列表（只解析一次）。 */
  private starTargets = new Map<string, string[]>();
  /** 正在构建扁平表的文件，用于 star 环的保护。 */
  private buildingFlat = new Set<string>();
  unresolvedImports: Array<{ file: string; specifier: string; localName: string }> = [];
  layout: RepoLayout;
  files: FileFact[];

  constructor(layout: RepoLayout, files: FileFact[]) {
    this.layout = layout;
    this.files = files;
    for (const f of files) this.fileByPath.set(f.path, f);
    for (const f of files) for (const fn of Object.values(f.functions)) this.funcById.set(fn.id, fn);
    this.precomputeStarTargets();
    this.buildImports();
  }

  /** 带缓存的模块解析：同一 (fromFile, specifier) 只打一次文件系统。 */
  private resolveModuleCached(fromFile: string, specifier: string): ReturnType<typeof resolveModule> {
    const key = `${fromFile}::${specifier}`;
    const cached = this.moduleMemo.get(key);
    if (cached) return cached;
    const r = resolveModule(specifier, fromFile, this.layout);
    this.moduleMemo.set(key, r);
    return r;
  }

  /** 每个文件的 export * 目标文件只解析并落盘一次。 */
  private precomputeStarTargets(): void {
    for (const f of this.files) {
      const targets: string[] = [];
      for (const ex of f.exports) {
        if (ex.exportName === "*" && ex.moduleSpecifier) {
          const r = this.resolveModuleCached(f.path, ex.moduleSpecifier);
          if (r.kind !== "external") targets.push(r.file);
        }
      }
      this.starTargets.set(f.path, targets);
    }
  }

  /**
   * 构建/取一个文件的扁平导出表：自身具名导出 + 各 export * 目标表合并。
   * 总条目数等于真实导出名数量（barrel 一次性聚合），不会按「名字 × star 目标」膨胀；
   * star 环用 buildingFlat 保护，遇环返回部分表也能收敛，不递归爆栈、不撑爆 Map。
   */
  private getFlatExports(file: string): Map<string, ExportBinding> {
    const cached = this.flatExports.get(file);
    if (cached) return cached;
    const map = new Map<string, ExportBinding>();
    this.flatExports.set(file, map); // 先占位，递归/环路上拿到同一张表
    this.buildingFlat.add(file);
    const fact = this.fileByPath.get(file);
    if (fact) {
      // 1) 自身具名导出（含 export { x } from "./mod"，落到目标表取绑定）。
      for (const ex of fact.exports) {
        if (ex.exportName === "*") continue;
        if (ex.moduleSpecifier) {
          const r = this.resolveModuleCached(file, ex.moduleSpecifier);
          if (r.kind !== "external") {
            const target = this.getFlatExports(r.file).get(ex.localName);
            if (target) map.set(ex.exportName, target);
          }
        } else {
          map.set(ex.exportName, { file, exportName: ex.exportName, localName: ex.localName });
        }
      }
      // 2) export * 聚合：逐目标合并，先到先得（与 ES 模块 star 解析的遮蔽语义一致）。
      for (const targetFile of this.starTargets.get(file) ?? []) {
        if (this.buildingFlat.has(targetFile) && targetFile !== file) continue;
        for (const [name, binding] of this.getFlatExports(targetFile)) {
          if (!map.has(name)) map.set(name, binding);
        }
      }
    }
    this.buildingFlat.delete(file);
    return map;
  }

  getFunction(id: string): FunctionFact | undefined {
    return this.funcById.get(id);
  }

  getFile(path: string): FileFact | undefined {
    return this.fileByPath.get(path);
  }

  allFunctions(): FunctionFact[] {
    return [...this.funcById.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  private buildImports(): void {
    for (const f of this.files) {
      const local = new Map<string, ExportBinding | { external: string }>();
      const ns = new Map<string, string>();
      for (const imp of f.imports) {
        const resolved = this.resolveModuleCached(f.path, imp.moduleSpecifier);
        if (resolved.kind === "external") {
          local.set(imp.localName, { external: imp.moduleSpecifier });
          continue;
        }
        const targetFile = resolved.file;
        if (imp.isNamespace) {
          ns.set(imp.localName, targetFile);
          continue;
        }
        const binding = this.resolveExport(targetFile, imp.importedName);
        if (!binding) {
          this.unresolvedImports.push({
            file: f.path,
            specifier: imp.moduleSpecifier,
            localName: imp.localName,
          });
          continue;
        }
        local.set(imp.localName, binding);
      }
      this.importBindings.set(f.path, local);
      this.nsBindings.set(f.path, ns);
    }
  }

  /** 导出解析：直接查该文件的扁平导出表（barrel 已一次性聚合 export *），O(1)。 */
  private resolveExport(file: string, exportName: string): ExportBinding | null {
    return this.getFlatExports(file).get(exportName) ?? null;
  }

  /** 把调用链解析成函数 id / 外部库成员 / 未知。 */
  resolveCall(file: string, chain: string[]): CallResolution {
    if (chain.length === 0) return { kind: "unknown", reason: "empty-chain" };
    const local = this.importBindings.get(file);
    const ns = this.nsBindings.get(file);

    if (chain.length === 1) {
      const name = chain[0];
      // 本文件函数优先。
      if (this.funcById.has(`${file}#${name}`)) return { kind: "function", id: `${file}#${name}` };
      const binding = local?.get(name);
      if (binding) {
        if ("external" in binding)
          return { kind: "external", module: binding.external, member: name };
        if (this.funcById.has(`${binding.file}#${binding.localName}`))
          return { kind: "function", id: `${binding.file}#${binding.localName}` };
        return { kind: "unknown", reason: `export-not-a-function:${binding.file}#${binding.localName}` };
      }
      return { kind: "unknown", reason: `unbound-name:${name}` };
    }

    // 多段链：ns.member(...) 或 obj.method(...)。
    const head = chain[0];
    const nsTarget = ns?.get(head);
    if (nsTarget) {
      const member = chain.slice(1).join(".");
      const binding = this.resolveExport(nsTarget, member);
      if (binding && this.funcById.has(`${binding.file}#${binding.localName}`))
        return { kind: "function", id: `${binding.file}#${binding.localName}` };
      const ext = this.fileByPath.get(nsTarget);
      return { kind: "unknown", reason: `ns-member-unresolved:${member}` };
    }
    const binding = local?.get(head);
    if (binding) {
      if ("external" in binding)
        return { kind: "external", module: binding.external, member: chain.slice(1).join(".") };
      // 导入的是对象/配置而非函数，成员调用无法落到函数。
      return { kind: "unknown", reason: `member-of-import:${chain.join(".")}` };
    }
    // 本文件局部对象的方法（如 parser.write、stream.on）：无函数实体，按未知返回，
    // 但 sink 识别已在 extract 阶段按变量标记完成，不依赖这里解析。
    return { kind: "unknown", reason: `local-member:${chain.join(".")}` };
  }

  /** 取顶层常量值（可跨 import 追配置对象），depth 防环。 */
  getTopLevelValue(file: string, name: string, seen = new Set<string>()): ValueExpr | undefined {
    const key = `${file}#${name}`;
    if (seen.has(key)) return undefined;
    seen.add(key);
    const fact = this.fileByPath.get(file);
    if (!fact) return undefined;
    if (fact.topLevelValues[name] !== undefined) return fact.topLevelValues[name];
    const binding = this.importBindings.get(file)?.get(name);
    if (binding && !("external" in binding)) {
      return this.getTopLevelValue(binding.file, binding.localName, seen);
    }
    return undefined;
  }

  /** 判断文件里某个 import 是否来自外部 XML 库。 */
  isExternalModule(file: string, moduleName: string): boolean {
    return EXTERNAL_XML_MODULES.has(moduleName);
  }

  /** 工具：把函数参数污点 token 从 caller 实参映射到 callee 形参。 */
  static mapTokens(tokens: TaintToken[], mapping: Map<string, TaintToken[]>): TaintToken[] {
    const out: TaintToken[] = [];
    for (const t of tokens) {
      if (t.startsWith("p")) {
        for (const m of mapping.get(t) ?? []) out.push(m);
      } else {
        out.push(t);
      }
    }
    return [...new Set(out)].sort();
  }

  importsOf(file: string): ImportSpec[] {
    return this.fileByPath.get(file)?.imports ?? [];
  }

  exportsOf(file: string): ExportSpec[] {
    return this.fileByPath.get(file)?.exports ?? [];
  }
}
