/**
 * analyze.ts —— 全局分析编排。
 *
 * 流水线：
 *  1. 解析全部文件 -> FileFact（extract），建 GlobalIndex（符号表 + workspace 解析）。
 *  2. 建调用图并给边数上界；解析失败的调用标 unresolved 进未决清单。
 *  3. 深度受限的跨过程 DFS 求每个函数的「原始可达 sink 汇总」（带形参 token，memo 化）。
 *  4. 从三类入口源驱动污点，把源标签沿形参/实参映射推到 sink；
 *     sink 是否被净化由「同一污点的 guard」+「构造/配置参数折叠」共同决定。
 *  5. 确定不了的（工厂间接传参断裂、动态分派、未解析导入、边数触顶）一律 unknown 进未决清单。
 *
 * 全程只处理可序列化纯数据，输出顺序全部排序，不写任何时间戳。
 */
import {
  MAX_CALL_EDGES,
  MAX_SUMMARY_DEPTH,
  MAX_TARGETS_PER_CALLSITE,
  RULE_ID_BY_SINK,
  RULES,
  SANITIZER_NAME_HINTS,
  SECURE_CONFIG_KEYS,
  SOURCE_LABELS,
  findingSortKey,
} from "./constants.ts";
import type {
  AnalysisResult,
  AnalysisStats,
  Finding,
  FunctionFact,
  PendingEntry,
  SinkFact,
  SourceLabel,
  TaintToken,
  ValueExpr,
} from "./types.ts";
import { GlobalIndex } from "./symbols.ts";
import { sinkConfigDecision, type FoldCtx } from "./config.ts";
import type { FileFact } from "./types.ts";
import type { RepoLayout } from "./workspace.ts";

interface ReachableSink {
  sink: SinkFact;
  /** 产生该 sink 的函数文件（sink 所在文件）。 */
  file: string;
  /** 从当前汇总根到该 sink 的函数 id 链。 */
  path: string[];
  /** 跨过程跳数，环路上用于上界截断。 */
  hops: number;
  /** 沿路上作用于「会流到该 sink 的污点」的 guard 集合（形参 token 视角）。 */
  guardedTokens: TaintToken[];
}

interface RawSummary {
  reachable: ReachableSink[];
  /** 去重键集合，保证 merge 是均摊 O(1)，避免大图上 O(n²) 线性扫描。 */
  keys: Set<string>;
}

export class Analyzer {
  private index: GlobalIndex;
  private pending: PendingEntry[] = [];
  private pendingSeq = 0;
  private callEdges = 0;
  private edgeCapReached = false;
  private sanitizerFunctions = new Set<string>();
  private stats: AnalysisStats;
  private layout: RepoLayout;
  private files: FileFact[];

  constructor(layout: RepoLayout, files: FileFact[]) {
    this.layout = layout;
    this.files = files;
    this.index = new GlobalIndex(layout, files);
    this.stats = {
      files: files.length,
      lines: files.reduce((n, f) => n + f.lineCount, 0),
      functions: 0,
      sinks: 0,
      callEdges: 0,
      callEdgeCap: MAX_CALL_EDGES,
      callEdgeCapReached: false,
      findings: 0,
      pending: 0,
      durationMs: 0,
    };
  }

