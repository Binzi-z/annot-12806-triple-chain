/**
 * types.ts —— 全分析器共享的数据结构。
 *
 * 设计原则：这里的任何结构都可以被 JSON 序列化（增量缓存复用），
 * 不持有 TypeScript 的 AST 节点引用——AST 只在「逐文件提取」阶段存在，
 * 提取完就丢弃，跨文件分析只看 FileFact。
 */

export type RuleId =
  | "XXE-DOM-001"
  | "XXE-SAX-002"
  | "XXE-BIND-003"
  | "XXE-ENTITY-004";

export type SinkKind = "dom" | "sax" | "binding" | "entity";

/** 三类外部源，名字与 labels.json 的 source 对齐。 */
export type SourceLabel = "uploaded_file" | "url_param" | "message_body";

/** 污点 token：要么是入口源标签，要么是某个函数参数符号 p<index>。 */
export type TaintToken = SourceLabel | `p${number}`;

/** 配置项在静态分析里的三态：确定安全 / 确定不安全（打开）/ 追不出来。 */
export type ConfigVerdict = "safe" | "open" | "unknown";

/** 可序列化的「值表达式」，用于把构造参数/选项对象带到全局阶段做常量折叠。 */
export type ValueExpr =
  | { t: "lit"; value: string | number | boolean | null }
  | { t: "ident"; name: string }
  | { t: "member"; object: ValueExpr; property: string }
  | { t: "object"; props: Array<{ key: string; value: ValueExpr | undefined }> }
  | { t: "array"; items: ValueExpr[] }
  | { t: "call"; calleeChain: string[]; args: ValueExpr[] }
  | { t: "spread"; arg: ValueExpr }
  | { t: "binary"; op: string; left: ValueExpr; right: ValueExpr }
  | { t: "unary"; op: string; operand: ValueExpr }
  | { t: "conditional"; test: ValueExpr; whenTrue: ValueExpr; whenFalse: ValueExpr }
  | { t: "unknown"; reason: string };

export interface OptionFact {
  /** 选项对象在调用里的参数下标。 */
  argIndex: number;
  value: ValueExpr;
}

export interface SinkFact {
  kind: SinkKind;
  /** sink 在源文件里的 1 起始行/列。 */
  line: number;
  column: number;
  /** 触发 sink 的调用链，如 ["DOMParser","parseFromString"] / ["parseString"] / ["parser","write"]。 */
  calleeChain: string[];
  /** 承载外部 XML 的实参下标。 */
  xmlArgIndex: number;
  /** 该实参在本函数作用域里携带的污点 token 集合（提取期按符号求值）。 */
  xmlTaint: TaintToken[];
  /** 构造参数/选项（如 parseString 第二参、DOMParser 构造参数）。 */
  options: OptionFact[];
  /** sink 所在函数体内、sink 之前是否存在针对同一 XML 实参的 DOCTYPE/实体净化调用。 */
  guardedBefore: boolean;
  /** 函数内文本（便于全局阶段复核净化原语名）。 */
  guardNames: string[];
}

export interface CallFact {
  line: number;
  column: number;
  /** 解析前的调用链（最后一项是被调名）。 */
  calleeChain: string[];
  /** 每个实参携带的污点 token。 */
  argTaint: TaintToken[][];
  /** 每个实参的可序列化值表达式（工厂间接传参时用于形参替换/常量折叠）。 */
  argExprs: ValueExpr[];
  /** 解析后的目标函数 id（全局阶段填充，提取期为空串表示未解析）。 */
  resolvedId: string;
  /** 无法静态确定接收者/被调名时为 true（计入未决清单）。 */
  unresolved: boolean;
  /** 是否为事件注册 obj.on("event", cb)，回调单独登记。 */
  isEventRegistration: boolean;
  eventName: string | null;
  /** 回调函数若是内联函数，给一个本文件内唯一的合成 id；否则为 null。 */
  inlineCallbackId: string | null;
}

export interface EventRegFact {
  line: number;
  eventName: string;
  receiverTaint: TaintToken[];
  inlineCallbackId: string | null;
  /** 回调体内出现的 sink 调用链（如 ["parser","write"]）及其实参污点。 */
  callbackSinkChains: Array<{ chain: string[]; argTaint: TaintToken[][]; line: number }>;
}

export interface ReturnFact {
  line: number;
  taint: TaintToken[];
}

export interface FunctionFact {
  id: string;
  name: string;
  file: string;
  line: number;
  paramNames: string[];
  sinks: SinkFact[];
  calls: CallFact[];
  events: EventRegFact[];
  returns: ReturnFact[];
  /** 提取期识别到的「净化原语」调用名（assertNoDoctype 等）。 */
  sanitizerCalls: Array<{ line: number; name: string; argTaint: TaintToken[][] }>;
  /** 函数体（含嵌套内联函数）里出现的、疑似解析器构造的调用。 */
  parserConstructs: Array<{ line: number; chain: string[]; args: ValueExpr[] }>;
  /** 函数体内带初值的局部常量/变量（配置折叠用），名 -> 初值表达式。 */
  localValues: Record<string, ValueExpr>;
}

export interface ImportSpec {
  /** import 进来的本地名（default / namespace / named 都归一到本地名）。 */
  localName: string;
  /** named import 的导出名；default 为 "default"；namespace 为 "*"。 */
  importedName: string;
  moduleSpecifier: string;
  isNamespace: boolean;
}

export interface ExportSpec {
  /** 导出名（export ... from 时为 re-export）。 */
  exportName: string;
  localName: string;
  moduleSpecifier: string | null;
}

export interface FileFact {
  /** 仓库相对路径，正斜杠。 */
  path: string;
  /** 源文件内容的 sha256，增量缓存按它判断是否需要重新解析。 */
  sha256: string;
  lineCount: number;
  imports: ImportSpec[];
  exports: ExportSpec[];
  /** 顶层函数声明/函数表达式 id -> 函数事实。 */
  functions: Record<string, FunctionFact>;
  /** 顶层常量/变量的可序列化初值（用于跨文件配置常量折叠）。 */
  topLevelValues: Record<string, ValueExpr>;
  /** 语法解析诊断（不致命，登记进未决清单）。 */
  syntaxErrors: Array<{ line: number; message: string }>;
}

export type PendingKind =
  | "unresolved-callee"
  | "unknown-config"
  | "unresolved-import"
  | "syntax-error"
  | "edge-cap"
  | "taint-unknown";

export interface PendingEntry {
  id: string;
  kind: PendingKind;
  file: string;
  line: number;
  symbol: string;
  detail: string;
}

export interface Finding {
  ruleId: RuleId;
  sink: SinkKind;
  file: string;
  line: number;
  column: number;
  source: SourceLabel;
  entry: string;
  entryFile: string;
  /** 从入口到 sink 的函数链（函数 id 序列），用于消息与可解释性。 */
  path: string[];
  message: string;
}

export interface AnalysisStats {
  files: number;
  lines: number;
  functions: number;
  sinks: number;
  /** 调用图实际边数与给定上界。 */
  callEdges: number;
  callEdgeCap: number;
  callEdgeCapReached: boolean;
  findings: number;
  pending: number;
  /** 耗时只进控制台/统计，不进 SARIF，保证确定性。 */
  durationMs: number;
}

export interface AnalysisResult {
  findings: Finding[];
  pending: PendingEntry[];
  stats: AnalysisStats;
  /** 规则表（固定 4 条，按 id 排序），SARIF 与 JSON 共用。 */
  rules: RuleMeta[];
}

export interface RuleMeta {
  id: RuleId;
  name: string;
  shortDescription: string;
  help: string;
}
