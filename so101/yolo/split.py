"""Split labeled YOLO images into train/val BY SESSION (plan.md 1.4) as symlinks under data/yolo/.

Neighbouring frames are near-identical, so a random frame split would leak into val.
Usage: python split.py [--val-every 4] | python split.py --selftest
"""
import argparse
import os
import re
import shutil
import tempfile
from pathlib import Path

import config

ROOT = Path(__file__).parent
# Core image stem. Labelling tools rename on export (Label Studio adds "<hash>-", Roboflow adds
# "_jpg.rf.<hash>"), so labels are matched by searching for this pattern, not by exact name.
STEM_RE = re.compile(r"(?:CUBE_IN_BOX|CUBE_IN_GRIPPER|CUBE_ON_TABLE|NO_CUBE)__.+?__[a-z]+__\d{5}")


def build(raw: Path, labels: Path, out: Path, val_every: int) -> dict[str, list[str]]:
    """Rebuild out/{train,val}/{images,labels} from raw/<STATE>/<session>/*.jpg. Returns split -> ['STATE/session']."""
    if out.exists():
        shutil.rmtree(out)
    for split in ("train", "val"):
        for kind in ("images", "labels"):
            (out / split / kind).mkdir(parents=True)

    lbl_by_stem = {m.group(0): p for p in labels.glob("*.txt") if (m := STEM_RE.search(p.stem))}
    splits = {"train": [], "val": []}
    for state_dir in sorted(p for p in raw.iterdir() if p.is_dir()):
        sessions = sorted(p for p in state_dir.iterdir() if p.is_dir())
        val = sessions[val_every - 1::val_every]
        if not val and len(sessions) >= 2:
            val = [sessions[-1]]
        counts = {"train": [0, 0], "val": [0, 0]}  # [sessions, images]
        for s in sessions:
            split = "val" if s in val else "train"
            n = 0
            for img in sorted(s.glob("*.jpg")):
                lbl = lbl_by_stem.get(img.stem)
                if lbl is None:
                    continue  # unlabeled; an EMPTY label file is a valid background image
                os.symlink(img.resolve(), out / split / "images" / img.name)
                os.symlink(lbl.resolve(), out / split / "labels" / (img.stem + ".txt"))
                n += 1
            if n == 0:
                print(f"WARNING: {state_dir.name}/{s.name} has 0 labeled images")
            splits[split].append(f"{state_dir.name}/{s.name}")
            counts[split][0] += 1
            counts[split][1] += n
        print(f"{state_dir.name:16s} train {counts['train'][0]:3d} sessions {counts['train'][1]:5d} images"
              f" | val {counts['val'][0]:3d} sessions {counts['val'][1]:5d} images")
        if len(sessions) < 2:
            print(f"WARNING: {state_dir.name} has {len(sessions)} session(s): no val session possible")

    # Absolute path: ultralytics may resolve a relative `path` against its own datasets dir.
    (out / "data.yaml").write_text(f"path: {out.resolve()}\ntrain: train/images\nval: val/images\n"
                                   "names:\n  0: cube\n  1: box\n")
    (out / "val_sessions.txt").write_text("".join(s + "\n" for s in splits["val"]))
    return splits


def suggest_roi(raw: Path, labels: Path, cam: str):
    """Suggest WRIST_HOLD_ROI from labelled cube centres in CUBE_IN_GRIPPER wrist frames. Also
    returns how many labelled CUBE_ON_TABLE wrist cubes (e.g. pre-grasp) would fall inside it.
    Normalized 0..1, like YOLO labels."""
    lbl_by_stem = {m.group(0): p for p in labels.glob("*.txt") if (m := STEM_RE.search(p.stem))}

    def centres(state):
        for img in raw.glob(f"{state}/*/*__{cam}__*.jpg"):
            lbl = lbl_by_stem.get(img.stem)
            for line in (lbl.read_text().splitlines() if lbl else []):
                c, x, y = line.split()[:3]
                if c == "0":  # cube
                    yield float(x), float(y)

    held = list(centres("CUBE_IN_GRIPPER"))
    if not held:
        return None, 0, 0
    xs, ys = [p[0] for p in held], [p[1] for p in held]
    # ponytail: min/max of centres + 25% padding; hand-tune in config.py if eval disagrees
    px, py = max(0.02, 0.25 * (max(xs) - min(xs))), max(0.02, 0.25 * (max(ys) - min(ys)))
    roi = tuple(round(v, 3) for v in (max(0, min(xs) - px), max(0, min(ys) - py),
                                      min(1, max(xs) + px), min(1, max(ys) + py)))
    table = list(centres("CUBE_ON_TABLE"))
    overlap = sum(roi[0] <= x <= roi[2] and roi[1] <= y <= roi[3] for x, y in table)
    return roi, overlap, len(table)


