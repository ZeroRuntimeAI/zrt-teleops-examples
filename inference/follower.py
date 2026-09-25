#!/usr/bin/env python3
"""
Follower host -- run this on the machine holding the arm.

    python follower.py

`arm` is an ordinary lerobot Robot, unmodified. `SO101FollowerAdapter` wraps
it and owns the network session: joining the room, publishing joints and
video, and clamping incoming actions before applying them.

Nothing here touches the servo bus -- lerobot stays the only owner. And
nothing here knows a policy is driving: this is the same follower a human
operator talks to, which is the point.

Every attached camera is published. Name them with CAMERA_LABELS below --
the policy looks its cameras up by name, so these must match its checkpoint.

Needs ZRT_TOKEN, ZRT_MEETING_ID, ZRT_FOLLOWER_ID, ZRT_FOLLOWER_PORT -- see
.env.example.

SETTINGS -- edit the block below the imports:

    CAMERA_LABELS      what to call the cameras that are found
    SLEW               speed limit, per joint per tick
    WIDTH, HEIGHT      what each camera is asked for
    FOURCC             camera pixel format
    WATCHDOG_TIMEOUT_S how long silence may last before the arm holds
"""

import os
import sys
from pathlib import Path

from dotenv import load_dotenv
from lerobot.cameras.opencv import OpenCVCameraConfig
from lerobot.robots.so_follower import SO101Follower, SO101FollowerConfig

from zeroruntime.teleops import (FailsafeAction, SafetyConfig, TeleopError,
                                 available_cameras)
from zeroruntime.teleops.adapters.lerobot import SO101FollowerAdapter

HERE = Path(__file__).resolve().parent

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

#: Max change per joint per tick -- a speed limit. At 30 Hz, 12.0 is
#: 360 units/s. Use 2.0 for a first run with an unfamiliar policy.
SLEW = 12.0

#: What each camera is asked for.
WIDTH, HEIGHT = 640, 480

#: Not optional with two cameras on one USB 2.0 bus: raw YUYV is ~18 MB/s
#: each and the second fails to open.
FOURCC = "MJPG"

#: Silence for this long and the arm holds where it is.
WATCHDOG_TIMEOUT_S = 0.5

# ───────────────────────────────────────────────────────────────────────────

# From THIS directory, not the working directory -- a bare load_dotenv()
# searches upward from wherever you happened to run the script.
load_dotenv(HERE / ".env")

#: Where `lerobot-calibrate` writes. Several layouts exist across versions.
CALIBRATION = Path(os.getenv("HF_LEROBOT_CALIBRATION",
                             Path.home() / ".cache" / "huggingface"
                             / "lerobot" / "calibration"))



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


def _handle(d):
    """An index on macOS, a by-path name on Linux."""
    return int(d.name) if sys.platform == "darwin" else d.path


def find_cameras() -> dict:
    """Every attached camera, as `{label: handle}`.

    Named by CAMERA_LABELS in discovery order, falling back to cam0, cam1...
    """
    found = [d for d in available_cameras() if works(_handle(d))]
    return {(CAMERA_LABELS[i] if i < len(CAMERA_LABELS) else f"cam{i}"):
            _handle(d) for i, d in enumerate(found)}


def fix() -> str:
    """Tell the reader what to do, based on whether .env exists yet."""
    if (HERE / ".env").exists():
        return "  fill it in: inference/.env"
    return "  cp inference/.env.example inference/.env    then edit it"


def need(name: str, what: str) -> str:
    value = os.getenv(name)
    if not value:
        raise SystemExit(f"set {name} -- {what}\n" + fix())
    return value


def device(name: str, what: str) -> str:
    """A variable naming a device node that has to exist. Checked here so an
    unplugged cable reads as one line, not a driver stack trace."""
    path = need(name, what)
    if not Path(path).exists():
        raise SystemExit(
            f"{name} points at\n    {path}\n"
            f"  which is not there. It is unplugged, or it was renumbered --\n"
            f"  {'/dev/cu.usbmodem*' if sys.platform == 'darwin' else '/dev/ttyACM*'}"
            f" follows enumeration order and can change after\n"
            f"  a replug. `lerobot-find-port` identifies the right one.")
    return path


def calibration_id(name: str) -> str:
    """A lerobot calibration id -- the name of a file `lerobot-calibrate`
    wrote. A wrong one just starts calibrating again, so list what is here."""
    value = os.getenv(name)
    if value:
        return value
    found = sorted({p.stem for pattern in ("*/*.json", "*.json")
                    for p in (CALIBRATION / "robots").glob(pattern)})
    have = (f"calibrated on this machine: {', '.join(found)}" if found else
            f"nothing calibrated yet under {CALIBRATION / 'robots'} -- "
            f"run `lerobot-calibrate`")
    raise SystemExit(f"set {name} -- the lerobot calibration id of the arm\n"
                     f"  {have}\n" + fix())


def explain(exc: Exception) -> SystemExit | None:
    """Exit cleanly on an SDK error, whose message is already a sentence.
    Anything else keeps its traceback -- that one is a real bug."""
    if not isinstance(exc, TeleopError):
        return None
    note = ""
    if "Missing motor IDs" in str(exc):
        # lerobot reports which ids are missing, not why all are.
        note = ("\n\nEvery servo is missing, not just some. USB powers the "
                "adapter board but\nNOT the motors. Check the motor supply "
                "first, then the cable to servo 1.")
    return SystemExit(f"{exc}{note}")


TOKEN = need("ZRT_TOKEN", "your access token")
MEETING_ID = need("ZRT_MEETING_ID", "the room the policy will join")
FPS = int(os.getenv("ZRT_FPS", "30"))


def main() -> None:
    # Here, not at import: this opens each device briefly to see whether it
    # is really a camera, and importing a module should open nothing.
    cameras = find_cameras()

    arm = SO101Follower(
        SO101FollowerConfig(
            id=calibration_id("ZRT_FOLLOWER_ID"),
            port=device("ZRT_FOLLOWER_PORT",
                        "the serial port of the arm; `lerobot-find-port` "
                        "finds it"),
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
    print(f"  slew    {SLEW} per tick ({SLEW * FPS:.0f} units/s at {FPS} Hz)")

    try:
        follower.run(hz=FPS)      # start(), loop, stop() -- ctrl-c is handled
    except Exception as exc:
        raise explain(exc) or exc


if __name__ == "__main__":
    main()
