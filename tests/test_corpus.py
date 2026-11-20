"""语料自检：labels 行号 anchor、sink 覆盖、baseline 召回/误报、确定性。

跑法：python -m pytest tests -q
"""
import json
import os
import re
import subprocess
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SINK_RE = re.compile(
    r"(?:parseFromString|parseString|parseXml|expandEntities|resolveEntity|parser\.write|xmlParser\.parse)\s*\("
)


def labels():
    with open(os.path.join(ROOT, "labels.json"), encoding="utf-8") as fh:
        return json.load(fh)["vulns"]


def lines_of(rel):
    with open(os.path.join(ROOT, rel), encoding="utf-8") as fh:
        return fh.read().splitlines()


def run_baseline():
    proc = subprocess.run(
        [sys.executable, os.path.join(ROOT, "baseline", "scan.py")],
        capture_output=True, text=True, encoding="utf-8", cwd=ROOT, check=True,
    )
    return json.loads(proc.stdout)["findings"]


def test_fifty_labels_point_at_real_sink_lines():
    vs = labels()
    assert len(vs) == 50, "题面要求 50 条标注样本，实际 %d" % len(vs)
    for v in vs:
        assert v["sink"] in {"dom_parser", "sax_parser", "xml_binding", "entity_expansion"}
        path = os.path.join(ROOT, v["file"])
        assert os.path.exists(path), v["file"]
        ls = lines_of(v["file"])
        assert 1 <= int(v["line"]) <= len(ls), "%s:%s 越界" % (v["file"], v["line"])
        line = ls[int(v["line"]) - 1]
        assert SINK_RE.search(line), "%s:%s 不是 sink 行：%s" % (v["file"], v["line"], line)


def test_four_sink_classes_and_three_sources():
    vs = labels()
    sinks = {}
    sources = {}
    for v in vs:
        sinks[v["sink"]] = sinks.get(v["sink"], 0) + 1
        sources[v["source"]] = sources.get(v["source"], 0) + 1
    for k in ("dom_parser", "sax_parser", "xml_binding", "entity_expansion"):
        assert sinks.get(k, 0) >= 10, "sink %s 只有 %d 条" % (k, sinks.get(k, 0))
    for k in ("uploaded_file", "url_param", "message_body"):
        assert sources.get(k, 0) >= 10, "source %s 只有 %d 条" % (k, sources.get(k, 0))


def test_baseline_recall_and_false_positive_room():
    truth = {(v["file"], int(v["line"])) for v in labels()}
    got = {(f["file"], int(f["line"])) for f in run_baseline()}
    tp = len(truth & got)
    recall = tp / len(truth) if truth else 0.0
    fp_rate = (len(got - truth) / len(got)) if got else 0.0
    assert recall >= 0.90, "baseline 召回 %.1f%% < 90%%" % (recall * 100)
    assert fp_rate > 0.20, "baseline 误报率 %.1f%% <= 20%%，题目没有改进空间" % (fp_rate * 100)


def test_monorepo_workspaces_and_three_packages():
    with open(os.path.join(ROOT, "package.json"), encoding="utf-8") as fh:
        pkg = json.load(fh)
    assert pkg["workspaces"] == ["packages/*"]
    for name in ("common-config", "parser-wrapper", "doc-service"):
        assert os.path.isdir(os.path.join(ROOT, "packages", name))
    ts = [p for p in os.listdir(os.path.join(ROOT, "packages"))]
    assert len(ts) == 3


def test_sarif_is_byte_identical_across_runs(tmp_path):
    outs = []
    for i in range(2):
        out = tmp_path / ("f%d.sarif" % i)
        subprocess.run(
            [sys.executable, os.path.join(ROOT, "baseline", "scan.py"), "--sarif", str(out)],
            capture_output=True, text=True, encoding="utf-8", cwd=ROOT, check=True,
        )
        outs.append(out.read_bytes())
    assert outs[0] == outs[1], "同一提交连扫两次 SARIF 必须逐字节一致"


def test_prompt_matches_topic_file():
    topic = r"D:\AI-zhongqiang\cc-codex-annotation\topics\12806.txt"
    if not os.path.exists(topic):
        pytest.skip("topic file not present")
    raw = open(topic, encoding="utf-8").read()
    for ch in ("\u200b", "\u200c", "\u200d", "\ufeff"):
        raw = raw.replace(ch, "")
    with open(os.path.join(ROOT, "prompt.txt"), encoding="utf-8") as fh:
        assert fh.read().strip() == raw.strip()
