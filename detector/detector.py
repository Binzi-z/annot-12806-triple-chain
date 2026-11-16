"""Three-stage intrusion-chain detector.

Correlates, by account and time window:
  stage 1  brute_force_success : many failed passwords then one success (same user+ip)
  stage 2  webshell            : upload endpoint hit, then execution under /uploads/?cmd=
  stage 3  dns_tunnel          : many long-subdomain queries to one external domain

Only a full chain (1 -> 2 -> 3 within the correlation window) raises an alert.
Isolated brute force / upload activity is NOT alerted; partial chains go to
needs_review with the break point named. Benign look-alikes (a few failed
retries, rejected probes, ordinary/CDN DNS) match no stage and stay silent.
"""

from __future__ import annotations

import json
import re
import sys
from datetime import datetime

TS = re.compile(r"^(?P<mon>\w{3})\s+(?P<day>\d{2})\ (?P<hms>\d{2}:\d{2}:\d{2})")
FAIL = re.compile(r"Failed password for (?P<user>\S+) from (?P<ip>[\d.]+)")
OK = re.compile(r"Accepted \S+ for (?P<user>\S+) from (?P<ip>[\d.]+)")
WEB = re.compile(r'nginx: (?P<ip>[\d.]+) - - "(?P<path>\S+)" (?P<status>\d{3})')
DNS = re.compile(r"dnsmasq\[\d+\]: query\[\w+\] (?P<qname>\S+) from (?P<ip>[\d.]+)")

MONTHS = {m: i for i, m in enumerate(
    ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
     "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"], start=1)}

# thresholds
BRUTE_MIN_FAILS = 10          # failed passwords before the success
BRUTE_SPAN = 600              # fails must fall within 10 min before success
WEBSHELL_GAP = 600            # upload -> execution max gap
DNS_MIN_QUERIES = 8           # long-label queries to one suffix
DNS_MIN_LABEL = 20            # subdomain length that counts as "encoded"
DNS_SPAN = 600                # tunnel burst window
CHAIN_GAP = 3600              # max gap between consecutive stages

# well-known CDN / infra suffixes whose long-ish names are benign
CDN_SUFFIXES = ("cloudfront.net", "akamaiedge.net", "akamai.net",
                "fastly.net", "cloudflare.com", "azureedge.net",
                "edgesuite.net", "cdn", "amazonaws.com")


def parse_ts(line: str) -> tuple[str, float] | None:
    m = TS.match(line)
    if not m:
        return None
    text = f"{m.group('mon')} {m.group('day')} {m.group('hms')}"
    dt = datetime(2025, MONTHS[m.group("mon")], int(m.group("day")),
                  *map(int, m.group("hms").split(":")))
    return text, dt.timestamp()


def parse(path: str):
    fails, oks, webs, dns = [], [], [], []
    with open(path, encoding="utf-8") as fh:
        for no, line in enumerate(fh, start=1):
            ts = parse_ts(line)
            if not ts:
                continue
            text, epoch = ts
            m = FAIL.search(line)
            if m:
                fails.append({"line": no, "ts": text, "t": epoch,
                              "user": m.group("user"), "ip": m.group("ip")})
                continue
            m = OK.search(line)
            if m:
                oks.append({"line": no, "ts": text, "t": epoch,
                            "user": m.group("user"), "ip": m.group("ip")})
                continue
            m = WEB.search(line)
            if m:
                webs.append({"line": no, "ts": text, "t": epoch,
                             "ip": m.group("ip"), "path": m.group("path"),
                             "status": int(m.group("status"))})
                continue
            m = DNS.search(line)
            if m:
                dns.append({"line": no, "ts": text, "t": epoch,
                            "ip": m.group("ip"), "qname": m.group("qname")})
    return fails, oks, webs, dns


def stage_brute_force(fails, oks):
    """>=BRUTE_MIN_FAILS failures for user+ip, then a success for same user+ip."""
    stages = []
    for ok in oks:
        prior = [f for f in fails
                 if f["user"] == ok["user"] and f["ip"] == ok["ip"]
                 and 0 <= ok["t"] - f["t"] <= BRUTE_SPAN]
        if len(prior) >= BRUTE_MIN_FAILS:
            stages.append({
                "stage": "brute_force_success",
                "user": ok["user"], "ip": ok["ip"],
                "first_seen": prior[0]["ts"], "last_seen": ok["ts"],
                "t0": prior[0]["t"], "t1": ok["t"],
                "lines": [f["line"] for f in prior] + [ok["line"]],
                "detail": f"{len(prior)} failed passwords for "
                          f"'{ok['user']}' then 1 success from {ok['ip']}",
            })
    return stages


def stage_webshell(webs):
    """Upload request (2xx) followed by /uploads/...?cmd= execution, same ip."""
    stages = []
    for up in webs:
        p = up["path"].lower()
        is_upload = ("upload" in p and "/uploads/" not in p
                     and up["status"] < 400)
        if not is_upload:
            continue
        execs = [w for w in webs
                 if w["ip"] == up["ip"] and w["status"] < 400
                 and "/uploads/" in w["path"].lower()
                 and "cmd=" in w["path"].lower()
                 and 0 <= w["t"] - up["t"] <= WEBSHELL_GAP]
        if execs:
            stages.append({
                "stage": "webshell",
                "ip": up["ip"],
                "first_seen": up["ts"], "last_seen": execs[-1]["ts"],
                "t0": up["t"], "t1": execs[-1]["t"],
                "lines": [up["line"]] + [e["line"] for e in execs],
                "detail": f"upload via {up['path']} then execute "
                          f"{execs[0]['path']} from {up['ip']}",
            })
    return stages


