"""
A scripted pick-and-place for the SIMULATED arm only.

It reads exact cube and box positions from the simulator (the `observe_scene`
RPC) and solves inverse kinematics on the same MJCF the browser runs. A real
arm has no such oracle -- this is a stand-in for a learned policy, and Studio
says so next to every pick_up and place it runs.

Units are the follower's (lerobot): degrees on the body joints, 0-100 on the
gripper (0 closed), mapped onto the MJCF exactly as studio/src/sim/jointMap.ts
does.
"""

import math
import sys
import threading
from pathlib import Path

import mujoco
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "voice"))

from skills import JOINTS, LIMITS, Keyframe  # noqa: E402  (voice/skills.py)

# ── Waypoints ──────────────────────────────────────────────────────────────

#: Gripper opening for the approach (wider sweeps a neighbouring cube: 45
#: picked 299 of 300 random layouts, 60 only 292), closed on the cube, and
#: open to let go over the box.
OPEN = 45.0
CLOSED = 0.0
RELEASE = 60.0

#: Height of the `gripperframe` site (about the fingertips), in metres above
#: the table: travel above a target, the slow-down before the grasp, the lift
#: and the release over the box. The grasp itself puts the site on the cube's
#: center. A held 3 cm cube hangs ~1.5 cm below the site; the box walls are
#: 3.5 cm tall.
SAFE_Z = 0.12
PRE_Z = 0.05
LIFT_Z = 0.12
PLACE_Z = 0.07

#: Seconds to hold once the jaws close, and once they open over the box.
GRIP_HOLD_S = 0.6
RELEASE_HOLD_S = 0.4

# ── IK ─────────────────────────────────────────────────────────────────────

#: The joints IK moves. wrist_roll is chosen first (to square the jaws to the
#: cube), the gripper is the plan's own.
SOLVED = ("shoulder_pan", "shoulder_lift", "elbow_flex", "wrist_flex")
#: Damped least squares: lambda, iteration cap, and when a solve is good enough.
DAMPING = 0.05
ITERS = 300
TOL_M = 0.0005
#: A waypoint whose solve ends further off than this is out of reach.
REACH_M = 0.004
#: Metres of position error one radian of tilt is worth: position wins.
TILT_WEIGHT = 0.05
#: The approach axis (the site's x) points down for a top grasp.
DOWN = np.array([0.0, 0.0, -1.0])

#: studio/src/sim/jointMap.ts CTRL_RANGE.gripper: 0 maps to lo, 100 to hi.
GRIP_LO, GRIP_HI = -0.17453, 1.74533

# ───────────────────────────────────────────────────────────────────────────


class PlanError(Exception):
    """Nothing to plan: an absent cube or an unreachable target. Its text is
    said out loud."""


def _wrap45(deg: float) -> float:
    """An angle folded into [-45, 45): a cube looks the same every 90 degrees."""
    return (deg + 45.0) % 90.0 - 45.0


def _yaw_deg(quat) -> float:
    """Yaw of a [w, x, y, z] quaternion about world z."""
    w, x, y, z = quat
    return math.degrees(math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z)))


