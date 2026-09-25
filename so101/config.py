"""Settings, read from .env and the environment."""

import os
import sys
from pathlib import Path

from dotenv import load_dotenv

HERE = Path(__file__).resolve().parent


def fix() -> str:
    """Tell the reader what to do, based on whether .env exists yet."""
    if (HERE / ".env").exists():
        return "  fill it in: so101/.env"
    return "  cp so101/.env.example so101/.env    then edit it"


# From THIS directory, not the working directory -- a bare load_dotenv()
# searches upward from wherever you happened to run the script.
load_dotenv(HERE / ".env")

TOKEN = os.getenv("ZRT_TOKEN")
MEETING_ID = os.getenv("ZRT_MEETING_ID")
FPS = int(os.getenv("ZRT_FPS", "30"))

# By name, not a bare subscript: these are read at import, so this message
# is all a reader gets.
if not TOKEN:
    raise SystemExit("set ZRT_TOKEN -- your access token\n" + fix())
if not MEETING_ID:
    raise SystemExit("set ZRT_MEETING_ID -- the room id both ends join\n"
                     + fix())

#: Max change per joint per tick -- a speed limit. At 30 Hz, 12.0 is
#: 360 units/s. Use 2.0 for a first run with an unfamiliar policy.
SLEW = float(os.getenv("ZRT_SLEW", "12.0"))

#: Where `lerobot-calibrate` writes. Several layouts exist across lerobot
#: versions, so ids are collected from all of them.
CALIBRATION = Path(os.getenv("HF_LEROBOT_CALIBRATION",
                             Path.home() / ".cache" / "huggingface"
                             / "lerobot" / "calibration"))

def required(name: str, what: str) -> str:
    """A hardware variable. Read from main(), so the module still imports
    on a machine with no arm."""
    value = os.getenv(name)
    if not value:
        raise SystemExit(f"set {name} -- {what}\n" + fix())
    return value


def device(name: str, what: str) -> str:
    """A variable naming a device node that has to exist. Checked here so an
    unplugged cable reads as one line, not a driver stack trace."""
    path = required(name, what)
    if not Path(path).exists():
        raise SystemExit(
            f"{name} points at\n    {path}\n"
            f"  which is not there. It is unplugged, or it was renumbered --\n"
            f"  {'/dev/cu.usbmodem*' if sys.platform == 'darwin' else '/dev/ttyACM*'}"
            f" follows enumeration order and can change after\n"
            f"  a replug. `lerobot-find-port` identifies the right one.")
    # Two arms on one host is a supported setup, and the way it goes wrong
    # is both variables naming the same port.
    other = "ZRT_LEADER_PORT" if "FOLLOWER" in name else "ZRT_FOLLOWER_PORT"
    if os.getenv(other) == path:
        raise SystemExit(
            f"{name} and {other} are both\n    {path}\n"
            f"  Two arms are two ports. `lerobot-find-port` identifies each "
            f"by\n  having you unplug it.")
    return path


def calibration_id(name: str, *, leader: bool) -> str:
    """A lerobot calibration id -- the name of a file `lerobot-calibrate`
    wrote. A wrong one is not an error to lerobot, it just starts
    calibrating again, so the message lists what this machine has.
    """
    value = os.getenv(name)
    if value:
        return value
    side = "teleoperators" if leader else "robots"
    found = sorted({p.stem for pattern in ("*/*.json", "*.json")
                    for p in (CALIBRATION / side).glob(pattern)})
    have = (f"calibrated on this machine: {', '.join(found)}" if found else
            f"nothing calibrated yet under {CALIBRATION / side} -- "
            f"run `lerobot-calibrate`")
    raise SystemExit(
        f"set {name} -- the lerobot calibration id of the "
        f"{'leader' if leader else 'follower'} arm\n  {have}\n"
        + fix())




def explain(exc: Exception) -> SystemExit | None:
    """Exit cleanly on an SDK error, whose message is already a sentence.
    Anything else keeps its traceback -- that one is a real bug."""
    from zeroruntime.teleops import TeleopError
    if not isinstance(exc, TeleopError):
        return None
    note = ""
    if "Missing motor IDs" in str(exc):
        # lerobot reports which ids are missing, not why all are.
        note = ("\n\nEvery servo is missing, not just some. USB powers the "
                "adapter board but\nNOT the motors. Check the motor supply "
                "first, then the cable to servo 1.")
    return SystemExit(f"{exc}{note}")
