#!/usr/bin/env node
/**
 * cli.ts —— 分析器入口。
 *
 * 用法：
 *   node src/cli.ts --root <repo> [--sarif out.sarif] [--json out.json]
 *                  [--cache .xxe-cache.json] [--files a.ts,b.ts] [--no-cache]
 *                  [--baseline findings.json] [--max-new N]
 *
 * CI 阻断：--baseline 给历史 SARIF/JSON，本次新增（坐标不在基线里）超过 --max-new
 * （默认 0）即退出码 1；SARIF 本身不含时间戳，可直接作为构建产物归档。
 */
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { discoverRepo } from "./workspace.ts";
import { parseFile } from "./extract.ts";
import { Analyzer } from "./analyze.ts";
import { toJsonDoc, toSarif } from "./sarif.ts";
import { FileCache } from "./cache.ts";
import type { AnalysisResult, FileFact } from "./types.ts";

interface CliOptions {
  root: string;
  sarif: string | null;
  json: string | null;
  cache: string | null;
  useCache: boolean;
  files: string[];
  baseline: string | null;
  maxNew: number;
}

function parseCli(): CliOptions {
  const { values } = parseArgs({
    options: {
      root: { type: "string", default: process.cwd() },
      sarif: { type: "string" },
      json: { type: "string" },
      cache: { type: "string" },
      "no-cache": { type: "boolean", default: false },
      files: { type: "string" },
      baseline: { type: "string" },
      "max-new": { type: "string", default: "0" },
    },
  });
  const root = path.resolve(String(values.root));
  return {
    root,
    sarif: values.sarif ? path.resolve(String(values.sarif)) : null,
    json: values.json ? path.resolve(String(values.json)) : null,
    cache: values.cache ? path.resolve(String(values.cache)) : path.join(root, ".xxe-cache.json"),
    useCache: !values["no-cache"],
    files: values.files ? String(values.files).split(",").map((s) => s.trim()).filter(Boolean) : [],
    baseline: values.baseline ? path.resolve(String(values.baseline)) : null,
    maxNew: Number(values["max-new"]),
  };
}

function extractAll(opts: CliOptions): { facts: FileFact[]; reused: number; parsed: number } {
  const layout = discoverRepo(opts.root);
  const cache = opts.useCache ? new FileCache(opts.cache!) : null;
  const changedFilter = opts.files.length ? new Set(normalizeList(opts.root, opts.files)) : null;
  const facts: FileFact[] = [];
  let reused = 0;
  let parsed = 0;

  for (const rel of layout.files) {
    if (changedFilter && !changedFilter.has(rel)) {
      const cached = cache?.get(rel, path.join(opts.root, rel));
      if (cached) {
        facts.push(cached);
        continue;
      }
    }
    const abs = path.join(opts.root, rel);
    const cached = cache?.get(rel, abs);
    if (cached) {
      facts.push(cached);
      reused++;
      continue;
    }
    const fact = parseFile(abs, rel);
    cache?.put(fact);
    facts.push(fact);
    parsed++;
  }
  if (cache) cache.flush();
  return { facts, reused, parsed };
}

function normalizeList(root: string, list: string[]): string[] {
  return list.map((p) =>
    path
      .resolve(root, p)
      .replace(/\\/g, "/")
      .replace(root.replace(/\\/g, "/") + "/", ""),
  );
}

function loadBaselineCoordinates(file: string): Set<string> {
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const coords = new Set<string>();
  if (Array.isArray(raw.findings)) {
    for (const f of raw.findings) coords.add(`${f.file}|${f.line}|${f.ruleId ?? ""}`);
  }
  for (const run of raw.runs ?? []) {
    for (const res of run.results ?? []) {
      const loc = res.locations?.[0]?.physicalLocation;
      if (!loc) continue;
      coords.add(
        `${loc.artifactLocation.uri}|${loc.region.startLine}|${res.ruleId ?? ""}`,
      );
    }
  }
  return coords;
}

function countNew(result: AnalysisResult, baseline: Set<string>): number {
  let n = 0;
  for (const f of result.findings) {
    const coord = `${f.file}|${f.line}|${f.ruleId}`;
    if (!baseline.has(coord)) n++;
  }
  return n;
}

function writeDeterministic(file: string, doc: unknown): void {
  // indent=2、ensure_ascii 等价、LF 行尾、末尾恰好一个换行——与 baseline 口径一致。
  const text = JSON.stringify(doc, null, 2) + "\n";
  fs.writeFileSync(file, text, { encoding: "utf8" });
}

function main(): number {
  const opts = parseCli();
  if (!fs.existsSync(opts.root)) {
    process.stderr.write(`root 不存在: ${opts.root}\n`);
    return 2;
  }
  const startedAt = Date.now();
  const layout = discoverRepo(opts.root);
  const { facts, reused, parsed } = extractAll(opts);
  const result = new Analyzer(layout, facts).run(startedAt);

  if (opts.sarif) writeDeterministic(opts.sarif, toSarif(result));
  if (opts.json) writeDeterministic(opts.json, toJsonDoc(result));
  if (!opts.sarif && !opts.json) {
    process.stdout.write(JSON.stringify(toJsonDoc(result), null, 2) + "\n");
  }

  process.stderr.write(
    `[xxe] files=${result.stats.files} lines=${result.stats.lines} ` +
      `functions=${result.stats.functions} sinks=${result.stats.sinks} ` +
      `edges=${result.stats.callEdges}/${result.stats.callEdgeCap} ` +
      `findings=${result.stats.findings} pending=${result.stats.pending} ` +
      `parsed=${parsed} reused=${reused} durationMs=${result.stats.durationMs}\n`,
  );

  if (opts.baseline) {
    const baselineCoords = loadBaselineCoordinates(opts.baseline);
    const newly = countNew(result, baselineCoords);
    process.stderr.write(`[xxe] new-vs-baseline=${newly} max-new=${opts.maxNew}\n`);
    if (newly > opts.maxNew) return 1;
  }
  return 0;
}

process.exit(main());
