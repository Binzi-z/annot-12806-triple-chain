import json
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOG = os.path.join(ROOT, "logs", "auth.log")


def run(tmp_path, log=LOG):
    out = tmp_path / "out.json"
    r = subprocess.run(
        [sys.executable, os.path.join(ROOT, "detector", "detector.py"), log, str(out)],
        capture_output=True, text=True,
    )
    return r, out


def test_corpus_and_labels():
    assert os.path.exists(LOG)
    with open(os.path.join(ROOT, "labels.json"), encoding="utf-8") as fh:
        data = json.load(fh)
    assert len(data["events"]) == 3


def test_detector_runs(tmp_path):
    r, out = run(tmp_path)
    assert r.returncode == 0, r.stderr
    assert "findings" in json.loads(out.read_text(encoding="utf-8"))


def test_findings_have_required_fields(tmp_path):
    _, out = run(tmp_path)
    for f in json.loads(out.read_text(encoding="utf-8"))["findings"]:
        assert f.get("rule") and f.get("line") and f.get("ip")


def test_empty_log_yields_no_findings(tmp_path):
    empty = tmp_path / "empty.log"
    empty.write_text("", encoding="utf-8")
    r, out = run(tmp_path, str(empty))
    assert r.returncode == 0
    assert json.loads(out.read_text(encoding="utf-8"))["findings"] == []


def load_result(tmp_path):
    _, out = run(tmp_path)
    return json.loads(out.read_text(encoding="utf-8"))


def test_all_labels_hit_by_one_chain(tmp_path):
    result = load_result(tmp_path)
    chains = [f for f in result["findings"] if f["rule"] == "intrusion_chain"]
    assert len(chains) == 1
    chain = chains[0]
    stages = {s["stage"]: s for s in chain["evidence"]["stages"]}
    # labels.json: brute_force_success deploy/203.0.113.66
    assert chain["entities"]["user"] == "deploy"
    assert chain["entities"]["brute_force_src"] == "203.0.113.66"
    assert stages["brute_force_success"]["lines"] == list(range(841, 856))
    # labels.json: webshell from 10.20.1.51
    assert chain["entities"]["internal_host"] == "10.20.1.51"
    assert stages["webshell"]["lines"] == [856, 857]
    # labels.json: dns_tunnel 12 queries from 10.20.1.51
    assert chain["entities"]["dns_domain"] == "exfil.example.com"
    assert len(stages["dns_tunnel"]["lines"]) == 12
    # required output fields
    for key in ("rule", "first_seen", "last_seen", "entities", "evidence"):
        assert chain.get(key)


def test_zero_false_positives_on_benign_lookalikes(tmp_path):
    result = load_result(tmp_path)
    # benign: ops retry (3 fails) from 10.20.1.77, 403 probes from 10.20.1.88
    blob = json.dumps(result)
    assert "10.20.1.77" not in blob
    assert "10.20.1.88" not in blob
    assert result["needs_review"] == []


def test_incomplete_chain_goes_to_needs_review(tmp_path):
    log = tmp_path / "partial.log"
    lines = [
        f"Oct 01 06:4{i}:00 web01 sshd[100]: Failed password for deploy "
        f"from 203.0.113.66 port 4923{i} ssh2" for i in range(10)
    ]
    lines.append("Oct 01 06:49:00 web01 sshd[100]: Accepted publickey "
                 "for deploy from 203.0.113.66 port 58687 ssh2")
    log.write_text("\n".join(lines) + "\n", encoding="utf-8")
    r, out = run(tmp_path, str(log))
    assert r.returncode == 0, r.stderr
    result = json.loads(out.read_text(encoding="utf-8"))
    assert result["findings"] == []  # isolated brute force is not alerted
    assert len(result["needs_review"]) == 1
    assert result["needs_review"][0]["broken_at"] == "webshell"
