"""Stage 1 capture: frames + gripper.pos from the running teleop session. Opens no camera and no arm.

Start so101/follower.py (and your leader) as usual, then in another terminal:

    python capture.py                                              # status only: read gripper.pos
    python capture.py --scene CUBE_ON_TABLE --tag center_bright    # save a labelled session
    python capture.py --model best.pt                              # live YOLO state
"""
import argparse
import json
import os
import sys
import time
from pathlib import Path

import cv2
from dotenv import load_dotenv
from zeroruntime.teleops import Leader, single_group_descriptor
from zeroruntime.teleops.protocol import Units

import config
from state import STATES, Debouncer, classify, yolo_to_dets

#: Sorted, to match the lerobot SO-101 adapter (same as inference/smolvla_leader.py).
JOINTS = ("elbow_flex", "gripper", "shoulder_lift", "shoulder_pan", "wrist_flex", "wrist_roll")


class Watcher(Leader):
    """A watch-only peer. It never calls claim_control() or hold_deadman(), so it holds no lease
    and sends no commands: the follower can't be moved by it. tick() is still required, since
    that is what drains the incoming video and joints."""

    def __init__(self, **kw):
        self.robot_id = "yolo_watcher"
        super().__init__(**kw)  # LAST, as in the SDK examples

    def descriptor(self):
        return single_group_descriptor(self.robot_id, "watcher", JOINTS,
                                       control_hz=config.WATCH_HZ, units=Units.NORMALIZED)

    def read_joints(self):
        return {}  # there is no operator arm here


ap = argparse.ArgumentParser()
ap.add_argument("--scene", choices=STATES, help="ground-truth state; enables saving")
ap.add_argument("--tag", default="", help="variation, e.g. pre_grasp, above_box")
ap.add_argument("--every", type=float, default=0.5, help="save interval in seconds")
ap.add_argument("--model", help="ultralytics YOLO model (.pt or .engine)")
args = ap.parse_args()

load_dotenv(config.SDK_ENV)
need = {k: os.getenv(k) for k in ("ZERORUNTIME_MEETING_ID", "ZERORUNTIME_AUTH_TOKEN")}
if args.model:
    need["WRIST_HOLD_ROI"] = config.WRIST_HOLD_ROI
missing = [k for k, v in need.items() if v is None]
if missing:
    sys.exit(f"Missing: {', '.join(missing)} (room id/token in {config.SDK_ENV}, the rest in config.py)")

model = None
if args.model:
    from ultralytics import YOLO
    model = YOLO(args.model, task="detect")
    debounce = Debouncer(config.DEBOUNCE_N)

out_dir = None
if args.scene:
    session = f"{time.strftime('%Y%m%d-%H%M%S')}_{args.tag}"
    out_dir = Path(__file__).parent / "data" / "yolo_raw" / args.scene / session
    out_dir.mkdir(parents=True, exist_ok=True)
    print(f"Saving to {out_dir}")

w = Watcher(meeting_id=need["ZERORUNTIME_MEETING_ID"], token=need["ZERORUNTIME_AUTH_TOKEN"],
            publish_hz=config.WATCH_HZ)
saved, next_save = 0, 0.0
raw = stable = "-"
seen = ""
try:
    w.start()
    print("joined the room; waiting for the follower's video (is follower.py running?)")
    for _ in w.ticks(hz=config.WATCH_HZ):
        o = w.peek_synced()  # never observation(): that would arm the operator's echo
        if o is None:
            continue
        try:
            # The wire carries planar I420; ultralytics and cv2.imwrite want BGR.
            frames = {ours: cv2.cvtColor(o.images[lbl].array, cv2.COLOR_YUV2BGR_I420)
                      for ours, lbl in config.CAMERAS.items() if lbl in o.images}
        finally:
            for f in o.images.values():
                f.release()
        if len(frames) < len(config.CAMERAS):
            print(f"\rwaiting for cameras: session has {sorted(o.images)}, config wants "
                  f"{sorted(config.CAMERAS.values())}  ", end="", flush=True)
            continue
        grip = o.joints.get("gripper")

        if model is not None:
            results = model(list(frames.values()), verbose=False)
            dets = {c: yolo_to_dets(r, config.YOLO_CONF) for c, r in zip(frames, results)}
            raw = classify(dets, config.WRIST_HOLD_ROI, grip, config.GRIP_HOLD_BAND,
                           config.FIXED_CAMS, config.WRIST_CAM)
            stable = debounce.update(raw) or stable
            seen = " ".join(
                f"{c}:{'C' if any(d[0] == 'cube' for d in ds) else '-'}"
                f"{'B' if any(d[0] == 'box' for d in ds) else '-'}" for c, ds in dets.items())

        now = time.time()
        if out_dir is not None and now >= next_save:
            next_save = now + args.every
            for c, img in frames.items():
                cv2.imwrite(str(out_dir / f"{args.scene}__{session}__{c}__{saved:05d}.jpg"), img)
            with open(out_dir / "meta.jsonl", "a") as f:
                f.write(json.dumps({"idx": saved, "t": now, "gripper_pos": grip,
                                    "joints": o.joints, "skew_ms": o.skew_ms}) + "\n")
            saved += 1

        g = "  n/a" if grip is None else f"{grip:5.1f}"
        print(f"\rgrip {g} | raw {raw:<15} | stable {stable:<15} | {seen} | saved {saved}  ",
              end="", flush=True)
except KeyboardInterrupt:
    print()
finally:
    w.stop()
