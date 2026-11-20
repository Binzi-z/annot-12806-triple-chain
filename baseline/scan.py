#!/usr/bin/env python3
"""baseline：正则版 XXE 扫描器（改进前起点）。

不做 AST、不做符号表、不看配置：一行里出现 XML 解析/实体展开/SAX write 就报。
因此 packages/parser-wrapper/src/secure.ts 里先 assertNoDoctype 再解析的写法
也会中招，这正是本题要改进的误报来源。
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "packages")
EXTS = (".js", ".ts")

SINK_RE = re.compile(
    r"(?P<m>parseFromString|parseString|parseXml|expandEntities|resolveEntity"
    r"|parser\.write|xmlParser\.parse)\s*\("
)

RULES = {
    "parseFromString": ("XXE-DOM-001", "XML-DOM-PARSER", "DOM 解析器处理了未禁用 DTD 的 XML"),
    "parser.write": ("XXE-SAX-002", "XML-SAX-PARSER", "SAX 解析器写入了来自外部的 XML"),
    "parseString": ("XXE-BIND-003", "XML-BINDING", "XML 绑定反序列化使用了默认配置"),
    "parseXml": ("XXE-BIND-003", "XML-BINDING", "XML 绑定反序列化使用了默认配置"),
    "xmlParser.parse": ("XXE-BIND-003", "XML-BINDING", "XML 绑定反序列化使用了默认配置"),
    "expandEntities": ("XXE-ENTITY-004", "XML-ENTITY-EXPANSION", "自定义实体展开读取了外部 SYSTEM 实体"),
    "resolveEntity": ("XXE-ENTITY-004", "XML-ENTITY-EXPANSION", "自定义实体解析回调未限制外部实体"),
}


def rule_for(match: str) -> str:
    return RULES.get(match, ("XXE-UNKNOWN-999", "XXE", "XML 解析候选点"))[0]


def scan() -> list[dict]:
    findings: list[dict] = []
    for dirpath, dirnames, names in os.walk(SRC):
        dirnames.sort()
        for name in sorted(names):
            if not name.endswith(EXTS):
                continue
            path = os.path.join(dirpath, name)
            rel = os.path.relpath(path, ROOT).replace(os.sep, "/")
            with open(path, encoding="utf-8") as fh:
                for no, line in enumerate(fh, 1):
                    m = SINK_RE.search(line)
                    if m:
                        findings.append({
                            "file": rel,
                            "line": no,
                            "ruleId": rule_for(m.group("m")),
                            "message": line.strip()[:200],
                        })
    findings.sort(key=lambda f: (f["file"], f["line"]))
    return findings


def to_sarif(findings: list[dict]) -> dict:
    used = sorted({f["ruleId"] for f in findings})
    rules = []
    for rid in used:
        name = desc = rid
        for key, (r, n, d) in RULES.items():
            if r == rid:
                name, desc = n, d
                break
        rules.append({
            "id": rid,
            "name": name,
            "shortDescription": {"text": desc},
            "defaultConfiguration": {"level": "error"},
        })
    results = []
    for f in findings:
        results.append({
            "ruleId": f["ruleId"],
            "level": "error",
            "message": {"text": "XXE 候选点：" + f["message"]},
            "locations": [{
                "physicalLocation": {
                    "artifactLocation": {"uri": f["file"]},
                    "region": {"startLine": f["line"], "startColumn": 1},
                }
            }],
        })
    return {
        "$schema": "https://json.schemastore.org/sarif-2.1.0.json",
        "version": "2.1.0",
        "runs": [{
            "tool": {"driver": {"name": "xxe-regex-baseline", "rules": rules}},
            "results": results,
        }],
    }


def main() -> int:
    ap = argparse.ArgumentParser(description="regex XXE baseline")
    ap.add_argument("--sarif", metavar="PATH")
    args = ap.parse_args()
    findings = scan()
    if args.sarif:
        text = json.dumps(to_sarif(findings), ensure_ascii=False, indent=2) + "\n"
        if args.sarif == "-":
            sys.stdout.write(text)
        else:
            with open(args.sarif, "w", encoding="utf-8", newline="\n") as fh:
                fh.write(text)
    else:
        json.dump({"findings": findings}, sys.stdout, ensure_ascii=False, indent=1)
        sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