def stage_dns_tunnel(dns):
    """Burst of long, encoded-looking subdomains under one suffix from one ip."""
    by_ip = {}
    for q in dns:
        by_ip.setdefault(q["ip"], []).append(q)
    stages = []
    for ip, qs in by_ip.items():
        groups = {}
        for q in qs:
            name = q["qname"].rstrip(".")
            if "." not in name:
                continue
            label, suffix = name.split(".", 1)
            if len(label) < DNS_MIN_LABEL:
                continue
            if any(suffix.endswith(c) for c in CDN_SUFFIXES):
                continue
            groups.setdefault(suffix, []).append(q)
        for suffix, gq in groups.items():
            gq.sort(key=lambda q: q["t"])
            if len(gq) < DNS_MIN_QUERIES:
                continue
            if gq[-1]["t"] - gq[0]["t"] > DNS_SPAN:
                continue
            stages.append({
                "stage": "dns_tunnel",
                "ip": ip, "domain": suffix,
                "first_seen": gq[0]["ts"], "last_seen": gq[-1]["ts"],
                "t0": gq[0]["t"], "t1": gq[-1]["t"],
                "lines": [q["line"] for q in gq],
                "detail": f"{len(gq)} long-subdomain queries to {suffix} "
                          f"from {ip}",
            })
    return stages


def correlate(stages):
    """Chain brute_force -> webshell -> dns_tunnel within CHAIN_GAP.

    Link key: webshell and dns stages must share the same (internal) source
    ip; the account comes from the brute-force stage. Returns (chains, used).
    """
    bf = [s for s in stages if s["stage"] == "brute_force_success"]
    ws = [s for s in stages if s["stage"] == "webshell"]
    dn = [s for s in stages if s["stage"] == "dns_tunnel"]
    chains, used = [], set()
    for b in bf:
        for w in ws:
            if not (0 <= w["t0"] - b["t1"] <= CHAIN_GAP):
                continue
            for d in dn:
                if d["ip"] != w["ip"]:
                    continue
                if not (0 <= d["t0"] - w["t1"] <= CHAIN_GAP):
                    continue
                chains.append((b, w, d))
                used.update(id(s) for s in (b, w, d))
    return chains, used


def fmt_gap(seconds: float) -> str:
    return f"{int(seconds // 60)}m{int(seconds % 60):02d}s"


def build_finding(b, w, d):
    gap12 = fmt_gap(w["t0"] - b["t1"])
    gap23 = fmt_gap(d["t0"] - w["t1"])
    return {
        "rule": "intrusion_chain",
        "line": b["lines"][0],
        "ip": b["ip"],
        "first_seen": b["first_seen"],
        "last_seen": d["last_seen"],
        "entities": {
            "user": b["user"],
            "brute_force_src": b["ip"],
            "internal_host": w["ip"],
            "dns_domain": d["domain"],
        },
        "evidence": {
            "stages": [
                {"stage": s["stage"], "first_seen": s["first_seen"],
                 "last_seen": s["last_seen"], "lines": s["lines"],
                 "detail": s["detail"]}
                for s in (b, w, d)
            ],
            "correlation": (
                f"account '{b['user']}' brute-forced from {b['ip']} "
                f"(lines {b['lines'][0]}-{b['lines'][-1]}); "
                f"{gap12} later webshell upload+exec from internal host "
                f"{w['ip']} (lines {w['lines'][0]}-{w['lines'][-1]}); "
                f"{gap23} later DNS tunnel to {d['domain']} from the same "
                f"host {d['ip']} (lines {d['lines'][0]}-{d['lines'][-1]}). "
                f"Stages 2 and 3 share source {w['ip']}; all three stages "
                f"fall within a {fmt_gap(d['t1'] - b['t0'])} window."
            ),
        },
    }


def build_review(stage, missing):
    return {
        "stage_seen": stage["stage"],
        "broken_at": missing,
        "first_seen": stage["first_seen"],
        "last_seen": stage["last_seen"],
        "lines": stage["lines"],
        "detail": f"{stage['detail']} — chain incomplete: "
                  f"no {missing} stage within the correlation window",
    }


def scan(path: str) -> dict:
    fails, oks, webs, dns = parse(path)
    stages = (stage_brute_force(fails, oks) + stage_webshell(webs)
              + stage_dns_tunnel(dns))
    chains, used = correlate(stages)

    findings = [build_finding(b, w, d) for b, w, d in chains]

    order = ["brute_force_success", "webshell", "dns_tunnel"]
    needs_review = []
    for s in stages:
        if id(s) in used:
            continue
        idx = order.index(s["stage"])
        missing = order[idx + 1] if idx + 1 < len(order) else order[idx - 1]
        needs_review.append(build_review(s, missing))

    findings.sort(key=lambda f: f["line"])
    return {"findings": findings, "needs_review": needs_review}


def main() -> int:
    if len(sys.argv) < 3:
        print("usage: detector.py <log> <out.json>")
        return 2
    result = scan(sys.argv[1])
    with open(sys.argv[2], "w", encoding="utf-8") as fh:
        json.dump(result, fh, ensure_ascii=False, indent=2)
    print(f"{len(result['findings'])} findings, "
          f"{len(result['needs_review'])} needs_review -> {sys.argv[2]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
