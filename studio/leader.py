#!/usr/bin/env python3
"""
Drive the ZeroRuntime Studio robot from Python.

    pip install -r requirements.txt
    export ZERORUNTIME_AUTH_TOKEN=...
    export ZERORUNTIME_MEETING_ID=...      # the room id Studio shows
    python leader.py

Studio's browser tab is a real `zeroruntime-teleops` follower (robot id
"studio-so101"). This is an ordinary Leader: it claims control of that tab,
holds the deadman, and swings `shoulder_pan` for a few seconds. If the simulated
arm moves, Studio speaks the same protocol a real rig does.

Start Studio first and copy its room id. Ctrl-c releases the deadman: the
simulated arm holds where it is.

SETTINGS -- edit the block below the imports:

    CLAIM_TIMEOUT_S  how long to wait for Studio to grant control
    DRIVE_S          how long to drive before letting go
    WAVE_DEG         how far shoulder_pan swings, either side of home
    WAVE_HZ          how fast it swings
"""

import math
import os
from time import monotonic

from zeroruntime.teleops import Leader, Units, single_group_descriptor

# ── Settings ───────────────────────────────────────────────────────────────

CLAIM_TIMEOUT_S = 10.0
DRIVE_S = 20.0

#: Swing of shoulder_pan, in the units the follower declares.
WAVE_DEG = 20.0

#: Swings per second.
WAVE_HZ = 0.25

#: How often this leader publishes. Free to differ from Studio's 100 Hz control_hz: the
#: schema hash covers the joint groups only, so the rate never affects the grant.
FPS = 30

# ───────────────────────────────────────────────────────────────────────────

#: Alphabetical: the order Studio's schema hashes them in.
JOINTS = ("elbow_flex", "gripper", "shoulder_lift", "shoulder_pan",
          "wrist_flex", "wrist_roll")

#: The SO-101 rest pose, in LeRobot units.
HOME = {"shoulder_pan": 0.0, "shoulder_lift": -60.0, "elbow_flex": 60.0,
        "wrist_flex": 35.0, "wrist_roll": 0.0, "gripper": 30.0}


class StudioLeader(Leader):
    """A leader with no operator: HOME, with shoulder_pan on a sine wave."""

    target_robot_id = "studio-so101"

    def __init__(self, *args, **kw) -> None:
        # Before super().__init__(), which may call into this object.
        self.wave_t0 = monotonic()
        super().__init__(*args, **kw)

    @staticmethod
    def descriptor_static():
        return single_group_descriptor("studio-leader", "lerobot", JOINTS,
                                       control_hz=FPS, units=Units.NORMALIZED)

    def descriptor(self):
        return self.descriptor_static()

    def read_joints(self):
        t = monotonic() - self.wave_t0
        return {**HOME,
                "shoulder_pan": WAVE_DEG * math.sin(2 * math.pi * WAVE_HZ * t)}


def main() -> None:
    token = os.environ.get("ZERORUNTIME_AUTH_TOKEN")
    meeting_id = os.environ.get("ZERORUNTIME_MEETING_ID")
    if not token:
        raise SystemExit("set ZERORUNTIME_AUTH_TOKEN -- your access token")
    if not meeting_id:
        raise SystemExit("set ZERORUNTIME_MEETING_ID -- the room id Studio shows")

    leader = StudioLeader(meeting_id, token=token, publish_hz=FPS)
    leader.start()
    try:
        if not leader.claim_control(timeout_s=CLAIM_TIMEOUT_S):
            raise SystemExit("no control: denied, or Studio never answered -- "
                             "is the Studio tab open in this room?")
        print(f"control granted, schema {leader.schema}")

        # The wave starts at HOME, so arming does not make the arm jump.
        leader.wave_t0 = monotonic()
        leader.hold_deadman(True)
        deadline = leader.wave_t0 + DRIVE_S
        for _ in leader.ticks(hz=FPS):
            if monotonic() >= deadline:
                break
    except KeyboardInterrupt:
        pass
    finally:
        leader.hold_deadman(False)
        leader.stop()


if __name__ == "__main__":
    main()
