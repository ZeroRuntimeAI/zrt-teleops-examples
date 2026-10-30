"""The scripted planner, against the same MJCF the browser simulates.

Scenes are built the way the browser's Scene.observeScene() reports them: body
poses read back from MuJoCo after placing the cubes.
"""

import math
from pathlib import Path

import mujoco
import numpy as np
import pytest

from planner import (CLOSED, LIFT_Z, OPEN, PLACE_Z, PRE_Z, SAFE_Z, PlanError,
                     Planner)

import motion  # noqa: E402  (voice/, which planner puts on the path)

SCENE_XML = Path(__file__).resolve().parents[2] / "public" / "sim" / "scene.xml"
COLORS = ("red", "green", "blue", "yellow")
#: studio/src/sim/jointMap.ts HOME: where every session starts.
HOME = {"shoulder_pan": 0.0, "shoulder_lift": -60.0, "elbow_flex": 60.0,
        "wrist_flex": 35.0, "wrist_roll": 0.0, "gripper": 30.0}
GRIP_LO, GRIP_HI = -0.17453, 1.74533
REACH_M = 0.005


@pytest.fixture(scope="module")
def planner():
    return Planner(SCENE_XML)


class Sim:
    """MuJoCo Python on scene.xml: cube placement, observeScene(), and physics."""

    def __init__(self, cubes: dict, box_xy=(0.22, 0.125), yaw=0.0):
        self.m = mujoco.MjModel.from_xml_path(str(SCENE_XML))
        self.m.body("box").pos[:2] = box_xy
        self.d = mujoco.MjData(self.m)
        for color, pos in cubes.items():
            adr = self.m.jnt_qposadr[self.m.body(f"{color}_cube").jntadr[0]]
            self.d.qpos[adr:adr + 3] = pos
            self.d.qpos[adr + 3:adr + 7] = [math.cos(yaw / 2), 0, 0, math.sin(yaw / 2)]
        self.set_joints(HOME, teleport=True)
        mujoco.mj_forward(self.m, self.d)

    def set_joints(self, joints, teleport=False):
        for name, value in joints.items():
            rad = (GRIP_LO + value / 100 * (GRIP_HI - GRIP_LO) if name == "gripper"
                   else math.radians(value))
            self.d.ctrl[self.m.actuator(name).id] = rad
            if teleport:
                self.d.qpos[self.m.jnt_qposadr[self.m.joint(name).id]] = rad

    def joints(self):
        out = {}
        for name in HOME:
            q = self.d.qpos[self.m.jnt_qposadr[self.m.joint(name).id]]
            out[name] = ((q - GRIP_LO) / (GRIP_HI - GRIP_LO) * 100 if name == "gripper"
                         else math.degrees(q))
        return out

    def observe(self):
        body = lambda name: self.d.body(name)
        return {
            "cubes": [{"color": c, "pos": body(f"{c}_cube").xpos.tolist(),
                       "quat": body(f"{c}_cube").xquat.tolist(), "inBox": False}
                      for c in COLORS],
            "box": {"pos": body("box").xpos.tolist(), "innerHalf": 0.045},
            "gripper": {"pos": self.d.site("gripperframe").xpos.tolist()},
        }

    def run(self, keyframes):
        """Play keyframes the way MotionController does: its plan(), its smoothstep."""
        segments = motion.plan(self.joints(), keyframes, now=0.0)
        t, end = 0.0, segments[-1][1] + 1.0
        while t < end:
            self.set_joints(motion.setpoint_at(segments, t))
            mujoco.mj_step(self.m, self.d)
            t += self.m.opt.timestep

    def cube(self, color):
        return self.d.body(f"{color}_cube").xpos.copy()


RED_AT = [0.24, 0.05, 0.015]
OTHERS = {"green": [0.20, -0.10, 0.015], "blue": [0.30, -0.05, 0.015],
          "yellow": [0.16, -0.16, 0.015]}


def red_scene(**kw):
    return Sim({"red": RED_AT, **OTHERS}, **kw)


def test_every_pick_waypoint_reaches_its_target(planner):
    sim = red_scene()
    scene = sim.observe()
    cube = next(c["pos"] for c in scene["cubes"] if c["color"] == "red")
    keyframes = planner.pick(scene, "red", sim.joints())

    x, y, z = cube
    intended = [(x, y, SAFE_Z), (x, y, PRE_Z), (x, y, z), (x, y, z), (x, y, LIFT_Z)]
    assert len(keyframes) == len(intended)
    for kf, want in zip(keyframes, intended):
        got = planner.fk(kf.joints)
        assert np.linalg.norm(got - want) < REACH_M, (kf, got, want)


def test_pick_ends_closed_and_grasps_pointing_down(planner):
    sim = red_scene()
    keyframes = planner.pick(sim.observe(), "red", sim.joints())
    assert keyframes[-1].joints["gripper"] <= 5
    assert keyframes[0].joints["gripper"] == OPEN
    assert keyframes[-1].joints["gripper"] == CLOSED
    # The approach axis of the grasp pose is within 10 degrees of straight down.
    assert planner.tilt_deg(keyframes[2].joints) < 10


def test_pick_of_an_absent_color_is_a_plan_error(planner):
    sim = red_scene()
    with pytest.raises(PlanError, match="no purple cube"):
        planner.pick(sim.observe(), "purple", sim.joints())


def test_place_ends_open_above_the_box_footprint(planner):
    sim = red_scene()
    scene = sim.observe()
    held = planner.pick(scene, "red", sim.joints())[-1].joints
    keyframes = planner.place(scene, dict(held))
    last = keyframes[-1].joints
    assert last["gripper"] >= 50
    bx, by, _ = scene["box"]["pos"]
    half = scene["box"]["innerHalf"]
    gx, gy, gz = planner.fk(last)
    assert abs(gx - bx) < half and abs(gy - by) < half
    release = next(kf for kf in keyframes if kf.joints["gripper"] >= 50)
    assert np.linalg.norm(planner.fk(release.joints) - [bx, by, PLACE_Z]) < REACH_M


def test_keyframes_stay_inside_the_voice_limits(planner):
    """MotionController clamps to skills.LIMITS: a clamped keyframe would miss its FK."""
    import skills
    sim = red_scene()
    scene = sim.observe()
    for kf in planner.pick(scene, "red", sim.joints()) + planner.place(scene, HOME):
        for joint, value in kf.joints.items():
            lo, hi = skills.LIMITS[joint]
            assert lo <= value <= hi, (joint, value)


@pytest.mark.parametrize("yaw", [0.0, 0.6, -1.2])
def test_pick_then_place_puts_the_cube_in_the_box_under_physics(planner, yaw):
    sim = red_scene(yaw=yaw)
    for _ in range(200):                         # let the cubes settle
        mujoco.mj_step(sim.m, sim.d)
    sim.run(planner.pick(sim.observe(), "red", sim.joints()))
    assert sim.cube("red")[2] > 0.06, "the cube was not lifted"
    sim.run(planner.place(sim.observe(), sim.joints()))
    bx, by, _ = sim.d.body("box").xpos
    cx, cy, cz = sim.cube("red")
    assert abs(cx - bx) < 0.045 and abs(cy - by) < 0.045 and cz < 0.06, sim.cube("red")


def test_an_unreachable_cube_is_a_plan_error(planner):
    sim = Sim({"red": [0.7, 0.3, 0.015], **OTHERS})
    with pytest.raises(PlanError, match="reach"):
        planner.pick(sim.observe(), "red", sim.joints())
