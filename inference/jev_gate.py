"""Option 2: Jev checks a grasping chunk before it runs; a miss is resampled.

Only chunks that close the gripper are judged. Forward kinematics on the
joints at the closing step, corrected by the arm's sysID fit, gives the grasp
point (between the jaws), and the top camera's table calibration
(zrt-real-arm/general) turns it into a pixel. Checked on logged frames: the
corrected point lands between the jaws; the raw model point was 2-4 cm off. A ring goes there on a crop of the top frame
and Jev answers "is the cube inside the ring?". Below ACCEPT_P the leader
throws the chunk away and samples SmolVLA again (fresh noise), up to
--gate-tries times; the last sample runs regardless.

Sampling several chunks at once (best-of-N) was measured first: on the M4's
MPS 3 samples took 5.7 s against 0.79 s for one, so it is sequential here.
"""

import json
import os
import sys
import time
from pathlib import Path

import cv2
import numpy as np

REAL_ARM = Path(os.getenv("ZERORUNTIME_REAL_ARM", str(Path.home() / "zrt-real-arm" / "general")))

OPEN_ABOVE, CLOSED_BELOW = 20.0, 15.0    # gripper command: a chunk "grasps" when it crosses these
RING_CM = 2.0                            # ~ FK + calibration error (median 1.8 cm)
ACCEPT_P = 0.5
CROP_PX = 560                            # Jev wants 280..1568 per side
RING_BGR = (255, 0, 255)                 # magenta: nothing else on the table is


def closing_step(chunk: list, grip_now: float) -> int | None:
    """First step where the gripper command closes after having been open."""
    hi = grip_now
    for i, a in enumerate(chunk):
        if a["gripper"] < CLOSED_BELOW and hi > OPEN_ABOVE:
            return i
        hi = max(hi, a["gripper"])
    return None


class ChunkGate:
    def __init__(self, top_label: str, log_dir: Path, sub: str = "gate"):
        sys.path.insert(0, str(REAL_ARM))
        import paths
        from planner import Planner
        from table import Table
        from typesafe_sdk import TypeSafeClient
        from jev_supervisor import IMG_HDR, MODEL
        import sysid
        self.planner = Planner(paths.SCENE_XML)
        self.corr = sysid.Correction.load(REAL_ARM / "arm_correction.json")
        self.table = Table.load(REAL_ARM / "table_calibration.json")
        # The cameras were put back to the training view on 2026-11-06; the table
        # calibration above is from the old view (~10 cm off). This fit is from the
        # training episodes themselves and wins when present.
        f = Path(__file__).with_name("top_from_training.json")
        self.top_h = np.array(json.loads(f.read_text())["H"]) if f.exists() else None
        print(f"  gate: top camera -> table from {f.name if self.top_h is not None else 'table_calibration.json'}",
              flush=True)
        self.client = TypeSafeClient(headers=IMG_HDR, timeout=3.0)
        self.model, self.top = MODEL, top_label
        self.dir = log_dir / sub
        self.dir.mkdir(parents=True, exist_ok=True)
        self.rows = []
        print(f"  gate: FK + top-camera calibration from {REAL_ARM}", flush=True)

    def to_px(self, xyz) -> np.ndarray:
        """Table-frame point -> top-camera pixel, between the two nearest calibrated planes."""
        x, y, z = (float(v) for v in xyz)
        if self.top_h is not None:             # ponytail: ignores height, ~1 cm parallax at grasp heights; drawing + gate ring only
            return cv2.perspectiveTransform(np.array([[[x, y]]], float), np.linalg.inv(self.top_h))[0, 0]
        zs = sorted(self.table.planes, key=lambda k: abs(k - z))[:2]
        p = [cv2.perspectiveTransform(np.array([[[x, y]]], float),
                                      np.linalg.inv(self.table.planes[k]))[0, 0] for k in zs]
        return p[0] + (p[1] - p[0]) * (z - zs[0]) / (zs[1] - zs[0])

    def accept(self, images: dict, joints: dict, chunk: list) -> bool:
        k = closing_step(chunk, joints.get("gripper", 0.0))
        if k is None:
            return True                       # not a grasp: nothing to judge
        t0 = time.monotonic()
        n = len(self.rows)
        xyz = self.corr.grasp_point(self.planner, chunk[k])
        px = self.to_px(xyz)
        img = self.draw(cv2.cvtColor(images[self.top], cv2.COLOR_RGB2BGR), xyz, px)
        cv2.imwrite(str(self.dir / f"{n:04d}.jpg"), img)
        row = {"i": n, "t": time.time(), "step": k, "xyz": [round(float(v), 4) for v in xyz],
               "px": [round(float(v), 1) for v in px]}
        try:
            from typesafe_sdk import Image, Noul
            r = self.client.system_one(
                state={"top": Image(cv2.imencode(".jpg", img)[1].tobytes())},
                questions={"on_cube": Noul(instructions="In `top`, the orange cube is inside "
                                                        "the magenta ring.")},
                model=self.model)
            p = r.answers["on_cube"].noul
        except Exception as exc:              # no verdict: let the policy's chunk run
            p, row["error"] = None, exc.__class__.__name__
        row.update(p=p, ok=p is None or p >= ACCEPT_P, ms=round((time.monotonic() - t0) * 1e3))
        self.rows.append(row)
        with open(self.dir / "gate.jsonl", "a") as f:
            f.write(json.dumps(row) + "\n")
        print(f"  gate {row['ms']:4d}ms  grasp at step {k} ({xyz[0]*100:.0f},{xyz[1]*100:.0f}) cm  "
              f"cube-in-ring p={'-' if p is None else f'{p:.2f}'}  -> "
              f"{'RUN' if row['ok'] else 'REJECT, resample'}", flush=True)
        return row["ok"]

    def draw(self, bgr: np.ndarray, xyz, px) -> np.ndarray:
        """Crop around the grasp point, upscaled to CROP_PX, ring drawn after scaling."""
        h, w = bgr.shape[:2]
        half = 70                             # 140 px of the 640 px top view, about 20 cm
        x0 = int(np.clip(px[0] - half, 0, w - 2 * half))
        y0 = int(np.clip(px[1] - half, 0, h - 2 * half))
        s = CROP_PX / (2 * half)
        img = cv2.resize(bgr[y0:y0 + 2 * half, x0:x0 + 2 * half], (CROP_PX, CROP_PX),
                         interpolation=cv2.INTER_CUBIC)
        ppcm = float(np.hypot(*(self.to_px((xyz[0] + 0.01, xyz[1], xyz[2])) - px)))
        cv2.circle(img, (int((px[0] - x0) * s), int((px[1] - y0) * s)),
                   max(8, int(RING_CM * ppcm * s)), RING_BGR, 3)
        return img


