#!/usr/bin/env python3
"""
One-time: map the table camera's pixels onto the arm's workspace.

    python calibrate_table.py            # moves the arm: clear the table first
    python calibrate_table.py --refit    # refit from the saved points, no arm

For each height in table.PLANES (the cube's top, the bowl's rim) the arm
visits a grid of points with its closed fingertips at that height. At each
one the vision model points at the fingertips in the camera frame, and
forward kinematics on the measured joints says where they really are. The
pairs fit one homography per plane, saved to table_calibration.json. Every
frame is kept under logs/calib/ with the point drawn on it, to check by eye.

Needs the follower running, voice/.env (token, room) and GOOGLE_API_KEY.
"""

import json
import sys
import threading
import time
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "studio" / "agent"))

import table  # noqa: E402
from config import FPS, HERE, required  # noqa: E402
from motion import MotionController, VoiceLeader  # noqa: E402
from planner import SAFE_Z, Planner  # noqa: E402
from skills import JOINTS, Keyframe  # noqa: E402

#: The grid, in the arm's frame: wide enough that the cube and bowl fall
#: inside it (a homography extrapolates badly). Unreachable points are
#: skipped, not fatal.
XS = (0.14, 0.22, 0.30)
YS = (-0.20, -0.10, 0.0, 0.10, 0.20)
#: Jaws closed: one tip to point at, not two. Open jaws made the model pick
#: either jaw and cost 1.6 cm rms; closed, 0.7 cm.
GRIP = 0.0
#: Settle before the frame: the follower's reported pose lags the command.
SETTLE_S = 1.0
#: Parked between planes and at the end.
HOME = {"shoulder_pan": 0.0, "shoulder_lift": -60.0, "elbow_flex": 60.0,
        "wrist_flex": 35.0, "wrist_roll": 0.0, "gripper": 10.0}

SCENE_XML = Path(__file__).resolve().parents[1] / "studio" / "public" / "sim" / "scene.xml"
OUT_DIR = HERE / "logs" / "calib"


def wait_for_joints(ctl, timeout_s: float = 10.0) -> dict:
    """The first full joint state: a command sent before it is refused."""
    end = time.monotonic() + timeout_s
    while time.monotonic() < end:
        joints = ctl.measured()
        if all(j in joints for j in JOINTS):
            return joints
        time.sleep(0.1)
    raise SystemExit("no joint state from the robot: is the follower running?")


def fit_and_save(points: dict[float, list[dict]]) -> None:
    planes = {}
    for z, pts in sorted(points.items()):
        if len(pts) < 4:
            raise SystemExit(f"plane z={z}: only {len(pts)} usable points; need 4. "
                             f"Frames are in {OUT_DIR}")
        H, rms, out = table.fit_plane([p["px"] for p in pts], [p["xy"] for p in pts])
        planes[z] = H
        print(f"plane z={z:.3f}: {len(pts) - len(out)} of {len(pts)} points, "
              f"rms {rms * 100:.2f} cm")
        for i, p in enumerate(pts):
            x, y = cv2.perspectiveTransform(np.array([[p["px"]]], dtype=float), H)[0, 0]
            err = ((x - p["xy"][0]) ** 2 + (y - p["xy"][1]) ** 2) ** 0.5 * 100
            print(f"  px {tuple(round(v) for v in p['px'])}  xy "
                  f"{tuple(round(v, 3) for v in p['xy'])}  err {err:.1f} cm"
                  f"{'  LEFT OUT' if i in out else ''}")
    size = tuple(next(iter(points.values()))[0]["image_size"])
    table.Table(planes, table.CAMERA, size).save(points=points)
    print(f"-> {table.CALIBRATION}")


def visit(planner, ctl, leader, z: float, current: dict) -> list[dict]:
    """The grid at height `z`: one point per reachable (x, y)."""
    points = []
    for x in XS:
        for y in YS:
            seed = {**current, "wrist_roll": 0.0}
            try:
                with planner._lock:
                    above = planner._ik((x, y, SAFE_Z), seed, "calibration point")
                    down = planner._ik((x, y, z), above, "calibration point")
            except Exception as exc:
                print(f"z={z:.2f} ({x:.2f}, {y:.2f}) skipped: {exc}")
                continue
            ctl.command((Keyframe({**above, "gripper": GRIP}),
                         Keyframe({**down, "gripper": GRIP}))).result(timeout=30)
            time.sleep(SETTLE_S)
            joints = ctl.measured()
            fx, fy, fz = (float(v) for v in planner.fk(joints))
            bgr = table.snapshot(leader)
            px = table.point_at(bgr, {"tip": table.TIP})["tip"]
            tag = f"z{z:.2f}_{x:.2f}_{y:.2f}"
            if px is None:
                print(f"z={z:.2f} ({x:.2f}, {y:.2f}) fingertips not seen; frame kept")
                cv2.imwrite(str(OUT_DIR / f"{tag}_unseen.jpg"), bgr)
            else:
                cv2.imwrite(str(OUT_DIR / f"{tag}_raw.jpg"), bgr)
                cv2.circle(bgr, (round(px[0]), round(px[1])), 6, (0, 0, 255), 2)
                cv2.imwrite(str(OUT_DIR / f"{tag}.jpg"), bgr)
                points.append({"target": [x, y], "xy": [fx, fy], "z": fz, "px": list(px),
                               "joints": joints, "image_size": [bgr.shape[1], bgr.shape[0]]})
                print(f"z={z:.2f} ({x:.2f}, {y:.2f}) fk ({fx:.3f}, {fy:.3f}, {fz:.3f})  px "
                      f"({px[0]:.0f}, {px[1]:.0f})")
            current = joints
            ctl.command((Keyframe({**above, "gripper": GRIP}),)).result(timeout=30)
    return points


def main() -> None:
    if "--refit" in sys.argv:
        d = json.loads(table.CALIBRATION.read_text())
        return fit_and_save({p["z"]: p["points"] for p in d["planes"]})

    token = required("ZERORUNTIME_AUTH_TOKEN", "your access token")
    room = required("ZERORUNTIME_MEETING_ID", "the room the follower is in")
    required("GOOGLE_API_KEY", "a Gemini key, for pointing at the fingertips")
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    planner = Planner(SCENE_XML)
    leader = VoiceLeader(meeting_id=room, token=token, fps=FPS, sync_buffer_ms=120.0)
    ctl = MotionController(leader, fps=FPS)
    leader.start()
    if not leader.claim_control(timeout_s=15):
        leader.stop()
        raise SystemExit(f"no control in {room}: is the follower running?")
    threading.Thread(target=lambda: [ctl.step() for _ in leader.ticks(FPS)],
                     daemon=True).start()

    points: dict[float, list[dict]] = {}
    try:
        current = wait_for_joints(ctl)
        for z in table.PLANES:
            points[z] = visit(planner, ctl, leader, z, current)
            (OUT_DIR / "points.json").write_text(json.dumps(points, indent=1))
            ctl.command((Keyframe(HOME),)).result(timeout=30)
            current = ctl.measured()
    finally:
        ctl.stop()
        time.sleep(3 / FPS)
        leader.stop()

    fit_and_save(points)


if __name__ == "__main__":
    main()
