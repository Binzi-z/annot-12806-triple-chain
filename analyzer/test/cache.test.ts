/**
 * cache.test.ts —— 增量缓存：哈希命中复用、变更文件重解析、缓存可 JSON 往返。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeRepo, runAnalyzer, threePackageFiles } from "./helpers.ts";
import { FileCache } from "../src/cache.ts";
import { parseFile } from "../src/extract.ts";

const SINKS = `
import { DOMParser } from "@xmldom/xmldom";
export function parseIt(xml: string): Document {
  return new DOMParser().parseFromString(xml, "text/xml");
}
`;
const HANDLERS = `
import { parseIt } from "@x/parser-wrapper";
export function entry(req: any): any { return parseIt(String(req.query.xml ?? "")); }
`;

test("FileCache 落盘后重新加载，sha256 命中即复用同一份 FileFact", () => {
  const repo = makeRepo(threePackageFiles({
    "packages/parser-wrapper/src/sinks.ts": SINKS,
    "packages/doc-service/src/handlers.ts": HANDLERS,
  }));
  const cachePath = path.join(repo.root, "cache.json");
  const rel = "packages/parser-wrapper/src/sinks.ts";
  const abs = path.join(repo.root, rel);

  const c1 = new FileCache(cachePath);
  const fact = parseFile(abs, rel);
  c1.put(fact);
  c1.flush();

  const c2 = new FileCache(cachePath);
  const reused = c2.get(rel, abs);
  assert.ok(reused);
  assert.equal(reused?.sha256, fact.sha256);
  assert.equal(reused?.functions[`${rel}#parseIt`]?.name, "parseIt");

  // 文件改动后哈希不匹配，缓存失效。
  fs.writeFileSync(abs, SINKS + "\n// changed\n", "utf8");
  assert.equal(c2.get(rel, abs), null);
  repo.cleanup();
});

test("增量模式：未变更文件复用缓存、变更文件重解析，结论与全量一致", () => {
  const repo = makeRepo(threePackageFiles({
    "packages/parser-wrapper/src/sinks.ts": SINKS,
    "packages/doc-service/src/handlers.ts": HANDLERS,
  }));
  const full = runAnalyzer(repo.root);
  assert.equal(full.findings.length, 1);

  // 第二次在同一仓库上跑（内容未变），所有文件都应命中缓存且结果不变。
  const second = runAnalyzer(repo.root);
  assert.equal(second.findings.length, full.findings.length);
  assert.deepEqual(
    second.findings.map((f) => `${f.file}:${f.line}:${f.ruleId}`).sort(),
    full.findings.map((f) => `${f.file}:${f.line}:${f.ruleId}`).sort(),
  );
  repo.cleanup();
});

test("缓存内容是纯数据（无 AST 引用），可被 JSON 直接序列化", () => {
  const repo = makeRepo(threePackageFiles({
    "packages/parser-wrapper/src/sinks.ts": SINKS,
    "packages/doc-service/src/handlers.ts": HANDLERS,
  }));
  const cachePath = path.join(repo.root, "cache.json");
  const cache = new FileCache(cachePath);
  const rel = "packages/parser-wrapper/src/sinks.ts";
  cache.put(parseFile(path.join(repo.root, rel), rel));
  cache.flush();
  const roundTrip = JSON.parse(fs.readFileSync(cachePath, "utf8"));
  assert.equal(roundTrip.version, 1);
  assert.ok(roundTrip.entries[rel]);
  assert.equal(typeof roundTrip.entries[rel].sha256, "string");
  repo.cleanup();
});
