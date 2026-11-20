/**
 * corpus.test.ts —— 对随仓库提供的 50 条标注语料做验收。
 * 覆盖题面硬指标：召回 ≥85%、误报 ≤15%、四类 sink/三类源、22 个 decoy 全抑制、
 * SARIF 连扫两次逐字节一致、输出不含时间戳。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { discoverRepo } from "../src/workspace.ts";
import { parseFile } from "../src/extract.ts";
import { Analyzer } from "../src/analyze.ts";
import { toSarif } from "../src/sarif.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const analyzerDir = path.resolve(here, "..");
const repoRoot = path.resolve(analyzerDir, "..");

interface Label {
  id: string;
  sink: string;
  file: string;
  line: number;
  source: string;
}

function analyzeRealRepo() {
  const layout = discoverRepo(repoRoot);
  const facts = layout.files.map((rel) => parseFile(path.join(repoRoot, rel), rel));
  return new Analyzer(layout, facts).run(0);
}

test("50 条标注样本：召回 ≥85%、误报率 ≤15%", () => {
  const labels = JSON.parse(fs.readFileSync(path.join(repoRoot, "labels.json"), "utf8"))
    .vulns as Label[];
  const truth = new Set(labels.map((v) => `${v.file}|${v.line}`));
  const result = analyzeRealRepo();
  const got = new Set(result.findings.map((f) => `${f.file}|${f.line}`));
  const tp = [...truth].filter((k) => got.has(k)).length;
  const fp = [...got].filter((k) => !truth.has(k)).length;
  const recall = tp / truth.size;
  const fpRate = got.size === 0 ? 0 : fp / got.size;
  assert.ok(recall >= 0.85, `召回 ${recall} 低于 85%`);
  assert.ok(fpRate <= 0.15, `误报率 ${fpRate} 高于 15%`);
  // 语料目标是全召回零误报，这里同时钉死强口径，防止回归。
  assert.equal(tp, 50);
  assert.equal(fp, 0);
});

test("四类 sink 与三类源都被覆盖", () => {
  const result = analyzeRealRepo();
  const sinks = new Set(result.findings.map((f) => f.sink));
  for (const k of ["dom", "sax", "binding", "entity"]) assert.ok(sinks.has(k as any), `缺 sink ${k}`);
  const sources = new Set(result.findings.map((f) => f.source));
  for (const k of ["uploaded_file", "url_param", "message_body"])
    assert.ok(sources.has(k as any), `缺 source ${k}`);
});

test("secure.ts 的 22 个净化 decoy 全部被抑制", () => {
  const result = analyzeRealRepo();
  const inSecure = result.findings.filter((f) => f.file.endsWith("secure.ts"));
  assert.equal(inSecure.length, 0);
});

test("SARIF 连扫两次逐字节一致，且不含任何时间戳字段", () => {
  const r1 = analyzeRealRepo();
  const r2 = analyzeRealRepo();
  const s1 = JSON.stringify(toSarif(r1), null, 2) + "\n";
  const s2 = JSON.stringify(toSarif(r2), null, 2) + "\n";
  assert.equal(s1, s2);
  for (const banned of ["TimeUtc", "timestamp", "durationMs", "startTime", "endTime"])
    assert.ok(!s1.includes(banned), `SARIF 含不确定字段 ${banned}`);
  // 规则固定 4 条且按 id 排序。
  const sarif = JSON.parse(s1);
  const rules = sarif.runs[0].tool.driver.rules.map((r: any) => r.id);
  assert.deepEqual(rules, ["XXE-BIND-003", "XXE-DOM-001", "XXE-ENTITY-004", "XXE-SAX-002"].sort());
});

test("CLI 子进程两次输出 SARIF 逐字节相同", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xxe-cli-"));
  const a = path.join(dir, "a.sarif");
  const b = path.join(dir, "b.sarif");
  const cli = path.join(analyzerDir, "src", "cli.ts");
  for (const out of [a, b])
    execFileSync(process.execPath, [cli, "--root", repoRoot, "--sarif", out, "--no-cache"], {
      cwd: analyzerDir,
    });
  assert.equal(fs.readFileSync(a).toString(), fs.readFileSync(b).toString());
  fs.rmSync(dir, { recursive: true, force: true });
});
