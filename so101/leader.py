"""
Leader host -- run this on the machine holding the leader arm.

    python leader.py

`leader` is an ordinary lerobot Teleoperator, unmodified.
`SO101LeaderAdapter` wraps it and owns the network session.

Arms as soon as control is granted, unless ALIGN is set. Ctrl-c releases
the deadman -- the far arm holds position, it does not fall.

Needs ZRT_TOKEN, ZRT_MEETING_ID, ZRT_LEADER_ID, ZRT_LEADER_PORT -- see
.env.example.

SETTINGS -- edit the block below the imports:

    ALIGN           refuse to arm until the arms match within this
    ALIGN_TIMEOUT_S how long to wait for that before giving up
    SYNC_BUFFER_MS  how long to hold a frame for joint interpolation
"""

import sys
import time

from lerobot.teleoperators.so_leader import SO101Leader, SO101LeaderConfig

from zeroruntime.teleops import NotAligned
from zeroruntime.teleops.adapters.lerobot import SO101LeaderAdapter

from config import (FPS, MEETING_ID, TOKEN, calibration_id, device,
                    explain)

# ── Settings ───────────────────────────────────────────────────────────────

#: Don't arm until the two arms are this close. None arms immediately,
#: and the follower then travels to the leader's pose at full slew.
ALIGN = 8.0

#: Bounded, or a gate that never opens reads as a hang.
ALIGN_TIMEOUT_S = 120.0

#: Hold each frame this long so the joints can be interpolated to its
#: capture instant. 0 for a joints-only console.
SYNC_BUFFER_MS = 120.0

# ───────────────────────────────────────────────────────────────────────────



def _progress():
    """Show alignment. Polled ten times a second; print about one of those."""
    last = 0.0

    def on_status(aligned, delta, seconds_left):
        nonlocal last
        now = time.monotonic()
        if now - last < 1.0:
            return
        last = now
        if not delta:
            print("  waiting for the follower's pose")
        elif aligned:
            print(f"  holding steady... {seconds_left:.1f}s")
        else:
            worst = max(delta, key=lambda j: abs(delta[j]))
            print(f"  off by {delta[worst]:+.1f} on {worst}")

    return on_status


def main() -> None:
    port = device("ZRT_LEADER_PORT",
                  "the serial port of the leader arm; "
                  "`lerobot-find-port` finds it")
    leader = SO101Leader(
        SO101LeaderConfig(id=calibration_id("ZRT_LEADER_ID", leader=True),
                          port=port)
    )

    remote = SO101LeaderAdapter(
        MEETING_ID,
        teleop=leader,
        token=TOKEN,
        # Unset means arming never blocks. Set it and the far arm cannot
        # jump to meet a leader standing somewhere else.
        max_misalignment=ALIGN,
        sync_buffer_ms=SYNC_BUFFER_MS,
    )

    try:
        leader.connect()          # local arm; the SDK doesn't own this bus
    except Exception as exc:
        raise explain(exc) or exc
    remote.start()                # join the room

    try:
        if not remote.claim_control():
            sys.exit(f"no lease in {MEETING_ID}.\n"
                     f"  Usually no follower is in the room -- start "
                     f"follower.py on the robot\n  first. Otherwise another "
                     f"leader holds control, or the follower is a\n"
                     f"  different shape: quickstart/follower.py announces "
                     f"degrees in\n  declaration order, an SO-101 announces "
                     f"normalized and sorted.")

        print(f"control granted, schema {remote.schema}")

        if ALIGN is None:
            remote.hold_deadman(True)
        else:
            print(f"move your arm to within {ALIGN} of the follower's "
                  f"and hold it there")
            # Arming is a HOLD, not a keypress: the leader is
            # backdrivable, so releasing it to press a key drops the arm.
            try:
                remote.arm_when_aligned(timeout=ALIGN_TIMEOUT_S,
                                        on_status=_progress())
            except NotAligned as e:
                sys.exit(f"never armed: {e}")

        print("armed. the far arm is now tracking your leader. ctrl-c to stop.")

        for _ in remote.ticks(hz=FPS):
            remote.observation()  # synced joints + pixels; arms the echo too

    except KeyboardInterrupt:
        pass
    finally:
        remote.stop()             # releases control; the far arm holds position
        leader.disconnect()


if __name__ == "__main__":
    main()
