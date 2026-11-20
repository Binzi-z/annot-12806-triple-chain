/**
 * cli.test.ts —— CI 阻断语义：--baseline/--max-new，新增即非零退出；无新增退出 0。
 * 通过子进程跑真实 CLI，验证退出码与 SARIF/JSON 产物。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { makeRepo, threePackageFiles } from "./helpers.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.resolve(here, "..", "src", "cli.ts");

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

function run(args: string[], env: NodeJS.ProcessEnv = {}) {
  try {
    execFileSync(process.execPath, [cli, ...args], {
      env: { ...process.env, ...env },
      encoding: "utf8",
      stdio: "pipe",
    });
    return 0;
  } catch (e: any) {
    return e.status as number;
  }
}

test("无基线时全量报漏洞；以本次结果为基线后重跑，新增=0 退出码 0", () => {
  const repo = makeRepo(threePackageFiles({
    "packages/parser-wrapper/src/sinks.ts": SINKS,
    "packages/doc-service/src/handlers.ts": HANDLERS,
  }));
  const sarif = path.join(repo.root, "cur.sarif");
  // 先生成一份基线。
  assert.equal(run(["--root", repo.root, "--sarif", sarif, "--no-cache"]), 0);
  // 用同一基线比对：没有新增，--max-new 0 应通过。
  assert.equal(
    run(["--root", repo.root, "--sarif", path.join(repo.root, "x.sarif"), "--no-cache",
      "--baseline", sarif, "--max-new", "0"]),
    0,
  );
  repo.cleanup();
});

test("基线为空（无历史 finding）时本次新增 > max-new，退出码 1 阻断 CI", () => {
  const repo = makeRepo(threePackageFiles({
    "packages/parser-wrapper/src/sinks.ts": SINKS,
    "packages/doc-service/src/handlers.ts": HANDLERS,
  }));
  const emptyBaseline = path.join(repo.root, "empty.sarif");
  fs.writeFileSync(emptyBaseline, JSON.stringify({
    version: "2.1.0", runs: [{ tool: { driver: { name: "x", rules: [] } }, results: [] }],
  }), "utf8");
  const code = run([
    "--root", repo.root, "--no-cache",
    "--sarif", path.join(repo.root, "cur.sarif"),
    "--baseline", emptyBaseline, "--max-new", "0",
  ]);
  assert.equal(code, 1, "存在新增 XXE 时必须以退出码 1 阻断 CI");
  repo.cleanup();
});

test("SARIF 与 JSON 都能被生成且 SARIF 不含时间戳", () => {
  const repo = makeRepo(threePackageFiles({
    "packages/parser-wrapper/src/sinks.ts": SINKS,
    "packages/doc-service/src/handlers.ts": HANDLERS,
  }));
  const sarif = path.join(repo.root, "o.sarif");
  const json = path.join(repo.root, "o.json");
  assert.equal(run(["--root", repo.root, "--sarif", sarif, "--json", json, "--no-cache"]), 0);
  const text = fs.readFileSync(sarif, "utf8");
  assert.ok(!/TimeUtc|timestamp|durationMs/.test(text));
  const doc = JSON.parse(fs.readFileSync(json, "utf8"));
  assert.ok(Array.isArray(doc.findings) && doc.findings.length === 1);
  assert.ok(Array.isArray(doc.pending));
  repo.cleanup();
});
