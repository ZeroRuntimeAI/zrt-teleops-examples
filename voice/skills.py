"""
What the arm can do, as data: joint limits, poses and gestures.

Units are the follower's own: degrees on the five body joints, 0-100 on the
gripper (0 closed, 100 open). Every target is clamped to LIMITS before it
reaches the arm, so a skill -- or a misheard "raise your arm a LOT" -- can't
drive it into the table.

The pose values are STARTING POINTS. Capture your own with capture_pose.py
and paste them in: calibration differs per arm, and so does your table.
"""

import math
from dataclasses import dataclass
from typing import Mapping

#: The follower's joints, sorted: the order the lerobot adapter announces.
JOINTS = ("elbow_flex", "gripper", "shoulder_lift", "shoulder_pan",
          "wrist_flex", "wrist_roll")

#: Everything but the gripper -- what move_joint() may move.
BODY = ("shoulder_pan", "shoulder_lift", "elbow_flex", "wrist_flex",
        "wrist_roll")

#: Never command outside these. Inside the calibrated travel (about +-117
#: lift, +-100 elbow, +-105 wrist), with room for the folded rest pose
#: (lift -100, elbow +100). The forward ends stay short so a voice command
#: can't drive the arm into the table. Tighten them for your table.
LIMITS: dict[str, tuple[float, float]] = {
    "shoulder_pan": (-110.0, 110.0),
    "shoulder_lift": (-110.0, 90.0),
    "elbow_flex": (-95.0, 100.0),
    "wrist_flex": (-100.0, 100.0),
    "wrist_roll": (-150.0, 150.0),
    "gripper": (0.0, 100.0),
}


@dataclass(frozen=True)
class Keyframe:
    """Move the named joints -- the others stay put -- then pause `hold_s`.
    `relative` adds to where the arm is instead of naming a position."""
    joints: Mapping[str, float]
    relative: bool = False
    hold_s: float = 0.0


Motion = tuple[Keyframe, ...]

POSES: dict[str, dict[str, float]] = {
    "home": {"shoulder_pan": 0.0, "shoulder_lift": 0.0, "elbow_flex": 0.0,
             "wrist_flex": 0.0, "wrist_roll": 0.0, "gripper": 0.0},
    "ready": {"shoulder_pan": 0.0, "shoulder_lift": -20.0, "elbow_flex": 20.0,
              "wrist_flex": 30.0, "wrist_roll": 0.0},
    "rest": {"shoulder_pan": 0.0, "shoulder_lift": -80.0, "elbow_flex": 80.0,
             "wrist_flex": 60.0, "wrist_roll": 0.0},
    # Positive shoulder_pan turns to the robot's RIGHT.
    "point_left": {"shoulder_pan": -45.0, "shoulder_lift": 20.0,
                   "elbow_flex": -20.0, "wrist_flex": 0.0},
    "point_right": {"shoulder_pan": 45.0, "shoulder_lift": 20.0,
                    "elbow_flex": -20.0, "wrist_flex": 0.0},
    "look_down": {"wrist_flex": 60.0},
}


def _swing(joint: str, amount: float, times: int = 2) -> Motion:
    """Out, back and forth `times` times, and home again: nets to zero."""
    there = Keyframe({joint: amount}, relative=True)
    across = Keyframe({joint: -2 * amount}, relative=True)
    over = Keyframe({joint: 2 * amount}, relative=True)
    home = Keyframe({joint: amount}, relative=True)
    return (there,) + (across, over) * (times - 1) + (across, home)


GESTURES: dict[str, Motion] = {
    "wave": (Keyframe({"shoulder_lift": -30.0, "elbow_flex": 60.0,
                       "wrist_flex": 0.0}),)
            + _swing("wrist_flex", 25.0),
    "nod": _swing("wrist_flex", 20.0),
    "shake_no": _swing("wrist_roll", 30.0),
    "dance": (Keyframe({"gripper": 60.0}),)
             + _swing("shoulder_pan", 25.0)
             + _swing("wrist_roll", 40.0, times=1)
             + (Keyframe({"gripper": 0.0}),),
}

SKILLS = sorted([*POSES, *GESTURES])


def number(value, what: str) -> float:
    """`value` as a finite float, or a ValueError the agent can read out."""
    try:
        v = float(value)
    except (TypeError, ValueError):
        raise ValueError(f"{what} must be a number, got {value!r}") from None
    if not math.isfinite(v):
        raise ValueError(f"{what} must be a finite number, got {value!r}")
    return v


def clamp(joint: str, value: float) -> float:
    lo, hi = LIMITS[joint]
    return min(max(value, lo), hi)


def gripper(percent) -> Motion:
    """0 closed, 100 open; anything outside is pinned to the nearest end."""
    return (Keyframe({"gripper": clamp("gripper", number(percent, "percent"))}),)


def nudge(joint: str, amount) -> Motion:
    """Move one body joint by `amount`, relative to where it is."""
    if joint not in BODY:
        raise ValueError(f"unknown joint {joint!r}; use one of {', '.join(BODY)} "
                         f"(set_gripper moves the gripper)")
    return (Keyframe({joint: number(amount, "amount")}, relative=True),)


def named(name: str) -> Motion:
    """A pose or a gesture, by name. Forgiving about case and spaces."""
    key = str(name).strip().lower().replace(" ", "_")
    if key in POSES:
        return (Keyframe(POSES[key]),)
    if key in GESTURES:
        return GESTURES[key]
    raise ValueError(f"unknown skill {name!r}; one of {', '.join(SKILLS)}")