# -- Option 4, form 1: edit the grasp onto the cube ---------------------------
#
# Instead of rejecting a chunk that would miss, move it. Jev boxes the cube in
# the top camera, the table calibration turns the box centre into table xy,
# IK on the corrected arm model (zrt-real-arm/general/arm.py: solve) gives the
# joints that put the grasp point there, and the difference to the policy's
# own closing pose is faded into the chunk up to the closing step. The policy
# keeps its timing and gripper; only where it closes moves.

DEADBAND_M = 0.015      # a miss smaller than this is inside FK + calibration error (1.8 cm median)
MAX_FIX_M = 0.10        # a "miss" larger than this is more likely a wrong box than a wrong policy
MIN_RAMP = 4            # steps to slide sideways while high; fewer = too late to move
LOW_Z = 0.06            # grasp point below this (3 cm over the cube's top) = descending: no sliding
Z_STEPS = 3             # at least this many steps for the up/down part before the close
HOLD, FADE = 10, 10     # after the close: keep the shift 1 s (grip + lift), then fade it out
VISIBLE_P = 0.6         # trust a box only when the cube is in plain sight
CUBE_H = 0.03           # known_sizes.json
MAX_JOINT_DELTA = 30.0  # IK that swings a joint more than this changes the approach, not the aim


def smoothstep(t: float) -> float:
    t = min(1.0, max(0.0, t))
    return t * t * (3 - 2 * t)


def descent_step(heights: list, i0: int, k: int) -> int:
    """First step from i0 where the planned grasp point is low, at the latest
    Z_STEPS before the close. `heights[i]` is step i's grasp-point z."""
    low = next((i for i in range(i0, k + 1) if heights[i] < LOW_Z), k)
    return min(low, k - Z_STEPS)