  run(startedAt: number): AnalysisResult {
    this.stats.functions = this.index.allFunctions().length;
    this.stats.sinks = this.index
      .allFunctions()
      .reduce((n, fn) => n + fn.sinks.length, 0);

    this.registerPendingImportsAndSyntax();
    this.markSanitizers();
    this.buildCallGraph();
    this.computeFixpoint();
    const findings = this.analyzeEntries();

    const pending = [...this.pending].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    );
    const dedupFindings = this.dedupFindings(findings);
    this.stats.callEdges = this.callEdges;
    this.stats.callEdgeCapReached = this.edgeCapReached;
    this.stats.findings = dedupFindings.length;
    this.stats.pending = pending.length;
    this.stats.durationMs = Date.now() - startedAt;
    return { findings: dedupFindings, pending, stats: this.stats, rules: [...RULES].sort() };
  }

  private addPending(
    kind: PendingEntry["kind"],
    file: string,
    line: number,
    symbol: string,
    detail: string,
  ): void {
    const id = `P${String(++this.pendingSeq).padStart(4, "0")}`;
    this.pending.push({ id, kind, file, line, symbol, detail });
  }

  private registerPendingImportsAndSyntax(): void {
    for (const u of this.index.unresolvedImports) {
      this.addPending(
        "unresolved-import",
        u.file,
        1,
        u.localName,
        `workspace 导入 '${u.specifier}' 无法解析到真实文件/导出`,
      );
    }
    for (const f of this.files) {
      for (const e of f.syntaxErrors)
        this.addPending("syntax-error", f.path, e.line, "parse", e.message);
    }
  }

  /** 函数名命中净化原语提示，或函数体内直接出现这些调用——它是 guard 提供方。 */
  private markSanitizers(): void {
    for (const fn of this.index.allFunctions()) {
      const named = SANITIZER_NAME_HINTS.some((h) => fn.name.includes(h));
      const calls = fn.sanitizerCalls.length > 0;
      if (named || calls) this.sanitizerFunctions.add(fn.id);
    }
  }

  /** 建调用图：每个可解析的函数间调用产生一条边，边数受 MAX_CALL_EDGES 上界约束。 */
  private buildCallGraph(): void {
    for (const fn of this.index.allFunctions()) {
      for (const call of fn.calls) {
        const resolution = this.index.resolveCall(fn.file, call.calleeChain);
        if (resolution.kind === "function") {
          call.resolvedId = resolution.id;
          if (this.callEdges >= MAX_CALL_EDGES) {
            if (!this.edgeCapReached) {
              this.edgeCapReached = true;
              this.addPending(
                "edge-cap",
                fn.file,
                call.line,
                call.calleeChain.join("."),
                `调用图边数触顶 ${MAX_CALL_EDGES}，超出部分不再展开`,
              );
            }
            call.unresolved = true;
            continue;
          }
          this.callEdges++;
        } else if (resolution.kind === "unknown") {
          call.unresolved = true;
          // 只把「项目内自由函数名解析失败」计入未决；外部库/JS 全局（String/Error/Promise/
          // 测试框架 test 等）与回调参数（done）属于环境或运行时机制，不是分析器的盲区。
          if (call.calleeChain.length === 1 && this.isProjectCallee(fn, call.calleeChain[0])) {
            this.addPending(
              "unresolved-callee",
              fn.file,
              call.line,
              call.calleeChain.join("."),
              resolution.reason,
            );
          }
        }
        // external：环境库（sax/xml2js 等），已由 sink 模型覆盖，不登记。
      }
    }
  }

  /** 名字是否可能指向项目内函数：是本文件已知函数、或由某条 import 绑定引入。 */
  private isProjectCallee(fn: FunctionFact, name: string): boolean {
    if (this.index.getFunction(`${fn.file}#${name}`)) return true;
    const imported = new Set(fn.paramNames);
    // 回调形参（done/cb/next 等）不是项目函数。
    if (imported.has(name)) return false;
    const fileFact = this.index.getFile(fn.file);
    if (fileFact && fileFact.imports.some((i) => i.localName === name)) return true;
    if (fileFact && fileFact.topLevelValues[name] !== undefined) return false;
    // 全局对象/测试框架等：首字母大写的内置构造器或常见测试名直接排除。
    const globals = new Set([
      "String", "Number", "Boolean", "Array", "Object", "Error", "Promise",
      "JSON", "Math", "Date", "RegExp", "Map", "Set", "Symbol", "console",
      "test", "describe", "it", "expect", "require", "setTimeout", "setInterval",
    ]);
    return !globals.has(name);
  }

  /** 反向边：callee id -> 调用它的 (caller, call) 列表，供 worklist 回传。 */
  private reverseEdges = new Map<string, Array<{ callerId: string; callIndex: number }>>();
  private summaries = new Map<string, RawSummary>();

  /**
   * 迭代不动点求每个函数的「可达 sink 汇总」（形参 token 视角）。
   * 收敛保证：去重键不含 hops/path，自环/递归翻译出的等价 sink 命中同一键；
   * path 只在出现「更短路径」时更新。环靠「无新增即收敛」终止，跳数仅作兜底，
   * 因此不会因环路路径无限增长而 OOM。
   */
  private computeFixpoint(): void {
    const all = this.index.allFunctions();
    for (const fn of all) this.summaries.set(fn.id, { reachable: [], keys: new Set() });
    for (const fn of all) {
      for (let i = 0; i < fn.calls.length; i++) {
        const call = fn.calls[i];
        if (!call.resolvedId) continue;
        const list = this.reverseEdges.get(call.resolvedId) ?? [];
        list.push({ callerId: fn.id, callIndex: i });
        this.reverseEdges.set(call.resolvedId, list);
      }
    }

    // 初始化：每个函数自身的直接 sink。
    const worklist: string[] = [];
    for (const fn of all) {
      const summary = this.summaries.get(fn.id)!;
      for (const sink of fn.sinks) {
        const item: ReachableSink = {
          sink,
          file: fn.file,
          path: [fn.id],
          hops: 0,
          guardedTokens: [...new Set(sink.guardedBefore ? sink.xmlTaint : [])].sort(),
        };
        const key = this.reachableKey(item);
        if (!summary.keys.has(key)) {
          summary.keys.add(key);
          summary.reachable.push(item);
        }
      }
      worklist.push(fn.id);
    }

    const inList = new Set(worklist);
    // 头指针队列：避免 Array.shift() 在大 worklist 上的 O(n) 内存搬移（整体退化为 O(n²)）。
    let head = 0;
    while (head < worklist.length) {
      const calleeId = worklist[head++];
      inList.delete(calleeId);
      const calleeSummary = this.summaries.get(calleeId)!;
      for (const { callerId, callIndex } of this.reverseEdges.get(calleeId) ?? []) {
        const caller = this.index.getFunction(callerId);
        if (!caller) continue;
        const call = caller.calls[callIndex];
        const callee = this.index.getFunction(calleeId);
        if (!callee) continue;
        const callerSummary = this.summaries.get(callerId)!;
        let changed = false;
        for (const rs of calleeSummary.reachable) {
          if (rs.hops >= MAX_SUMMARY_DEPTH) continue; // 跳数兜底：极端互递归不无限展开
          const translated = this.translateAcross(rs, call, callee, callerId);
          if (this.mergeReachable(callerSummary, translated)) changed = true;
        }
        if (changed && !inList.has(callerId)) {
          worklist.push(callerId);
          inList.add(callerId);
        }
      }
    }
  }

  /**
   * 稳定去重键：同一 sink 坐标 + 同一污点/guard 集合即等价，与跳数/路径长度无关。
   * 这是环上能收敛的关键——递归自环翻译出的 sink 污点不变，命中同一键被丢弃。
   */
  private reachableKey(rs: ReachableSink): string {
    return [
      rs.file,
      rs.sink.line,
      rs.sink.column,
      rs.sink.kind,
      [...rs.sink.xmlTaint].sort().join(","),
      [...rs.guardedTokens].sort().join(","),
    ].join("|");
  }

  private mergeReachable(summary: RawSummary, rs: ReachableSink): boolean {
    const key = this.reachableKey(rs);
    if (summary.keys.has(key)) return false; // 已存在等价项，环上在此终止
    summary.keys.add(key);
    summary.reachable.push(rs);
    return true;
  }

  /** 把 callee 汇总里的一条可达 sink 翻译到 caller 视角（形参 token -> 实参污点）。 */
  private translateAcross(
    rs: ReachableSink,
    call: { argTaint: TaintToken[][]; line: number },
    callee: FunctionFact,
    callerId: string,
  ): ReachableSink {
    const mapping = new Map<string, TaintToken[]>();
    callee.paramNames.forEach((_, i) => mapping.set(`p${i}`, call.argTaint[i] ?? []));
    const translatedTaint = GlobalIndex.mapTokens(rs.sink.xmlTaint, mapping);
    const translatedGuard = GlobalIndex.mapTokens(rs.guardedTokens, mapping);
    const clone: SinkFact = { ...rs.sink, xmlTaint: translatedTaint };
    return {
      sink: clone,
      file: rs.file,
      path: [callerId, ...rs.path],
      hops: rs.hops + 1,
      guardedTokens: translatedGuard,
    };
  }

  /** 入口识别：doc-service 里直接接触三类源的函数。 */
  private isEntry(fn: FunctionFact): boolean {
    // 入口判定不依赖目录名，而看函数体内是否出现源模式（extract 已把源折成污点标签）。
    const taints = new Set<TaintToken>();
    for (const s of fn.sinks) s.xmlTaint.forEach((t) => taints.add(t));
    for (const c of fn.calls) c.argTaint.flat().forEach((t) => taints.add(t));
    for (const e of fn.events) e.receiverTaint.forEach((t) => taints.add(t));
    return SOURCE_LABELS.some((label) => taints.has(label));
  }

  private analyzeEntries(): Finding[] {
    const findings: Finding[] = [];
    const entries = this.index
      .allFunctions()
      .filter((fn) => this.isEntry(fn))
      .sort((a, b) => (a.id < b.id ? -1 : 1));

    for (const entry of entries) {
      const summary = this.summaries.get(entry.id) ?? { reachable: [], keys: new Set<string>() };
      for (const rs of summary.reachable) {
        const source = this.pickSource(rs.sink.xmlTaint);
        if (!source) continue; // sink 拿不到任何外部源污点，不报也不算未决（内部数据）。
        const sinkFn = this.index.getFunction(rs.path[rs.path.length - 1]);
        const baseCtx: FoldCtx = {
          file: rs.file,
          index: this.index,
          depth: 0,
          paramValues: new Map(),
          locals: new Map(Object.entries(sinkFn?.localValues ?? {})),
        };
        const decision = sinkFn
          ? sinkConfigDecision(rs.sink, sinkFn, baseCtx)
          : { verdict: "unknown" as const, hasUnresolvableSecurityKey: true };
        const guarded = rs.guardedTokens.includes(source) || rs.sink.guardedBefore;

        if (guarded || decision.verdict === "safe") continue; // 净化成立：抑制。

        if (decision.verdict === "unknown" && decision.hasUnresolvableSecurityKey) {
          this.addPending(
            "unknown-config",
            rs.file,
            rs.sink.line,
            rs.sink.calleeChain.join("."),
            `sink '${rs.sink.calleeChain.join(".")}' 的构造/选项参数经工厂间接传入且折叠断裂，无法静态确定是否关闭 DTD/外部实体`,
          );
          continue;
        }
        // 无显式安全键配置（解析器默认值）按题目根因视为 open：默认即允许外部实体。
        findings.push(this.toFinding(rs, source, entry, "open"));
      }
      // 入口里解析不出、且确实可能是项目内函数的调用：污点去向未知。
      // 全局函数/环境调用（String(...) 等）与回调形参不计入未决。
      for (const call of entry.calls) {
        if (
          call.unresolved &&
          call.calleeChain.length === 1 &&
          this.isProjectCallee(entry, call.calleeChain[0])
        ) {
          this.addPending(
            "taint-unknown",
            entry.file,
            call.line,
            call.calleeChain.join("."),
            "外部源污点流入无法解析的函数，传播链断裂",
          );
        }
      }
    }
    return findings;
  }

  private pickSource(tokens: TaintToken[]): SourceLabel | null {
    for (const label of SOURCE_LABELS) if (tokens.includes(label)) return label;
    return null;
  }

  private toFinding(
    rs: ReachableSink,
    source: SourceLabel,
    entry: FunctionFact,
    verdict: string,
  ): Finding {
    const ruleId = RULE_ID_BY_SINK[rs.sink.kind];
    const pathNames = rs.path.map((id) => id.split("#")[1] ?? id);
    return {
      ruleId,
      sink: rs.sink.kind,
      file: rs.file,
      line: rs.sink.line,
      column: rs.sink.column,
      source,
      entry: entry.name,
      entryFile: entry.file,
      path: pathNames,
      message: this.buildMessage(rs, source, entry, verdict),
    };
  }

  private buildMessage(
    rs: ReachableSink,
    source: SourceLabel,
    entry: FunctionFact,
    verdict: string,
  ): string {
    const sourceText: Record<SourceLabel, string> = {
      uploaded_file: "上传文件",
      url_param: "URL 参数",
      message_body: "消息体",
    };
    const chain = rs.sink.calleeChain.join(".");
    const pathText = rs.path.map((id) => id.split("#")[1]).join(" -> ");
    const cfg = verdict === "open" ? "构造/默认配置允许 DTD 与外部实体" : "未发现关闭 DTD/外部实体的配置";
    return `${sourceText[source]}XML 经 ${entry.name} 进入，沿 ${pathText} 到达 ${chain}；${cfg}，且解析前无 DOCTYPE/实体净化。`;
  }

  private dedupFindings(findings: Finding[]): Finding[] {
    const seen = new Set<string>();
    const out: Finding[] = [];
    for (const f of findings) {
      const key = findingSortKey(f) + "" + f.source + "" + f.entry;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(f);
    }
    return out.sort((a, b) => {
      const ka = findingSortKey(a);
      const kb = findingSortKey(b);
      return ka < kb ? -1 : ka > kb ? 1 : a.source < b.source ? -1 : a.source > b.source ? 1 : 0;
    });
  }
}
