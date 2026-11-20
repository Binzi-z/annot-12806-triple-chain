/**
 * workspace.ts —— monorepo 发现与 workspace 依赖的真实路径解析。
 *
 * 只信 package.json：根 workspaces（npm/yarn/pnpm 三种写法都认）+ 每个包的
 * name/main/types，把 "@doc/parser-wrapper" 这类 bare specifier 解析到磁盘上
 * 的真实文件，而不是当成外部依赖跳过。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export interface PackageInfo {
  /** 包名，如 @doc/parser-wrapper；无名包用目录名。 */
  name: string;
  dir: string;
  /** 入口（相对包目录），缺省按 src/index.ts、index.ts 等回退。 */
  entry: string;
  /** package.json 里声明的 workspace:* / * / 普通版本依赖名集合。 */
  deps: Set<string>;
}

export interface RepoLayout {
  root: string;
  packages: PackageInfo[];
  /** 包名 -> 包信息（workspace 依赖按它解析）。 */
  byName: Map<string, PackageInfo>;
  /** 参与分析的源码文件（仓库相对路径，正斜杠），已排序。 */
  files: string[];
}

const SOURCE_EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "lib", "coverage", ".cache"]);

function readJson(file: string): any {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function expandWorkspaceGlobs(root: string, patterns: string[]): string[] {
  const dirs: string[] = [];
  for (const pattern of patterns) {
    // 只支持语料/常见 monorepo 的 "packages/*" 与显式路径两种形态。
    const clean = pattern.replace(/\/+$/, "");
    if (clean.endsWith("/*")) {
      const base = path.join(root, clean.slice(0, -2));
      if (!fs.existsSync(base)) continue;
      for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
        if (entry.isDirectory()) dirs.push(path.join(base, entry.name));
      }
    } else if (clean === "*") {
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (entry.isDirectory()) dirs.push(path.join(root, entry.name));
      }
    } else {
      const abs = path.join(root, clean);
      if (fs.existsSync(abs)) dirs.push(abs);
    }
  }
  return dirs;
}

function resolvePackageEntry(pkgDir: string, pkgJson: any): string {
  const candidates: string[] = [];
  const pushEntry = (v: unknown) => {
    if (typeof v === "string") candidates.push(v);
  };
  pushEntry(pkgJson.types);
  pushEntry(pkgJson.main);
  if (pkgJson.exports) {
    const rootExport = pkgJson.exports["."] ?? pkgJson.exports;
    if (typeof rootExport === "string") pushEntry(rootExport);
    else if (rootExport && typeof rootExport === "object") {
      pushEntry(rootExport.types);
      pushEntry(rootExport.import);
      pushEntry(rootExport.require);
      pushEntry(rootExport.default);
    }
  }
  candidates.push("src/index.ts", "src/index.js", "index.ts", "index.js");
  for (const c of candidates) {
    if (!c) continue;
    const rel = c.replace(/^\.\//, "");
    const abs = path.join(pkgDir, rel);
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return rel;
    for (const ext of SOURCE_EXTS) {
      if (fs.existsSync(abs + ext)) return rel + ext;
    }
    if (fs.existsSync(path.join(abs, "index.ts"))) return path.join(rel, "index.ts");
  }
  return "src/index.ts";
}

export function discoverRepo(root: string): RepoLayout {
  const rootPkgPath = path.join(root, "package.json");
  const pkgDirs: string[] = [];
  if (fs.existsSync(rootPkgPath)) {
    const rootPkg = readJson(rootPkgPath);
    const workspaceField = rootPkg.workspaces;
    let patterns: string[] = [];
    if (Array.isArray(workspaceField)) patterns = workspaceField;
    else if (workspaceField && Array.isArray(workspaceField.packages))
      patterns = workspaceField.packages;
    if (patterns.length) pkgDirs.push(...expandWorkspaceGlobs(root, patterns));
  }
  // 没有 workspaces 字段时，回退到 packages/* 与含 package.json 的一级子目录。
  if (!pkgDirs.length) {
    const fallback = path.join(root, "packages");
    if (fs.existsSync(fallback)) {
      for (const e of fs.readdirSync(fallback, { withFileTypes: true })) {
        if (e.isDirectory()) pkgDirs.push(path.join(fallback, e.name));
      }
    }
  }

  const packages: PackageInfo[] = [];
  for (const dir of pkgDirs.sort()) {
    const pj = path.join(dir, "package.json");
    if (!fs.existsSync(pj)) continue;
    const json = readJson(pj);
    const deps = new Set<string>([
      ...Object.keys(json.dependencies ?? {}),
      ...Object.keys(json.devDependencies ?? {}),
      ...Object.keys(json.peerDependencies ?? {}),
    ]);
    packages.push({
      name: json.name ?? path.basename(dir),
      dir,
      entry: resolvePackageEntry(dir, json),
      deps,
    });
  }

  const byName = new Map<string, PackageInfo>();
  for (const p of packages) byName.set(p.name, p);

  // 收集所有 workspace 包内的源码文件（含入口目录之外的，保证 doc-service 多文件都在）。
  const fileSet = new Set<string>();
  for (const p of packages) {
    walkSourceFiles(p.dir, root, fileSet);
  }
  // 根目录下若有独立 src 也纳入（容错），语料本身不需要。
  const files = [...fileSet].sort();
  return { root, packages, byName, files };
}

function walkSourceFiles(dir: string, root: string, out: Set<string>): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    if (SKIP_DIRS.has(entry.name)) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkSourceFiles(abs, root, out);
    } else if (SOURCE_EXTS.some((e) => entry.name.endsWith(e)) && !entry.name.endsWith(".d.ts")) {
      out.add(toRel(root, abs));
    }
  }
}

