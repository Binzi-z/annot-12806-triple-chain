/**
 * cache.ts —— 增量分析缓存。
 *
 * 缓存单元是「单文件提取产物 FileFact + sha256」，不含 AST 引用，可整体 JSON 落盘。
 * 全量跑时写缓存；增量跑（--files 或 --changed）只重解析哈希变化/新增的文件，
 * 其余直接复用缓存里的 FileFact，再照常跑全局分析——全局阶段本来就是纯内存、
 * 亚秒级，所以增量耗时主要花在少量变更文件的语法解析上。
 */
import fs from "node:fs";
import path from "node:path";
import type { FileFact } from "./types.ts";
import { hashFile } from "./workspace.ts";

interface CacheDoc {
  version: 1;
  entries: Record<string, FileFact>;
}

export class FileCache {
  private entries: Record<string, FileFact>;
  private cachePath: string;

  constructor(cachePath: string) {
    this.cachePath = cachePath;
    this.entries = this.load();
  }

  private load(): Record<string, FileFact> {
    try {
      const raw = fs.readFileSync(this.cachePath, "utf8");
      const doc = JSON.parse(raw) as CacheDoc;
      if (doc.version === 1 && doc.entries) return doc.entries;
    } catch {
      /* 缓存缺失/损坏：冷启动，全量解析。 */
    }
    return {};
  }

  /** 命中且 sha256 一致才复用；否则返回 null 触发重新解析。 */
  get(relPath: string, absPath: string): FileFact | null {
    const cached = this.entries[relPath];
    if (!cached) return null;
    if (cached.sha256 !== hashFile(absPath)) return null;
    return cached;
  }

  put(fact: FileFact): void {
    this.entries[fact.path] = fact;
  }

  /** 全量跑后持久化；写入用临时文件 + rename，避免半截缓存。 */
  flush(): void {
    const doc: CacheDoc = { version: 1, entries: this.entries };
    fs.mkdirSync(path.dirname(this.cachePath), { recursive: true });
    const tmp = this.cachePath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(doc), "utf8");
    fs.renameSync(tmp, this.cachePath);
  }

  size(): number {
    return Object.keys(this.entries).length;
  }
}