class Planner:
    """Waypoints for pick and place, solved by DLS IK on `gripperframe`."""

    def __init__(self, scene_xml: Path) -> None:
        m = self._m = mujoco.MjModel.from_xml_path(str(scene_xml))
        self._d = mujoco.MjData(m)
        self._lock = threading.Lock()   # one scratch MjData, any number of sessions
        self._site = m.site("gripperframe").id
        self._qadr = {j: int(m.jnt_qposadr[m.joint(j).id]) for j in JOINTS}
        self._dadr = [int(m.jnt_dofadr[m.joint(j).id]) for j in SOLVED]
        # Where both the MJCF and MotionController's clamp let a joint go.
        self._lo, self._hi = {}, {}
        for j in SOLVED:
            lo, hi = np.degrees(m.jnt_range[m.joint(j).id])
            self._lo[j] = math.radians(max(lo, LIMITS[j][0]))
            self._hi[j] = math.radians(min(hi, LIMITS[j][1]))

    # -- plans -----------------------------------------------------------------

    def pick(self, scene: dict, color: str, current: dict[str, float]) -> tuple[Keyframe, ...]:
        """Above the cube, down slowly, close, lift. Ends closed."""
        cube = next((c for c in scene["cubes"] if c["color"] == color), None)
        if cube is None:
            raise PlanError(f"no {color} cube")
        x, y, z = cube["pos"]
        with self._lock:
            seed = {**current, "wrist_roll": self._square_roll(x, y, cube["quat"], current)}
            above = self._ik((x, y, SAFE_Z), seed, f"the {color} cube")
            pre = self._ik((x, y, PRE_Z), above, f"the {color} cube")
            grasp = self._ik((x, y, z), pre, f"the {color} cube")
            lift = self._ik((x, y, LIFT_Z), grasp, f"the {color} cube")
        return (Keyframe({**above, "gripper": OPEN}),
                Keyframe({**pre, "gripper": OPEN}),
                Keyframe({**grasp, "gripper": OPEN}),
                Keyframe({**grasp, "gripper": CLOSED}, hold_s=GRIP_HOLD_S),
                Keyframe({**lift, "gripper": CLOSED}))

    def place(self, scene: dict, current: dict[str, float]) -> tuple[Keyframe, ...]:
        """Over the box, down, open, back up. Ends open, above the box."""
        x, y, _ = scene["box"]["pos"]
        with self._lock:
            over = self._ik((x, y, SAFE_Z), current, "the box")
            down = self._ik((x, y, PLACE_Z), over, "the box")
        # CLOSED, not the measured opening: a jaw stopped by the cube reads
        # ~16, and commanding that would stop squeezing it.
        return (Keyframe({**over, "gripper": CLOSED}),
                Keyframe({**down, "gripper": CLOSED}),
                Keyframe({**down, "gripper": RELEASE}, hold_s=RELEASE_HOLD_S),
                Keyframe({**over, "gripper": RELEASE}))

    # -- kinematics ------------------------------------------------------------

    def fk(self, joints) -> np.ndarray:
        """World position of `gripperframe` for these joints."""
        with self._lock:
            self._pose(joints)
            return self._d.site_xpos[self._site].copy()

    def tilt_deg(self, joints) -> float:
        """How far the approach axis is from straight down."""
        with self._lock:
            self._pose(joints)
            axis = self._d.site_xmat[self._site].reshape(3, 3)[:, 0]
        return math.degrees(math.acos(float(np.clip(axis @ DOWN, -1.0, 1.0))))

    def _pose(self, joints) -> None:
        q = self._d.qpos
        for j in JOINTS:
            v = joints.get(j, 0.0)
            q[self._qadr[j]] = (GRIP_LO + v / 100.0 * (GRIP_HI - GRIP_LO) if j == "gripper"
                                else math.radians(v))
        mujoco.mj_kinematics(self._m, self._d)
        mujoco.mj_comPos(self._m, self._d)      # mj_jacSite reads subtree_com

    def _square_roll(self, x, y, quat, current) -> float:
        """wrist_roll that closes the jaws across two faces of the cube.

        The jaws close along the site's z axis. Pointing down, +roll turns
        that axis counter-clockwise about world z, degree for degree.
        """
        roll0 = {**current, "wrist_roll": 0.0}
        joints = self._ik((x, y, SAFE_Z), roll0, "the cube")
        self._pose(joints)
        close = self._d.site_xmat[self._site].reshape(3, 3)[:, 2]
        return _wrap45(_yaw_deg(quat) - math.degrees(math.atan2(close[1], close[0])))

    def _ik(self, target, seed, what: str) -> dict[str, float]:
        """The four SOLVED joints that put the site on `target`, pointing down
        where the arm can -- high above the table it can't (wrist_flex runs
        out), and position wins. Raises PlanError when the target is out of
        reach. Holds `self._lock`."""
        joints = self._dls(target, seed, TILT_WEIGHT)
        if self._off(target) > REACH_M:
            joints = self._dls(target, joints, 0.0)
        off = self._off(target)
        if off > REACH_M:
            raise PlanError(f"{what} is out of my reach ({off * 100:.0f} cm short)")
        return joints

    def _off(self, target) -> float:
        return float(np.linalg.norm(np.asarray(target) - self._d.site_xpos[self._site]))

    def _dls(self, target, seed, tilt_weight: float) -> dict[str, float]:
        """Damped least squares from `seed`: the site's position plus, weighted
        by `tilt_weight` (metres per radian), a downward approach axis."""
        target = np.asarray(target, dtype=float)
        joints = {j: float(seed[j]) for j in JOINTS if j in seed}
        self._pose(joints)
        m, d, q = self._m, self._d, self._d.qpos
        jacp, jacr = np.zeros((3, m.nv)), np.zeros((3, m.nv))
        for _ in range(ITERS):
            R = d.site_xmat[self._site].reshape(3, 3)
            e_pos = target - d.site_xpos[self._site]
            e_rot = np.cross(R[:, 0], DOWN)
            if np.linalg.norm(e_pos) < TOL_M and tilt_weight * np.linalg.norm(e_rot) < TOL_M:
                break
            mujoco.mj_jacSite(m, d, jacp, jacr, self._site)
            J = np.vstack([jacp[:, self._dadr], tilt_weight * jacr[:, self._dadr]])
            e = np.concatenate([e_pos, tilt_weight * e_rot])
            dq = J.T @ np.linalg.solve(J @ J.T + DAMPING ** 2 * np.eye(6), e)
            for k, j in enumerate(SOLVED):
                a = self._qadr[j]
                q[a] = min(max(q[a] + dq[k], self._lo[j]), self._hi[j])
            mujoco.mj_kinematics(m, d)
            mujoco.mj_comPos(m, d)
        return {**joints, **{j: math.degrees(q[self._qadr[j]]) for j in SOLVED}}
