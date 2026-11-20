/**
 * helpers.ts —— 在临时目录物化一个最小 monorepo（三包 workspace），
 * 直接驱动内部模块产出 AnalysisResult，供各测试构造边界场景。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { discoverRepo } from "../src/workspace.ts";
import { parseFile } from "../src/extract.ts";
import { Analyzer } from "../src/analyze.ts";
import type { AnalysisResult, FileFact } from "../src/types.ts";

export interface TempRepo {
  root: string;
  cleanup: () => void;
}

function write(abs: string, content: string): void {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

/** files: 仓库相对路径 -> 文件内容。自动补根 package.json 的 workspaces。 */
export function makeRepo(files: Record<string, string>): TempRepo {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xxe-test-"));
  write(
    path.join(root, "package.json"),
    JSON.stringify({ name: "tmp-monorepo", private: true, workspaces: ["packages/*"] }),
  );
  for (const [rel, content] of Object.entries(files)) {
    write(path.join(root, rel), content);
  }
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const PKG_JSON = (name: string, deps: Record<string, string> = {}) =>
  JSON.stringify({ name, private: true, main: "src/index.ts", types: "src/index.ts", dependencies: deps });

export function threePackageFiles(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "packages/common-config/package.json": PKG_JSON("@x/common-config"),
    "packages/common-config/src/index.ts": `
export function assertNoDoctype(xml: string): void {
  if (/<!DOCTYPE/i.test(xml) || /<!ENTITY/i.test(xml)) throw new Error("blocked");
}
export const secureConfig = { allowDtd: false, resolveExternalEntities: false, expandEntities: false };
`,
    "packages/parser-wrapper/package.json": PKG_JSON("@x/parser-wrapper", { "@x/common-config": "workspace:*" }),
    "packages/parser-wrapper/src/index.ts": `export * from "./sinks";`,
    "packages/doc-service/package.json": PKG_JSON("@x/doc-service", {
      "@x/parser-wrapper": "workspace:*",
      "@x/common-config": "workspace:*",
    }),
    ...extra,
  };
}

export function runAnalyzer(root: string): AnalysisResult {
  const layout = discoverRepo(root);
  const facts: FileFact[] = layout.files.map((rel) => parseFile(path.join(root, rel), rel));
  return new Analyzer(layout, facts).run(Date.now());
}
