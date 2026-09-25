#!/usr/bin/env python3
"""
The operator side of a session, with no operator.

    python leader.py

`FakeLeader` is the SDK's in-process controller: `set_joints()` sits where a
leader arm, a VR headset or a policy would. Everything else is real -- it
joins the room, claims control, and receives the robot's video and joints.

Start `follower.py` first, same ZRT_MEETING_ID. This sweeps one joint;
watch the follower follow it.

Ctrl-c releases the deadman: the far side's watchdog runs out and the arm
holds where it is. It does not fall.

SETTINGS -- edit the block below the imports:

    SWEEP          how far the demo sweep moves, either side of zero
    SWEEP_HZ       how fast it sweeps
    SYNC_BUFFER_MS how long to hold a frame for joint interpolation

Needs ZRT_TOKEN and ZRT_MEETING_ID -- see .env.example.
"""

import math
import time

from zeroruntime.teleops.adapters.fake import FakeLeader

from config import FPS, MEETING_ID, TOKEN

# ── Settings ───────────────────────────────────────────────────────────────

#: Amplitude of the demo sweep, in the units the follower declares.
SWEEP = 60.0

#: Sweep rate, in radians of phase per second.
SWEEP_HZ = 0.5

#: Hold each frame this long so the joints can be interpolated to its
#: capture instant. 0 for a joints-only console.
SYNC_BUFFER_MS = 120.0

# ───────────────────────────────────────────────────────────────────────────


def main() -> None:
    leader = FakeLeader(
        meeting_id=MEETING_ID,
        token=TOKEN,
        publish_hz=FPS,
        sync_buffer_ms=SYNC_BUFFER_MS)

    @leader.on_ready
    def _(desc):
        print(f"robot online: {desc.robot_id}, joints {desc.flat_names()}")

    leader.start()

    if not leader.claim_control(timeout_s=10):
        raise SystemExit("no control: denied, or the robot never answered -- "
                         "is follower.py running in this room?")
    print(f"control granted, schema {leader.schema}")

    leader.hold_deadman(True)
    print("armed. ctrl-c to stop.")
    started = time.monotonic()

    try:
        for i in leader.ticks(hz=FPS):
            # Also stamps the next command with this observation's id, so
            # the robot records which picture caused which move.
            obs = leader.observation()

            if i % FPS == 0:
                print(f"tick {i:5d}  joints={_fmt(obs.joints)}  "
                      f"cameras={list(obs.images)}  sent={leader.commands_sent}")

            # Stands in for an input device.
            leader.set_joints(shoulder_pan=SWEEP * math.sin(
                (time.monotonic() - started) * SWEEP_HZ))
    except KeyboardInterrupt:
        pass
    finally:
        leader.hold_deadman(False)
        leader.stop()


def _fmt(joints) -> str:
    return "{" + ", ".join(f"{n}:{v:6.2f}" for n, v in joints.items()) + "}"


if __name__ == "__main__":
    main()
