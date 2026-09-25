"""
Follower host -- run this on the machine holding the follower arm.

    python follower.py

`arm` is an ordinary lerobot Robot, unmodified. `SO101FollowerAdapter` wraps
it and owns the network session: joining the room, publishing joints and
video, and clamping incoming actions before applying them.

Nothing here touches the servo bus -- lerobot stays the only owner.

Every attached camera is published. Name them with CAMERA_LABELS below --
a policy looks its cameras up by name.

Needs ZRT_TOKEN, ZRT_MEETING_ID, ZRT_FOLLOWER_ID, ZRT_FOLLOWER_PORT -- see
.env.example.

SETTINGS -- edit the block below the imports:

    CAMERA_LABELS      what to call the cameras that are found
    WIDTH, HEIGHT      what each camera is asked for
    FOURCC             camera pixel format
    WATCHDOG_TIMEOUT_S how long silence may last before the arm holds

`slew` is ZRT_SLEW in .env, because it is the one number that changes per
run rather than per rig.
"""

import os
import sys

from lerobot.cameras.opencv import OpenCVCameraConfig
from lerobot.robots.so_follower import SO101Follower, SO101FollowerConfig

from zeroruntime.teleops import (FailsafeAction, SafetyConfig,
                             available_cameras)
from zeroruntime.teleops.adapters.lerobot import SO101FollowerAdapter

from config import (FPS, MEETING_ID, SLEW, TOKEN, calibration_id,
                    device, explain)


def works(handle) -> bool:
    """Does this handle actually deliver a picture?

    `available_cameras()` lists every V4L2 capture node, which on a Pi
    includes the hardware codec and the image pipeline. Neither is a camera.
    """
    import cv2
    cap = (cv2.VideoCapture(handle, cv2.CAP_V4L2)
           if sys.platform.startswith("linux") else cv2.VideoCapture(handle))
    ok = cap.isOpened() and cap.read()[0]
    cap.release()
    return ok


def find_cameras() -> dict:
    """Every attached camera, as `{label: handle}`.

    Named by CAMERA_LABELS in discovery order, falling back to cam0, cam1...
    """
    found = [d for d in available_cameras() if works(_handle(d))]
    return {(CAMERA_LABELS[i] if i < len(CAMERA_LABELS) else f"cam{i}"):
            _handle(d) for i, d in enumerate(found)}


def _handle(d):
    """An index on macOS, a by-path name on Linux."""
    return int(d.name) if sys.platform == "darwin" else d.path


# ── Settings ───────────────────────────────────────────────────────────────

#: Names for the cameras that are found, in discovery order. A policy looks
#: its cameras up by NAME, so these must match what its checkpoint expects
#: (SmolVLA checkpoints usually want camera1, camera2, ...). Anything beyond
#: this list is named cam2, cam3, ... Empty means cam0, cam1, ... throughout,
#: which is fine for teleoperation, where nothing reads the names.
#:
#: Discovery order follows the device list, NOT which camera is which. Check
#: the mapping printed at startup and reorder if a replug shuffled them.
CAMERA_LABELS: list[str] = []

#: What each camera is asked for.
WIDTH, HEIGHT = 640, 480

#: Not optional with two cameras on one USB 2.0 bus: raw YUYV is ~18 MB/s
#: each and the second camera fails to open.
FOURCC = "MJPG"

#: Silence for this long and the arm holds where it is.
WATCHDOG_TIMEOUT_S = 0.5

# ───────────────────────────────────────────────────────────────────────────


def main() -> None:
    # Here, not at import: this opens each device briefly to see whether it
    # is really a camera, and importing a module should open nothing.
    cameras = find_cameras()

    port = device("ZRT_FOLLOWER_PORT",
                  "the serial port of the follower arm; "
                  "`lerobot-find-port` finds it")
    arm = SO101Follower(
        SO101FollowerConfig(
            id=calibration_id("ZRT_FOLLOWER_ID", leader=False),
            port=port,
            cameras={
                name: OpenCVCameraConfig(index_or_path=handle, fps=FPS,
                                         width=WIDTH, height=HEIGHT,
                                         fourcc=FOURCC)
                for name, handle in cameras.items()
            },
        )
    )

    # Slew, watchdog and e-stop sit inside the control loop -- tick() is the
    # only path to the motors, so there is no wrapper to forget.
    follower = SO101FollowerAdapter(
        MEETING_ID,
        robot=arm,
        token=TOKEN,
        safety=SafetyConfig(
            # ZRT_SLEW. Re-derive on your own arm: too low limits the
            # operator's motion, too high lets a bad reading through.
            slew=SLEW,
            watchdog_timeout_s=WATCHDOG_TIMEOUT_S,
            # HOLD, not TORQUE_OFF: cutting torque drops a loaded arm.
            on_starvation=FailsafeAction.HOLD,
        ),
    )

    @follower.on_safe_state
    def _(state, reason):
        print(f"  safety: {state.value}" + (f" ({reason.value})" if reason else ""))

    @follower.on_rejected
    def _(seq, why):
        print(f"  rejected seq={seq}: {why}")

    print(f"robot ready in {MEETING_ID}")
    print(f"  joints  {follower.joints}")
    for label, handle in cameras.items():
        print(f"  camera  {label:<16} {str(handle).split('/')[-1][:44]}")
    if not cameras:
        print("  cameras [] (none attached)")
    print(f"  slew    {SLEW} per tick ({SLEW * FPS:.0f} units/s at {FPS} Hz)")

    try:
        follower.run(hz=FPS)      # start(), loop, stop() -- ctrl-c is handled
    except Exception as exc:
        raise explain(exc) or exc


if __name__ == "__main__":
    main()
