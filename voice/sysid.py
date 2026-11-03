#!/usr/bin/env python3
"""
System identification from teleoperated grasps: what the planner's arm model
gets wrong about THIS arm.

    python sysid.py demos.json           # fit, report, write arm_correction.json

Each demo is the arm's measured joints at the moment the jaws stopped on the
cube, and where the table camera saw that cube before the arm moved. The
model's grasp point for those joints should be the cube's centre. The fit
finds the joint zero offsets and the grasp point's offset inside the gripper
that make it so, and checks itself by leaving each demo out in turn.

The planner applies the result through `Correction` below: it plans on the
corrected model, then sends joints the real arm reads the same way.
"""

import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "studio" / "agent"))

from planner import Planner  # noqa: E402

import table  # noqa: E402

SCENE_XML = Path(__file__).resolve().parents[1] / "studio" / "public" / "sim" / "scene.xml"
OUT = Path(__file__).with_name("arm_correction.json")

#: The joints whose zero is fitted. wrist_roll only turns the jaws about the
#: approach axis; with a grasp offset it is weakly seen, so it is left alone.
OFFSET_JOINTS = ("shoulder_pan", "shoulder_lift", "elbow_flex", "wrist_flex")
#: Keep the fit honest: a few degrees of zero error and a few cm of finger
#: offset are plausible, anything bigger means bad data.
PRIOR_DEG = 5.0
PRIOR_M = 0.03


class Correction:
    """Joint zero offsets and the grasp point in the gripper site's frame."""

    def __init__(self, offsets: dict[str, float] | None = None, grasp=(0.0, 0.0, 0.0)) -> None:
        self.offsets = {j: float((offsets or {}).get(j, 0.0)) for j in OFFSET_JOINTS}
        self.grasp = np.asarray(grasp, dtype=float)

    @classmethod
    def load(cls, path: Path = OUT) -> "Correction":
        if not path.exists():
            return cls()
        d = json.loads(path.read_text())
        c = cls(d["offsets_deg"], d["grasp_offset_m"])
        c.release_xy = d.get("release_xy")       # where the demos let go: the box
        return c

    def to_model(self, joints: dict) -> dict:
        """The arm's reading, as the model's joint angle."""
        return {j: v + self.offsets.get(j, 0.0) for j, v in joints.items()}

    def to_arm(self, joints: dict) -> dict:
        return {j: v - self.offsets.get(j, 0.0) for j, v in joints.items()}

    def grasp_point(self, planner: Planner, arm_joints: dict) -> np.ndarray:
        """Where the jaws close, in the table frame, for the arm's reading."""
        with planner._lock:
            planner._pose(self.to_model(arm_joints))
            pos = planner._d.site_xpos[planner._site].copy()
            R = planner._d.site_xmat[planner._site].reshape(3, 3).copy()
        return pos + R @ self.grasp

    def site_target(self, planner: Planner, point, joints_hint: dict) -> np.ndarray:
        """The site position that puts the grasp point on `point`, for an
        orientation like `joints_hint`'s (the offset turns with the hand)."""
        with planner._lock:
            planner._pose(self.to_model(joints_hint))
            R = planner._d.site_xmat[planner._site].reshape(3, 3).copy()
        return np.asarray(point, dtype=float) - R @ self.grasp


def _params(c: Correction) -> np.ndarray:
    return np.r_[[c.offsets[j] for j in OFFSET_JOINTS], c.grasp]


def _correction(p) -> Correction:
    return Correction(dict(zip(OFFSET_JOINTS, p[:4])), p[4:7])


def fit(planner: Planner, demos: list[dict]) -> tuple[Correction, np.ndarray]:
    """Least squares over the demos, with a weak pull towards no correction.
    Returns the correction and each demo's residual (metres)."""
    from scipy.optimize import least_squares

    def residuals(p):
        c = _correction(p)
        r = [c.grasp_point(planner, d["joints"]) - d["target"] for d in demos]
        prior = np.r_[p[:4] / PRIOR_DEG, p[4:] / PRIOR_M] * 0.002     # 2 mm per prior unit
        return np.r_[np.ravel(r), prior]

    sol = least_squares(residuals, np.zeros(7), loss="soft_l1", f_scale=0.01)
    c = _correction(sol.x)
    res = np.array([c.grasp_point(planner, d["joints"]) - d["target"] for d in demos])
    return c, res


def main() -> None:
    src = json.loads(Path(sys.argv[1]).read_text())
    demos = [{"name": e["episode"], "joints": e["grasp"],
              "target": np.array([*e["cube_xy"], table.CUBE_Z])}
             for e in src["episodes"] if e.get("cube_xy")]
    planner = Planner(SCENE_XML)

    base = np.array([Correction().grasp_point(planner, d["joints"]) - d["target"] for d in demos])
    c, res = fit(planner, demos)
    loo = []
    for i in range(len(demos)):
        ci, _ = fit(planner, demos[:i] + demos[i + 1:])
        loo.append(ci.grasp_point(planner, demos[i]["joints"]) - demos[i]["target"])
    loo = np.array(loo)

    cm = lambda v: np.linalg.norm(v, axis=-1) * 100
    print(f"{'demo':10s} {'model now':>10s} {'fitted':>8s} {'left out':>9s}   cube (cm)")
    for d, b, r, l in zip(demos, base, res, loo):
        print(f"{d['name']:10s} {cm(b):8.1f}cm {cm(r):6.1f}cm {cm(l):7.1f}cm   "
              f"({d['target'][0] * 100:.1f}, {d['target'][1] * 100:.1f})")
    print(f"{'median':10s} {np.median(cm(base)):8.1f}cm {np.median(cm(res)):6.1f}cm "
          f"{np.median(cm(loo)):7.1f}cm")
    print("model now, mean error x/y/z (cm):", np.round(base.mean(axis=0) * 100, 1))
    print("offsets (deg):", {j: round(v, 1) for j, v in c.offsets.items()})
    print("grasp point in gripper frame (cm):", np.round(c.grasp * 100, 1))

    # Where the box top is: the grasp point at each release, minus half a cube.
    rel = np.array([c.grasp_point(planner, e["release"]) for e in src["episodes"]])
    box_top = float(np.median(rel[:, 2]) - table.CUBE_Z)
    print(f"box top: {box_top * 100:.1f} cm above the table (spread "
          f"{np.ptp(rel[:, 2]) * 100:.1f} cm), release centre "
          f"({np.median(rel[:, 0]) * 100:.1f}, {np.median(rel[:, 1]) * 100:.1f}) cm")

    OUT.write_text(json.dumps({
        "offsets_deg": c.offsets, "grasp_offset_m": c.grasp.tolist(),
        "box_top_z": box_top, "release_xy": [float(np.median(rel[:, 0])), float(np.median(rel[:, 1]))],
        "demos": len(demos), "median_error_cm": {"model_now": float(np.median(cm(base))),
                                                 "fitted": float(np.median(cm(res))),
                                                 "left_out": float(np.median(cm(loo)))}},
                              indent=1))
    print(f"-> {OUT}")


if __name__ == "__main__":
    main()
