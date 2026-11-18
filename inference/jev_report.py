"""Compare episodes by mode: python jev_report.py [--since 2026-11-04T18:00]"""

import argparse
import json
import statistics
import time
from pathlib import Path

LOGS = Path(__file__).resolve().parent / "logs"

p = argparse.ArgumentParser()
p.add_argument("--since", help="only episodes started after this local time, e.g. 2026-11-04T18:00")
a = p.parse_args()
since = time.mktime(time.strptime(a.since, "%Y-%m-%dT%H:%M")) if a.since else 0

eps = [json.loads(f.read_text()) | {"dir": f.parent.name}
       for f in sorted(LOGS.glob("jev-*/summary.json"))]
eps = [e for e in eps if e["started"] >= since and e["outcome"] != "aborted"
       and not e.get("excluded")]

med = lambda xs: round(statistics.median(xs), 1) if xs else "-"
print(f"{'mode':<8} {'eps':>3} {'success':>8} {'t_success':>9} {'attempts':>8} "
      f"{'recov':>5} {'chunk ms':>8} {'$/ep':>7}  outcomes")
for mode in ("shadow", "control", "gate", "steer"):
    es = [e for e in eps if e["mode"] == mode]
    if not es:
        continue
    ok = [e for e in es if e["success"]]
    outs = {}
    for e in es:
        outs[e["outcome"]] = outs.get(e["outcome"], 0) + 1
    print(f"{mode:<8} {len(es):>3} {len(ok):>3}/{len(es):<4} {med([e['t_end'] for e in ok]):>9} "
          f"{med([e['grasp_attempts'] for e in es]):>8} {med([len(e['recoveries']) for e in es]):>5} "
          f"{med([e['chunk_ms']['p50'] for e in es if e['chunk_ms']['p50']]):>8} "
          f"{med([e['jev_cost'] for e in es]):>7}  {outs}")
for e in eps:
    extra = "".join(f" {k}={e[k]}" for k in ("gate", "steer") if k in e)
    print(f"  {e['dir']}  {e['mode']:<7} {e['outcome']:<8} {e['t_end']:>5}s  attempts {e['grasp_attempts']}"
          f"  recoveries {[r['kind'] for r in e['recoveries']]}  would_act {e['would_act']}{extra}")