def apply_delta(chunk: list, side: dict, down: dict, i0: int, d: int, k: int) -> list:
    """The sideways shift `side` faded in over i0..d while the hand is high,
    the up/down rest `down` over d..k as it descends; both held HOLD steps
    after the close, then faded out over FADE. Sliding sideways near the
    table pushes the cube: run jev-20261106-111520 did exactly that."""
    out = []
    for i, a in enumerate(chunk):
        if i <= k:
            w1 = smoothstep((i - i0) / max(1, d - i0)) if i >= i0 else 0.0
            w2 = smoothstep((i - d) / max(1, k - d)) if i >= d else 0.0
        else:
            w1 = w2 = 1.0 - smoothstep((i - k - HOLD) / FADE)
        out.append({j: v + w1 * side.get(j, 0.0) + w2 * down.get(j, 0.0) for j, v in a.items()})
    return out


class ChunkSteer(ChunkGate):
    """`steer(images, joints, chunk, t_obs)` -> the chunk, its grasp moved onto the cube."""

    def __init__(self, top_label: str, log_dir: Path, hz: float, ctl):
        super().__init__(top_label, log_dir, sub="steer")
        import arm
        self.arm, self.setup = arm, arm.ArmSetup.load()
        self.period, self.ctl = 1.0 / hz, ctl
        self.cube, self.cube_closes = None, -1     # cached table xyz, and when it was seen
        self.z = arm.grasp_z(CUBE_H, self.setup)

    def find_cube(self, rgb: np.ndarray) -> dict:
        """Ask Jev where the cube is; cache it until the next grasp (one can push it)."""
        from typesafe_sdk import Box, Image, Noul
        closes = len(self.ctl.close_times)
        if self.cube is not None and closes == self.cube_closes:
            return {"cube": self.cube, "cached": True}
        r = self.client.system_one(
            state={"top": Image(cv2.imencode(".jpg", cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR))[1].tobytes())},
            questions={"visible": Noul(instructions="In `top`, the orange cube is clearly visible, "
                                                    "not hidden under the gripper."),
                       "cube": Box(instructions="the orange cube in `top`")},
            model=self.model)
        p, b = r.answers["visible"].noul, r.answers["cube"].box
        h, w = rgb.shape[:2]
        u, v = (b.left + b.right) / 2 * w, (b.top + b.bottom) / 2 * h
        out = {"visible": round(p, 3), "box": [round(x, 4) for x in (b.left, b.top, b.right, b.bottom)],
               "px": [round(u, 1), round(v, 1)]}
        if p >= VISIBLE_P:                     # the box centre is the cube's middle, not its top
            if self.top_h is not None:
                x, y = cv2.perspectiveTransform(np.array([[[u, v]]], float), self.top_h)[0, 0]
            else:
                x, y = self.table.to_xy(u, v, CUBE_H / 2)
            self.cube, self.cube_closes = np.array([x, y, self.z]), closes
            out["cube"] = self.cube
        return out

    def steer(self, images: dict, joints: dict, chunk: list, t_obs: float) -> list:
        k = closing_step(chunk, joints.get("gripper", 0.0))
        if k is None:
            return chunk                       # not a grasp
        t0 = time.monotonic()
        n = len(self.rows)
        row = {"i": n, "t": time.time(), "step": k}
        out, why = chunk, None
        try:
            g = self.corr.grasp_point(self.planner, chunk[k])
            row["grasp"] = [round(float(v), 4) for v in g]
            seen = self.find_cube(images[self.top])
            cube = seen.pop("cube", None)
            row.update(seen)
            if cube is None:
                why = "cube not visible"
            else:
                row["cube"] = [round(float(v), 4) for v in cube]
                miss = float(np.linalg.norm(cube - g))
                row["miss_cm"] = round(miss * 100, 1)
                # The run() thread skips the steps that played while we worked.
                i0 = int(round((time.monotonic() - t_obs) / self.period))
                if miss < DEADBAND_M:
                    why = "on target"
                elif miss > MAX_FIX_M:
                    why = "miss too big to trust"
                else:
                    heights = [0.0] * i0 + [float(self.corr.grasp_point(self.planner, chunk[i])[2])
                                            for i in range(i0, k + 1)]
                    d = descent_step(heights, i0, k)
                    row.update(i0=i0, descent=d)
                    if d - i0 < MIN_RAMP:
                        raise ValueError("hand already low: sliding sideways would push the cube")
                    seed = {j: v for j, v in chunk[k].items() if j != "gripper"}
                    # Sideways at the policy's own closing height, then the rest down to the cube.
                    high = np.array([cube[0], cube[1], max(float(g[2]), cube[2])])
                    q_hi = self.arm.solve(self.planner, self.corr, high, seed, "over the cube")
                    q = self.arm.solve(self.planner, self.corr, cube, q_hi, "the cube")
                    side = {j: q_hi[j] - chunk[k][j] for j in seed}
                    down = {j: q[j] - q_hi[j] for j in seed}
                    row["delta"] = {j: round(side[j] + down[j], 1) for j in seed}
                    if max(abs(v) for v in row["delta"].values()) > MAX_JOINT_DELTA:
                        raise ValueError("IK swings a joint over "
                                         f"{MAX_JOINT_DELTA:.0f}: a different approach, not a re-aim")
                    out = apply_delta(chunk, side, down, i0, d, k)
                    row.update(max_step=round(max(abs(out[i][j] - out[i - 1][j])
                                                  for i in range(max(1, i0), len(out))
                                                  for j in seed), 1))
                    after = self.corr.grasp_point(self.planner, out[k])
                    row["after_cm"] = round(float(np.linalg.norm(cube - after)) * 100, 1)
        except Exception as exc:               # no edit: the policy's chunk runs as it was
            why = f"{exc.__class__.__name__}: {exc}"
        row.update(edited=out is not chunk, why=why, ms=round((time.monotonic() - t0) * 1e3))
        self.rows.append(row)
        self.save(images[self.top], row)
        with open(self.dir / "steer.jsonl", "a") as f:
            f.write(json.dumps(row) + "\n")
        print(f"  steer {row['ms']:4d}ms  grasp at step {k}  miss {row.get('miss_cm', '-')} cm  -> "
              f"{'EDIT, after ' + str(row.get('after_cm', '-')) + ' cm' if row['edited'] else why}", flush=True)
        return out

    def save(self, rgb: np.ndarray, row: dict) -> None:
        """Top frame: Jev's box (green), the policy's grasp (magenta), the edited grasp (cyan)."""
        img = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
        h, w = img.shape[:2]
        if "box" in row:
            l, t, r, b = row["box"]
            cv2.rectangle(img, (int(l * w), int(t * h)), (int(r * w), int(b * h)), (0, 255, 0), 2)
        if "grasp" in row:
            cv2.circle(img, tuple(int(c) for c in self.to_px(row["grasp"])), 6, RING_BGR, 2)
        if row.get("edited"):
            cv2.circle(img, tuple(int(c) for c in self.to_px(row["cube"])), 6, (255, 255, 0), 2)
        cv2.imwrite(str(self.dir / f"{row['i']:04d}.jpg"), img)