export function toRel(root: string, abs: string): string {
  return path.relative(root, abs).split(path.sep).join("/");
}

export function hashFile(abs: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(abs)).digest("hex");
}

/**
 * 把 import/export 的 module specifier 解析成「仓库相对文件路径」。
 * workspace bare specifier 按 package.json 真实入口/依赖解析；
 * 解析不到的外部包返回 null（调用方登记为外部模块，不报错）。
 */
export function resolveModule(
  specifier: string,
  fromFile: string,
  layout: RepoLayout,
): { kind: "workspace"; file: string } | { kind: "relative"; file: string } | { kind: "external" } {
  if (specifier.startsWith(".") || specifier.startsWith("/")) {
    const base = path.join(layout.root, path.dirname(fromFile));
    const abs = path.resolve(base, specifier);
    const hit = resolveFileWithExtensions(abs);
    if (hit) return { kind: "relative", file: toRel(layout.root, hit) };
    return { kind: "external" };
  }

  // bare specifier：先按 workspace 包名（含 "@doc/pkg/sub/path" 子路径）匹配。
  const segments = specifier.split("/");
  const scoped = specifier.startsWith("@") ? 2 : 1;
  const pkgName = segments.slice(0, scoped).join("/");
  const subPath = segments.slice(scoped).join("/");
  const pkg = layout.byName.get(pkgName);
  if (pkg) {
    if (!subPath) {
      const abs = path.join(pkg.dir, pkg.entry);
      return { kind: "workspace", file: toRel(layout.root, abs) };
    }
    const abs = path.join(pkg.dir, subPath);
    const hit = resolveFileWithExtensions(abs);
    if (hit) return { kind: "workspace", file: toRel(layout.root, hit) };
  }
  return { kind: "external" };
}

function resolveFileWithExtensions(absNoExt: string): string | null {
  if (fs.existsSync(absNoExt) && fs.statSync(absNoExt).isFile()) return absNoExt;
  for (const ext of SOURCE_EXTS) {
    if (fs.existsSync(absNoExt + ext)) return absNoExt + ext;
  }
  for (const ext of SOURCE_EXTS) {
    const idx = path.join(absNoExt, "index" + ext);
    if (fs.existsSync(idx)) return idx;
  }
  return null;
}
