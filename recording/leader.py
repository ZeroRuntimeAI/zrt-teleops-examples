"""
Leader host -- run this on the machine holding the leader arm.

    python leader.py

`leader` is an ordinary lerobot Teleoperator, unmodified.
`SO101LeaderAdapter` wraps it and owns the network session.

Arms as soon as control is granted, unless ALIGN is set. Ctrl-c releases
the deadman -- the far arm holds position, it does not fall.

Needs ZERORUNTIME_AUTH_TOKEN, ZERORUNTIME_MEETING_ID, ZERORUNTIME_LEADER_ID,
ZERORUNTIME_LEADER_PORT -- see .env.example.

RECORDING EPISODES -- single keypresses, no Enter:

    n   new episode
    s   save it, a success
    f   save it, a FAILED attempt (kept, labelled success=false)
    d   discard it (labelled success=null; dropped when building a dataset)
    q   quit (an open episode is discarded)

Every episode carries ZERORUNTIME_TASK (from .env), the text a policy trained on
it is told, e.g. "pick up the cube"; n refuses to start without it. Teleop keeps
running between episodes: s/f/d only close the episode, so you can bring the
arm back to its rest pose and press n for the next one.

SETTINGS -- edit the block below the imports:

    ALIGN           refuse to arm until the arms match within this
    ALIGN_TIMEOUT_S how long to wait for that before giving up
    SYNC_BUFFER_MS  how long to hold a frame for joint interpolation
"""

import os
import select
import sys
import termios
import time
import tty

from lerobot.teleoperators.so_leader import SO101Leader, SO101LeaderConfig

from zeroruntime.teleops import NotAligned
from zeroruntime.teleops.adapters.lerobot import SO101LeaderAdapter

from config import (FPS, MEETING_ID, TOKEN, calibration_id, device,
                    explain)

# ── Settings ───────────────────────────────────────────────────────────────

#: Don't arm until the two arms are this close. None arms immediately,
#: and the follower then travels to the leader's pose at full slew.
ALIGN = None  # arms immediately

#: Bounded, or a gate that never opens reads as a hang.
ALIGN_TIMEOUT_S = 120.0

#: Hold each frame this long so the joints can be interpolated to its
#: capture instant. 0 for a joints-only console.
SYNC_BUFFER_MS = 120.0

#: The episode's task text. From .env so a batch of episodes shares one.
TASK = os.getenv("ZERORUNTIME_TASK", "")

# ───────────────────────────────────────────────────────────────────────────

KEYS = "n new · s save · f failed · d discard · q quit"


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


class Keys:
    """Single keypresses without Enter, read without blocking (POSIX terminals).
    Ctrl-c still raises KeyboardInterrupt: cbreak keeps signals on."""

    def __enter__(self):
        self.fd = sys.stdin.fileno()
        self.saved = termios.tcgetattr(self.fd)
        tty.setcbreak(self.fd)
        return self

    def __exit__(self, *exc):
        termios.tcsetattr(self.fd, termios.TCSADRAIN, self.saved)

    def get(self) -> str | None:
        if select.select([self.fd], [], [], 0)[0]:
            return os.read(self.fd, 1).decode(errors="ignore").lower()
        return None


def arm(remote) -> bool:
    """Hold the deadman, through the ALIGN gate if one is set."""
    if ALIGN is None:
        remote.hold_deadman(True)
        return True
    print(f"move your arm to within {ALIGN} of the follower's and hold it there")
    # Arming is a HOLD, not a keypress: the leader is backdrivable, so
    # releasing it to press a key drops the arm.
    try:
        remote.arm_when_aligned(timeout=ALIGN_TIMEOUT_S, on_status=_progress())
        return True
    except NotAligned as e:
        print(f"never armed: {e}")
        return False


def main() -> None:
    port = device("ZERORUNTIME_LEADER_PORT",
                  "the serial port of the leader arm; "
                  "`lerobot-find-port` finds it")
    leader = SO101Leader(
        SO101LeaderConfig(id=calibration_id("ZERORUNTIME_LEADER_ID", leader=True),
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

    episode, armed = False, False
    counts = {"saved": 0, "failed": 0, "discarded": 0}

    def end(outcome: str, success: bool | None) -> None:
        nonlocal episode
        remote.request_episode("end", success=success)
        episode = False
        counts[outcome] += 1
        print(f"episode {outcome} (saved {counts['saved']}, failed {counts['failed']}, "
              f"discarded {counts['discarded']}). teleop continues -- n for the next one")

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
        armed = arm(remote)
        if armed:
            print("armed. the far arm is now tracking your leader.")
        print(f"task {TASK!r}" if TASK else
              "WARNING: ZERORUNTIME_TASK is not set -- episodes get no task text")
        print(KEYS)

        with Keys() as keys:
            for _ in remote.ticks(hz=FPS):
                remote.observation()  # synced joints + pixels; arms the echo too
                k = keys.get()
                if k == "n" and not episode:
                    if not TASK:
                        print("not starting: set ZERORUNTIME_TASK (e.g. in .env) -- "
                              "an episode without a task can't be trained on")
                        continue
                    if not armed:             # only if arming failed at startup
                        armed = arm(remote)
                    if armed:
                        remote.request_episode("start", TASK)
                        episode = True
                        print(f"episode started: {TASK!r}  ({KEYS})")
                elif k in ("s", "f", "d") and episode:
                    end(*{"s": ("saved", True), "f": ("failed", False),
                          "d": ("discarded", None)}[k])
                elif k == "q":
                    break

    except KeyboardInterrupt:
        pass
    finally:
        if episode:
            remote.request_episode("end", success=None)   # quit mid-episode = discard
            counts["discarded"] += 1
            try:                  # a few more ticks so the close reaches the follower
                for i in remote.ticks(hz=FPS):
                    if i >= FPS // 2:
                        break
            except KeyboardInterrupt:
                pass
        print(f"\nsession: saved {counts['saved']}, failed {counts['failed']}, "
              f"discarded {counts['discarded']}")
        remote.stop()             # releases control; the far arm holds position
        leader.disconnect()


if __name__ == "__main__":
    main()
