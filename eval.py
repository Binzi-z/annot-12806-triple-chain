#!/usr/bin/env python3
"""eval.py —— 拿分析器输出和 labels.json 对比（file+line 口径）。

用法：python eval.py findings.json
findings 支持 {"findings":[{file,line}]} 或 SARIF 2.1.0。
Windows PowerShell 5.1 的 > 会写成 UTF-16LE，所以按 utf-8/utf-16/gb18030 依次解码。
"""
from __future__ import annotations

import json
import sys


def load_doc(path: str) -> dict:
    raw = open(path, "rb").read()
    for enc in ("utf-8-sig", "utf-16", "gb18030"):
        try:
            return json.loads(raw.decode(enc))
        except (UnicodeDecodeError, ValueError):
            continue
    raise SystemExit("无法解析 findings 文件: %s" % path)


def norm(uri: str) -> str:
    uri = str(uri).replace("\\", "/")
    if uri.startswith("file:///"):
        uri = uri[len("file:///"):]
    return uri.lstrip("./")


def load_findings(path: str) -> set[tuple[str, int]]:
    doc = load_doc(path)
    out: set[tuple[str, int]] = set()
    if "findings" in doc:
        for f in doc["findings"]:
            out.add((norm(f.get("file", "")), int(f.get("line", 0))))
        return out
    for run in doc.get("runs", []):
        for res in run.get("results", []):
            for loc in res.get("locations", []):
                physical = loc.get("physicalLocation", {})
                art = physical.get("artifactLocation", {})
                reg = physical.get("region", {})
                out.add((norm(art.get("uri", "")), int(reg.get("startLine", 0))))
    return out


def main() -> int:
    with open("labels.json", encoding="utf-8") as fh:
        labels = json.load(fh)["vulns"]
    truth = {(v["file"], int(v["line"])) for v in labels}
    got = load_findings(sys.argv[1])
    tp = len(truth & got)
    fp = len(got - truth)
    fn = len(truth - got)
    recall = tp / (tp + fn) if (tp + fn) else 0.0
    fp_rate = fp / (tp + fp) if (tp + fp) else 0.0
    print(f"labels={len(truth)} findings={len(got)} TP={tp} FP={fp} FN={fn}")
    print(f"recall={recall:.1%} false_positive_rate={fp_rate:.1%}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