if __name__ == "__main__":
    # Self-check: what counts as a grasp chunk.
    mk = lambda gs: [{"gripper": g} for g in gs]
    assert closing_step(mk([30, 25, 14, 5]), 2.0) == 2          # opens then closes
    assert closing_step(mk([30, 25, 22]), 2.0) is None            # opens, never closes
    assert closing_step(mk([12, 12, 12]), 12.0) is None           # holding: no new grasp
    assert closing_step(mk([10, 5]), 30.0) == 0                   # was open: closes at once
    # Where the descent starts: first low step, but leave Z_STEPS for it.
    hs = [0.15] * 8 + [0.05] * 12
    assert descent_step(hs, 2, 19) == 8                            # first step under LOW_Z
    assert descent_step([0.15] * 20, 2, 19) == 19 - Z_STEPS        # never low: still room to descend
    assert descent_step(hs, 10, 19) == 10                          # already low: no room to slide
    # The edit: sideways done by the descent, down done by the close, held, then gone.
    ch = [{"shoulder_pan": 0.0, "shoulder_lift": 0.0, "gripper": 30.0} for _ in range(40)]
    ed = apply_delta(ch, {"shoulder_pan": 10.0}, {"shoulder_lift": 5.0}, i0=2, d=6, k=10)
    pan = [a["shoulder_pan"] for a in ed]
    lift = [a["shoulder_lift"] for a in ed]
    assert pan[:3] == [0.0, 0.0, 0.0] and pan[6] == 10.0           # sideways complete at the descent
    assert lift[6] == 0.0 and lift[10] == 5.0                      # down only after it, done at the close
    assert all(b >= a for a, b in zip(pan[2:7], pan[3:7]))         # rises smoothly
    assert pan[10 + HOLD] == 10.0 and pan[10 + HOLD + FADE] == 0.0  # held, then faded out
    assert all(a["gripper"] == 30.0 for a in ed)                   # gripper untouched
    assert ch[10]["shoulder_pan"] == 0.0                           # input not mutated
    print("ok")
