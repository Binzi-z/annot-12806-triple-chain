/**
 * sarif.ts —— SARIF 2.1.0 输出，确定性是硬约束：
 *  - 不写任何时间戳/进程 id/随机数；
 *  - 规则固定 4 条且按 ruleId 排序；
 *  - results 按 (uri,line,column,ruleId) 排序，artifact 路径正斜杠；
 *  - 所有对象按固定键序构造，配合 JSON.stringify 保证连扫两次逐字节一致。
 */
import type { AnalysisResult, Finding, RuleMeta } from "./types.ts";

const TOOL_NAME = "xxe-ast-analyzer";
const TOOL_VERSION = "1.0.0";
const SCHEMA = "https://json.schemastore.org/sarif-2.1.0.json";

function ruleEntry(rule: RuleMeta): Record<string, unknown> {
  return {
    id: rule.id,
    name: rule.name,
    shortDescription: { text: rule.shortDescription },
    fullDescription: { text: rule.help },
    help: { text: rule.help },
    defaultConfiguration: { level: "error" },
  };
}

function resultEntry(f: Finding): Record<string, unknown> {
  return {
    ruleId: f.ruleId,
    level: "error",
    message: { text: f.message },
    locations: [
      {
        physicalLocation: {
          artifactLocation: { uri: f.file, uriBaseId: "%SRCROOT%" },
          region: { startLine: f.line, startColumn: f.column },
        },
      },
    ],
    partialFingerprints: {
      // 稳定指纹：仅由坐标+规则构成，不含时间/路径前缀，CI 可据此做新增比对。
      stableLocationId: `${f.file}:${f.line}:${f.column}:${f.ruleId}`,
    },
    properties: {
      sink: f.sink,
      source: f.source,
      entry: f.entry,
      entryFile: f.entryFile,
      dataFlowPath: f.path,
    },
  };
}

export function toSarif(result: AnalysisResult): Record<string, unknown> {
  const rules = [...result.rules]
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .map(ruleEntry);
  const results = [...result.findings]
    .sort((a, b) => {
      const ka = `${a.file}|${a.line}|${a.column}|${a.ruleId}`;
      const kb = `${b.file}|${b.line}|${b.column}|${b.ruleId}`;
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    })
    .map(resultEntry);

  return {
    $schema: SCHEMA,
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: TOOL_NAME,
            version: TOOL_VERSION,
            informationUri: "https://example.invalid/xxe-ast-analyzer",
            rules,
          },
        },
        invocations: [
          {
            executionSuccessful: true,
            // 注意：刻意不写 endTimeUtc/startTimeUtc，保证跨运行逐字节一致。
          },
        ],
        results,
        properties: {
          pendingCount: result.stats.pending,
          callEdges: result.stats.callEdges,
          callEdgeCap: result.stats.callEdgeCap,
          callEdgeCapReached: result.stats.callEdgeCapReached,
        },
      },
    ],
  };
}

/** 非 SARIF 的机器可读输出：findings + 未决清单 + 统计，全部排序。 */
export function toJsonDoc(result: AnalysisResult): Record<string, unknown> {
  return {
    tool: TOOL_NAME,
    version: TOOL_VERSION,
    findings: [...result.findings]
      .sort((a, b) => {
        const ka = `${a.file}|${a.line}|${a.column}|${a.ruleId}`;
        const kb = `${b.file}|${b.line}|${b.column}|${b.ruleId}`;
        return ka < kb ? -1 : ka > kb ? 1 : 0;
      })
      .map((f) => ({
        ruleId: f.ruleId,
        sink: f.sink,
        file: f.file,
        line: f.line,
        column: f.column,
        source: f.source,
        entry: f.entry,
        entryFile: f.entryFile,
        path: f.path,
        message: f.message,
      })),
    pending: [...result.pending].sort((a, b) => (a.id < b.id ? -1 : 1)),
    stats: {
      files: result.stats.files,
      lines: result.stats.lines,
      functions: result.stats.functions,
      sinks: result.stats.sinks,
      callEdges: result.stats.callEdges,
      callEdgeCap: result.stats.callEdgeCap,
      callEdgeCapReached: result.stats.callEdgeCapReached,
      findings: result.stats.findings,
      pending: result.stats.pending,
      // durationMs 不写进文件（不确定性来源），只在控制台打印。
    },
  };
}
