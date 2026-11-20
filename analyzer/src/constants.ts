/**
 * constants.ts —— 规则表、sink/源/净化识别表、调用图上界等全部集中在此。
 * 不依赖任何现成安全规则包，识别表是本分析器自建的语义模型。
 */
import type { RuleMeta, RuleId, SinkKind, SourceLabel } from "./types.ts";

/** 固定 4 条规则，id 与 labels.json 对齐，数组按 id 排序保证输出确定性。 */
export const RULES: RuleMeta[] = [
  {
    id: "XXE-DOM-001",
    name: "xml-dom-parser",
    shortDescription: "DOM 解析器",
    help: "DOM 解析器收到外部 XML，且没有在解析前禁用 DTD/外部实体。",
  },
  {
    id: "XXE-SAX-002",
    name: "xml-sax-parser",
    shortDescription: "SAX 解析器",
    help: "SAX 解析器把外部 XML（或上传流）喂进 write()，解析器未关闭实体解析。",
  },
  {
    id: "XXE-BIND-003",
    name: "xml-binding",
    shortDescription: "XML 绑定反序列化",
    help: "xml2js/fast-xml-parser 绑定反序列化使用默认配置，DOCTYPE 与实体会被展开。",
  },
  {
    id: "XXE-ENTITY-004",
    name: "xml-entity-expansion",
    shortDescription: "自定义实体展开",
    help: "自定义 expandEntities 会按 SYSTEM 声明读文件，调用点未在展开前拒绝 DTD。",
  },
];

export const RULE_ID_BY_SINK: Record<SinkKind, RuleId> = {
  dom: "XXE-DOM-001",
  sax: "XXE-SAX-002",
  binding: "XXE-BIND-003",
  entity: "XXE-ENTITY-004",
};

/** 外部解析库（非 workspace 包）里我们建模为 sink 的成员名。 */
export const EXTERNAL_XML_MODULES = new Set([
  "@xmldom/xmldom",
  "xmldom",
  "sax",
  "xml2js",
  "fast-xml-parser",
  "libxmljs",
  "libxmljs2",
]);

/** 构造解析器的调用名（new DOMParser() / sax.parser(...)）。 */
export const PARSER_CONSTRUCTOR_CHAINS: string[][] = [
  ["DOMParser"],
  ["sax", "parser"],
  ["saxParser"],
];

/** 绑定反序列化 sink：直接函数调用名。 */
export const BINDING_SINK_NAMES = new Set([
  "parseString",
  "parseStringPromise",
  "parseXml",
  "validate",
]);

/** 自定义实体展开 sink 的函数名（语料里的本地函数，也兼容常见命名）。 */
export const ENTITY_SINK_NAMES = new Set([
  "expandEntities",
  "resolveEntity",
  "expandSystemEntities",
]);

/** 配置里只要出现且为 false 即视为关闭 DTD/外部实体的键。 */
export const SECURE_CONFIG_KEYS = [
  "allowDtd",
  "resolveExternalEntities",
  "expandEntities",
  "disableEntities",
  "noent",
] as const;

/** 净化原语：解析前拒绝 DOCTYPE/ENTITY 的函数名（按名识别，调用必须作用于同一污点）。 */
export const SANITIZER_NAME_HINTS = [
  "assertNoDoctype",
  "rejectDoctype",
  "rejectDtd",
  "assertNoEntities",
  "stripDoctype",
  "sanitizeXml",
  "guardDoctype",
];

/** 调用图边数上界（可用环境变量覆盖做上界测试）。 */
export const MAX_CALL_EDGES = Number(process.env.XXE_MAX_EDGES ?? 200000);
/** 跨过程递归深度上界（构造参数经工厂多层间接传入时的截断线）。 */
export const MAX_SUMMARY_DEPTH = Number(process.env.XXE_MAX_DEPTH ?? 32);
/** 单个调用点可解析目标数上界（动态分派无法收敛时截断并标未知）。 */
export const MAX_TARGETS_PER_CALLSITE = Number(process.env.XXE_MAX_TARGETS ?? 64);

/** 三类源的成员访问链模式（归一为小写后做后缀匹配）。 */
export const SOURCE_PATTERNS: Array<{ label: SourceLabel; chain: string[] }> = [
  { label: "uploaded_file", chain: ["req", "file", "path"] },
  { label: "uploaded_file", chain: ["req", "file", "stream"] },
  { label: "uploaded_file", chain: ["request", "file", "path"] },
  { label: "uploaded_file", chain: ["request", "file", "stream"] },
  { label: "url_param", chain: ["req", "query", "xml"] },
  { label: "url_param", chain: ["req", "query", "doc"] },
  { label: "url_param", chain: ["request", "query", "xml"] },
  { label: "url_param", chain: ["request", "query", "doc"] },
  { label: "message_body", chain: ["msg", "body"] },
  { label: "message_body", chain: ["message", "body"] },
  { label: "message_body", chain: ["req", "body"] },
];

/** 读上传文件的源函数：返回值带 uploaded_file 污点。 */
export const UPLOAD_READ_CALLS = new Set([
  "readFileSync",
  "readFile",
  "createReadStream",
]);

export const SOURCE_LABELS: SourceLabel[] = [
  "uploaded_file",
  "url_param",
  "message_body",
];

/** 结果/未决清单的稳定排序键。 */
export function findingSortKey(f: { file: string; line: number; column: number; ruleId: string }): string {
  return `${f.file}\u0000${f.line}\u0000${f.column}\u0000${f.ruleId}`;
}