def print_roi(raw: Path, labels: Path):
    roi, overlap, n = suggest_roi(raw, labels, config.WRIST_CAM)
    if roi is None:
        print("No labelled CUBE_IN_GRIPPER wrist cubes yet: can't suggest WRIST_HOLD_ROI")
        return
    print(f"suggested WRIST_HOLD_ROI = {roi}   (set it in config.py)")
    if overlap:
        print(f"WARNING: {overlap}/{n} labelled CUBE_ON_TABLE wrist cubes fall inside it (pre-grasp look-alikes)")


def selftest():
    with tempfile.TemporaryDirectory() as d:
        d = Path(d)
        raw, labels, out = d / "yolo_raw", d / "labels", d / "yolo"
        labels.mkdir()
        nsess = {"CUBE_IN_BOX": 5, "CUBE_IN_GRIPPER": 2, "CUBE_ON_TABLE": 1, "NO_CUBE": 8}
        for state, n in nsess.items():
            for i in range(n):
                sess = raw / state / f"s{i}"
                sess.mkdir(parents=True)
                for cam in ("top", "side", "wrist"):
                    for idx in range(3):
                        stem = f"{state}__s{i}__{cam}__{idx:05d}"
                        (sess / f"{stem}.jpg").write_bytes(b"x")
                        if idx < 2:  # idx 2 stays unlabeled
                            prefix = "ab12cd34-" if idx else ""  # Label Studio-style rename
                            (labels / f"{prefix}{stem}.txt").write_text("" if idx else "0 0.5 0.5 0.1 0.1\n")
        build(raw, labels, out, 4)  # run twice: rebuild must not fail on an existing tree
        sp = build(raw, labels, out, 4)

        assert not set(sp["train"]) & set(sp["val"]), "session in both splits"
        assert len(sp["train"]) + len(sp["val"]) == sum(nsess.values())
        for state, n in nsess.items():
            nval = sum(s.startswith(state + "/") for s in sp["val"])
            assert nval >= (1 if n >= 2 else 0) and nval < max(n, 1), (state, nval)
        # no frame of a val session leaks into train
        for f in (out / "train" / "images").iterdir():
            st, sess = f.name.split("__")[:2]
            assert f"{st}/{sess}" not in sp["val"], f.name
        assert len(list((out / "val" / "images").iterdir())) == len(list((out / "val" / "labels").iterdir()))
        assert not any(p.name.endswith("__00002.jpg") for p in (out / "train" / "images").iterdir())
        assert (out / "val_sessions.txt").read_text().split() == sp["val"]
        assert (out / "data.yaml").read_text().startswith(f"path: {out.resolve()}")
        assert all(os.path.isabs(os.readlink(p)) for p in (out / "train" / "images").iterdir())
        # ROI suggestion: held cubes centred ~(0.5, 0.8) of the wrist frame; one table cube inside
        for state, sess, x, y in (("CUBE_IN_GRIPPER", "s0", 0.45, 0.75), ("CUBE_IN_GRIPPER", "s1", 0.55, 0.85),
                                  ("CUBE_ON_TABLE", "s0", 0.5, 0.8), ("CUBE_ON_TABLE", "s0", 0.1, 0.1)):
            stem = f"{state}__{sess}__wrist__{int(x * 100):05d}"
            (raw / state / sess / f"{stem}.jpg").write_bytes(b"x")
            (labels / f"{stem}.txt").write_text(f"0 {x} {y} 0.1 0.1\n1 0.5 0.5 0.9 0.9\n")
        roi, overlap, n = suggest_roi(raw, labels, "wrist")
        assert roi[0] <= 0.45 and roi[2] >= 0.55 and roi[1] <= 0.75 and roi[3] >= 0.85, roi
        assert 0 <= roi[0] and roi[2] <= 1 and roi[3] <= 1
        assert overlap >= 1 and n >= 2, (overlap, n)
    print("split.py selftest OK")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--val-every", type=int, default=4, help="every k-th session per state goes to val")
    ap.add_argument("--selftest", action="store_true")
    a = ap.parse_args()
    if a.selftest:
        selftest()
    else:
        raw = ROOT / "data" / "yolo_raw"
        if not raw.is_dir():
            raise SystemExit(f"{raw} not found: capture sessions with capture.py first")
        build(raw, ROOT / "data" / "labels", ROOT / "data" / "yolo", a.val_every)
        print(f"wrote {ROOT / 'data' / 'yolo'}")
        print_roi(raw, ROOT / "data" / "labels")
