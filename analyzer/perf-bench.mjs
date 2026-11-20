/**
 * perf-bench.mjs —— 题面性能指标的可复现基准（不依赖任何第三方）。
 *
 * 用法：
 *   node perf-gen.mjs > /tmp/root.txt        # 默认 PERF_N/PERF_F ≈ 20 万行
 *   PERF_ROOT=$(cat /tmp/root.txt) node perf-bench.mjs
 *
 * 校验项：
 *  - 全量（冷缓存）耗时 < 180s（题面 3 分钟）
 *  - 增量（单文件改动，仅重解析该文件）耗时 < 15s，且 parsed=1
 *  - 同批连扫两次 SARIF 逐字节一致（确定性）
 * 结果只打印到控制台，不写任何含时间戳的文件。
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = process.env.PERF_ROOT;
if (!root) throw new Error("请先通过 PERF_ROOT 指定 perf-gen.mjs 生成的仓库");
const cli = path.join(process.cwd(), "src", "cli.ts");
const cache = path.join(root, ".cache.json");
const sarif1 = path.join(root, "r1.sarif");
const sarif2 = path.join(root, "r2.sarif");

function run(args) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [cli, "--root", root, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error("扫描失败: " + r.stderr);
  return { ms: Date.now() - t0, stderr: r.stderr ?? "" };
}

// 1) 冷缓存全量（输出到 SARIF 文件，stdout 留空，避免 spawnSync 缓冲巨型 JSON）
fs.rmSync(cache, { force: true });
const cold = run(["--cache", cache, "--sarif", sarif1]);
const coldStats = cold.stderr.match(/\[xxe\].*/)?.[0] ?? "";
console.log("full(cold)   :", cold.ms, "ms |", coldStats);

// 2) 热缓存全量
const hot = run(["--cache", cache, "--sarif", sarif2]);
console.log("full(cached) :", hot.ms, "ms");
const identical = fs.readFileSync(sarif1).equals(fs.readFileSync(sarif2));
console.log("sarif byte-identical across runs:", identical);

// 3) 单文件改动后的增量
const changed = "packages/doc-service/src/h0.ts";
fs.appendFileSync(path.join(root, changed), `\n// bench-touch ${Date.now()}\n`, "utf8");
const inc = run(["--cache", cache, "--files", changed, "--sarif", path.join(root, "r3.sarif")]);
const m = inc.stderr.match(/parsed=(\d+)\s+reused=(\d+)/);
console.log(
  "incremental  :", inc.ms, "ms | parsed=", m?.[1], "reused=", m?.[2],
  "|", inc.stderr.match(/\[xxe\].*/)?.[0] ?? "",
);

const ok = cold.ms < 180000 && inc.ms < 15000 && m?.[1] === "1" && identical;
console.log(ok ? "PERF: PASS" : "PERF: FAIL");
process.exitCode = ok ? 0 : 1;
