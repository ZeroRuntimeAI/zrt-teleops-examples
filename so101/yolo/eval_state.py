"""Run YOLO + state.py on captured sessions and compare with the session's STATE folder (plan.md 1.6).

Usage: python eval_state.py --model best.engine [--sessions STATE/sess ...] [--all] | --selftest
"""
import argparse
import json
from pathlib import Path

import config

ROOT = Path(__file__).parent
RAW = ROOT / "data" / "yolo_raw"


def metrics(pairs, states):
    """pairs: [(truth, pred)] -> (confusion {truth: {pred: n}}, per-state acc {truth: float|None}, false_in_box)."""
    cm = {t: {p: 0 for p in states} for t in states}
    for t, p in pairs:
        cm[t][p] += 1
    acc = {t: (cm[t][t] / sum(cm[t].values()) if sum(cm[t].values()) else None) for t in states}
    false_in_box = sum(cm[t]["CUBE_IN_BOX"] for t in states if t != "CUBE_IN_BOX")
    return cm, acc, false_in_box


def report(title, pairs, states):
    cm, acc, fib = metrics(pairs, states)
    short = [s.replace("CUBE_", "") for s in states]
    print(f"\n== {title} ({len(pairs)} frames)  rows=truth, cols=pred")
    print(" " * 12 + "".join(f"{s:>12s}" for s in short) + "       acc")
    for t, name in zip(states, short):
        a = "     -" if acc[t] is None else f"{acc[t] * 100:6.1f}%"
        print(f"{name:12s}" + "".join(f"{cm[t][p]:12d}" for p in states) + f"   {a}")
    print(f"!!!!! FALSE CUBE_IN_BOX ({title}): {fib} !!!!!" if fib else f"FALSE CUBE_IN_BOX ({title}): 0")


def selftest():
    S = ("CUBE_IN_BOX", "CUBE_IN_GRIPPER", "CUBE_ON_TABLE", "NO_CUBE")
    pairs = [("CUBE_IN_BOX", "CUBE_IN_BOX"), ("CUBE_IN_BOX", "NO_CUBE"),
             ("CUBE_ON_TABLE", "CUBE_IN_BOX"), ("CUBE_ON_TABLE", "CUBE_ON_TABLE"),
             ("CUBE_ON_TABLE", "CUBE_ON_TABLE"), ("CUBE_IN_GRIPPER", "CUBE_IN_BOX")]
    cm, acc, fib = metrics(pairs, S)
    assert cm["CUBE_ON_TABLE"] == {"CUBE_IN_BOX": 1, "CUBE_IN_GRIPPER": 0, "CUBE_ON_TABLE": 2, "NO_CUBE": 0}
    assert acc["CUBE_IN_BOX"] == 0.5 and acc["CUBE_IN_GRIPPER"] == 0.0 and acc["NO_CUBE"] is None
    assert abs(acc["CUBE_ON_TABLE"] - 2 / 3) < 1e-9
    assert fib == 2  # true IN_BOX predicted IN_BOX doesn't count
    assert metrics([], S)[2] == 0
    report("selftest", pairs, S)
    print("\neval_state.py selftest OK")


def session_frames(sess_dir: Path):
    """Yield (idx, gripper_pos, {cam: jpg path}) in idx order, skipping idx with a missing camera image."""
    state, sess = sess_dir.parent.name, sess_dir.name
    rows = [json.loads(line) for line in (sess_dir / "meta.jsonl").read_text().splitlines() if line.strip()]
    for r in sorted(rows, key=lambda r: r["idx"]):
        paths = {cam: sess_dir / f"{state}__{sess}__{cam}__{r['idx']:05d}.jpg" for cam in config.CAMERAS}
        if all(p.exists() for p in paths.values()):
            yield r["idx"], r.get("gripper_pos"), paths


def main(a):
    if config.WRIST_HOLD_ROI is None:
        raise SystemExit("Set WRIST_HOLD_ROI in config.py first (`python split.py` suggests one).")
    from ultralytics import YOLO
    from state import STATES, yolo_to_dets, classify, Debouncer

    if a.all:
        sessions = sorted(f"{p.parent.name}/{p.name}" for p in RAW.glob("*/*") if p.is_dir())
    elif a.sessions:
        sessions = a.sessions
    else:
        vs = ROOT / "data" / "yolo" / "val_sessions.txt"
        if not vs.exists():
            raise SystemExit(f"{vs} not found: run `python split.py` first, or pass --all / --sessions")
        sessions = vs.read_text().split()
    if not sessions:
        raise SystemExit("no sessions to evaluate")

    model = YOLO(a.model, task="detect")
    raw_pairs, deb_pairs, per_session = [], [], []
    for s in sessions:
        truth = s.split("/")[0]
        deb = Debouncer(config.DEBOUNCE_N)
        n_raw, ok = len(raw_pairs), [0, 0]  # debounced [correct, total]
        for idx, grip, paths in session_frames(RAW / s):
            cams = list(paths)
            results = model([str(paths[c]) for c in cams], verbose=False)
            dets = {c: yolo_to_dets(r, config.YOLO_CONF) for c, r in zip(cams, results)}
            pred = classify(dets, config.WRIST_HOLD_ROI, grip, config.GRIP_HOLD_BAND,
                            config.FIXED_CAMS, config.WRIST_CAM)
            raw_pairs.append((truth, pred))
            stable = deb.update(pred)
            if stable is not None:
                deb_pairs.append((truth, stable))
                ok[0] += stable == truth
                ok[1] += 1
        print(f"{s}: {len(raw_pairs) - n_raw} frames, debounced {ok[0]}/{ok[1]}")
        per_session.append((ok[0] / ok[1] if ok[1] else 0.0, s, ok))

    report("RAW", raw_pairs, STATES)
    report("DEBOUNCED", deb_pairs, STATES)
    print("\nworst 5 sessions (debounced accuracy):")
    for acc, s, ok in sorted(per_session)[:5]:
        print(f"  {acc * 100:6.1f}%  {ok[0]}/{ok[1]}  {s}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", help="best.pt or best.engine")
    ap.add_argument("--sessions", nargs="+", metavar="STATE/session", help="default: data/yolo/val_sessions.txt")
    ap.add_argument("--all", action="store_true", help="evaluate every session in data/yolo_raw")
    ap.add_argument("--selftest", action="store_true")
    a = ap.parse_args()
    if a.selftest:
        selftest()
    elif not a.model:
        ap.error("--model is required")
    else:
        main(a)
