/**
 * config.test.ts —— 配置项与解析器构造参数的静态追踪专项。
 * 每个夹具都是一个最小三包 monorepo，验证 config.ts 的三层追踪：
 * 字面量层 / 常量折叠层（跨 import）/ 工厂形参替换层，以及「追不出标未知进未决」。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeRepo, runAnalyzer, threePackageFiles, type TempRepo } from "./helpers.ts";

function setup(extra: Record<string, string>): TempRepo {
  return makeRepo(threePackageFiles(extra));
}

test("内联构造参数 allowDtd:false 直接判安全，抑制 DOM finding", () => {
  const repo = setup({
    "packages/parser-wrapper/src/sinks.ts": `
import { DOMParser } from "@xmldom/xmldom";
export function parseIt(xml: string): Document {
  return new DOMParser({ allowDtd: false, resolveExternalEntities: false }).parseFromString(xml, "text/xml");
}
`,
    "packages/doc-service/src/handlers.ts": `
import { parseIt } from "@x/parser-wrapper";
export function entry(req: any): any { return parseIt(String(req.query.xml ?? "")); }
`,
  });
  const r = runAnalyzer(repo.root);
  assert.equal(r.findings.length, 0);
  repo.cleanup();
});

test("跨 import 折叠 secureConfig 常量（含安全键 false）判安全", () => {
  const repo = setup({
    "packages/parser-wrapper/src/sinks.ts": `
import { DOMParser } from "@xmldom/xmldom";
import { secureConfig } from "@x/common-config";
export function parseIt(xml: string): Document {
  return new DOMParser(secureConfig).parseFromString(xml, "text/xml");
}
`,
    "packages/doc-service/src/handlers.ts": `
import { parseIt } from "@x/parser-wrapper";
export function entry(req: any): any { return parseIt(String(req.query.xml ?? "")); }
`,
  });
  const r = runAnalyzer(repo.root);
  assert.equal(r.findings.length, 0, "应通过跨文件常量折叠识别 secureConfig 为安全");
  repo.cleanup();
});

test("loadConfig(overrides) 工厂合并出 false 键判安全", () => {
  const repo = setup({
    "packages/common-config/src/index.ts": `
export const defaultConfig = { allowDtd: true, resolveExternalEntities: true };
export function loadConfig(overrides: any): any { return { ...defaultConfig, ...overrides }; }
export function assertNoDoctype(xml: string): void { if (/<!DOCTYPE/i.test(xml)) throw new Error("x"); }
`,
    "packages/parser-wrapper/src/sinks.ts": `
import { DOMParser } from "@xmldom/xmldom";
import { loadConfig } from "@x/common-config";
export function parseIt(xml: string): Document {
  const cfg = loadConfig({ allowDtd: false, resolveExternalEntities: false });
  return new DOMParser(cfg).parseFromString(xml, "text/xml");
}
`,
    "packages/doc-service/src/handlers.ts": `
import { parseIt } from "@x/parser-wrapper";
export function entry(req: any): any { return parseIt(String(req.query.xml ?? "")); }
`,
  });
  const r = runAnalyzer(repo.root);
  assert.equal(r.findings.length, 0, "loadConfig 工厂合并应折叠出 allowDtd:false");
  repo.cleanup();
});

test("构造参数经工厂函数间接传入且无法确定时标 unknown 并进未决清单", () => {
  const repo = setup({
    "packages/parser-wrapper/src/sinks.ts": `
import { DOMParser } from "@xmldom/xmldom";
// options 来自函数形参（外部不可见），静态分析无法确定其安全键取值。
export function parseIt(xml: string, options: any): Document {
  return new DOMParser(options).parseFromString(xml, "text/xml");
}
`,
    "packages/doc-service/src/handlers.ts": `
import { parseIt } from "@x/parser-wrapper";
export function entry(req: any, opts: any): any { return parseIt(String(req.query.xml ?? ""), opts); }
`,
  });
  const r = runAnalyzer(repo.root);
  const unknown = r.pending.filter((p) => p.kind === "unknown-config");
  assert.ok(unknown.length >= 1, "追不出的间接构造参数必须进未决清单");
  assert.equal(r.findings.length, 0, "不确定时不武断报漏洞");
  repo.cleanup();
});

test("解析前 assertNoDoctype 净化（跨模块同名原语）抑制 finding", () => {
  const repo = setup({
    "packages/parser-wrapper/src/sinks.ts": `
import { DOMParser } from "@xmldom/xmldom";
import { assertNoDoctype } from "@x/common-config";
export function parseIt(xml: string): Document {
  assertNoDoctype(xml);
  return new DOMParser().parseFromString(xml, "text/xml");
}
`,
    "packages/doc-service/src/handlers.ts": `
import { parseIt } from "@x/parser-wrapper";
export function entry(req: any): any { return parseIt(String(req.query.xml ?? "")); }
`,
  });
  const r = runAnalyzer(repo.root);
  assert.equal(r.findings.length, 0);
  repo.cleanup();
});

test("无任何配置的默认 DOMParser 仍报漏洞（默认即允许外部实体）", () => {
  const repo = setup({
    "packages/parser-wrapper/src/sinks.ts": `
import { DOMParser } from "@xmldom/xmldom";
export function parseIt(xml: string): Document {
  return new DOMParser().parseFromString(xml, "text/xml");
}
`,
    "packages/doc-service/src/handlers.ts": `
import { parseIt } from "@x/parser-wrapper";
export function entry(req: any): any { return parseIt(String(req.query.xml ?? "")); }
`,
  });
  const r = runAnalyzer(repo.root);
  assert.equal(r.findings.length, 1);
  assert.equal(r.pending.length, 0, "默认配置是确定的 open，不应进未决");
  repo.cleanup();
});

test("SAX 流式 data 回调里的 parser.write 被识别且默认配置报漏洞", () => {
  const repo = setup({
    "packages/parser-wrapper/src/sinks.ts": `
import sax from "sax";
import type { Readable } from "node:stream";
export function parseStream(stream: Readable, done: (t: string[]) => void): void {
  const parser = sax.parser(true);
  stream.on("data", (chunk: Buffer) => parser.write(chunk.toString()));
  stream.on("end", () => done([]));
}
`,
    "packages/doc-service/src/handlers.ts": `
import { parseStream } from "@x/parser-wrapper";
export function entry(req: any, done: any): void { parseStream(req.file.stream, done); }
`,
  });
  const r = runAnalyzer(repo.root);
  const saxFindings = r.findings.filter((f) => f.sink === "sax");
  assert.equal(saxFindings.length, 1);
  assert.equal(saxFindings[0].source, "uploaded_file");
  repo.cleanup();
});

test("尾部 done 回调不被误判为未知配置（绑定 parseString 场景）", () => {
  const repo = setup({
    "packages/parser-wrapper/src/sinks.ts": `
import { parseString } from "xml2js";
export function parseIt(xml: string, done: (e: Error | null, d: any) => void): void {
  parseString(xml, { explicitArray: false }, done);
}
`,
    "packages/doc-service/src/handlers.ts": `
import { parseIt } from "@x/parser-wrapper";
export function entry(req: any): any { parseIt(String(req.query.xml ?? ""), () => {}); }
`,
  });
  const r = runAnalyzer(repo.root);
  assert.equal(r.findings.length, 1, "普通选项 + done 回调应按默认 open 报 1 条");
  assert.equal(r.pending.filter((p) => p.kind === "unknown-config").length, 0);
  repo.cleanup();
});
