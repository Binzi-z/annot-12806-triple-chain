/**
 * callgraph.test.ts —— 调用图边数上界、跨过程链、递归终止。
 * 边数上界经环境变量在模块加载时读取，故上界用例用独立子进程隔离。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { makeRepo, runAnalyzer, threePackageFiles } from "./helpers.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.resolve(here, "..", "src", "cli.ts");

test("边数上界：XXE_MAX_EDGES=0 触顶后登记 edge-cap 未决，且边数不超过上界", () => {
  const repo = makeRepo(
    threePackageFiles({
      "packages/parser-wrapper/src/sinks.ts": `
import { DOMParser } from "@xmldom/xmldom";
export function a(xml: string): Document { return new DOMParser().parseFromString(xml, "text/xml"); }
export function b(xml: string): Document { return a(xml); }
export function c(xml: string): Document { return b(xml); }
`,
      "packages/doc-service/src/handlers.ts": `
import { c } from "@x/parser-wrapper";
export function entry(req: any): any { return c(String(req.query.xml ?? "")); }
`,
    }),
  );
  const out = path.join(repo.root, "out.json");
  const stdout = execFileSync(
    process.execPath,
    [cli, "--root", repo.root, "--json", out, "--no-cache"],
    { env: { ...process.env, XXE_MAX_EDGES: "0" }, encoding: "utf8" },
  );
  const doc = JSON.parse(fs.readFileSync(out, "utf8"));
  assert.equal(doc.stats.callEdges, 0);
  assert.equal(doc.stats.callEdgeCapReached, true);
  assert.ok(doc.pending.some((p: any) => p.kind === "edge-cap"));
  repo.cleanup();
});

test("正常上界下跨过程链 entry->top->mid->leaf 把源污点送到 sink", () => {
  const repo = makeRepo(
    threePackageFiles({
      "packages/parser-wrapper/src/sinks.ts": `
import { DOMParser } from "@xmldom/xmldom";
export function leaf(xml: string): Document { return new DOMParser().parseFromString(xml, "text/xml"); }
export function mid(xml: string): Document { return leaf(xml); }
export function top(xml: string): Document { return mid(xml); }
`,
      "packages/doc-service/src/handlers.ts": `
import { top } from "@x/parser-wrapper";
export function entry(req: any): any { return top(String(req.query.xml ?? "")); }
`,
    }),
  );
  const r = runAnalyzer(repo.root);
  assert.equal(r.findings.length, 1);
  assert.deepEqual(r.findings[0].path, ["entry", "top", "mid", "leaf"]);
  assert.equal(r.stats.callEdgeCapReached, false);
  repo.cleanup();
});

test("递归函数不会让跨过程 DFS 发散（环终止且仍报漏洞）", () => {
  const repo = makeRepo(
    threePackageFiles({
      "packages/parser-wrapper/src/sinks.ts": `
import { DOMParser } from "@xmldom/xmldom";
export function rec(xml: string, n: number): Document {
  if (n <= 0) return new DOMParser().parseFromString(xml, "text/xml");
  return rec(xml, n - 1);
}
`,
      "packages/doc-service/src/handlers.ts": `
import { rec } from "@x/parser-wrapper";
export function entry(req: any): any { return rec(String(req.query.xml ?? ""), 3); }
`,
    }),
  );
  const r = runAnalyzer(repo.root);
  assert.equal(r.findings.length, 1);
  assert.ok(r.stats.callEdges >= 1);
  repo.cleanup();
});

test("无法解析的项目内自由函数调用计入未决，外部库调用不计", () => {
  const repo = makeRepo(
    threePackageFiles({
      "packages/parser-wrapper/src/sinks.ts": `
import { DOMParser } from "@xmldom/xmldom";
export function parseIt(xml: string): Document {
  const transformed = missingProjectHelper(xml); // 项目内但无定义/导入
  return new DOMParser().parseFromString(transformed, "text/xml");
}
`,
      "packages/doc-service/src/handlers.ts": `
import { parseIt } from "@x/parser-wrapper";
export function entry(req: any): any { return parseIt(String(req.query.xml ?? "")); }
`,
    }),
  );
  const r = runAnalyzer(repo.root);
  assert.ok(r.pending.some((p) => p.kind === "unresolved-callee" && p.symbol === "missingProjectHelper"));
  // sax/xml2js 等外部环境调用不应产生未决。
  assert.ok(!r.pending.some((p) => p.symbol === "String"));
  repo.cleanup();
});

void os; // 保留 os 引用以便扩展临时目录用例
