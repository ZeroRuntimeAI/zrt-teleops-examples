#!/usr/bin/env python3
"""
The robot side of a session, with no robot -- but with your real cameras.

    python follower.py

`FakeFollower` is the SDK's in-process arm: six joints that lag toward
whatever they are commanded. Everything else is real, including the video --
whatever cameras this machine has are opened and published.

Run `leader.py` against it in another terminal, same ZRT_MEETING_ID.

Needs ZRT_TOKEN and ZRT_MEETING_ID (see .env.example), and opencv for the
cameras: pip install opencv-python.

SETTINGS -- edit the block below the imports:

    MAX_CAMERAS   how many cameras to open (None = all, 0 = joints only)
    WIDTH, HEIGHT what each camera is asked for
    SLEW          speed limit, per joint per tick
"""

import sys

from zeroruntime.teleops import CameraConfig, SafetyConfig, available_cameras
from zeroruntime.teleops.adapters.fake import FakeFollower
from zeroruntime.teleops.capture import ThreadedCameras

from config import FPS, MEETING_ID, TOKEN

# ── Settings ───────────────────────────────────────────────────────────────

#: How many of this machine's cameras to open. None opens all of them,
#: 0 opens none and the session carries joints only.
MAX_CAMERAS = None

#: What each camera is asked for. It gives the nearest thing it can.
WIDTH, HEIGHT = 640, 480

#: Max change per joint per tick -- a speed limit. At 30 Hz, 2.0 is
#: 60 units/s.
SLEW = 2.0

# ───────────────────────────────────────────────────────────────────────────


class FakeArm(FakeFollower):
    """`FakeFollower`, plus cameras this process owns.

    `push_camera_configs()` declares cameras the SDK does not capture
    itself -- a simulator, a ROS topic, or a Mac, which has no V4L2 device
    node to name. Copy this to publish frames from your own source.
    """

    def __init__(self, labels, **kw) -> None:
        self._labels = list(labels)      # before super(): it calls the below
        super().__init__(**kw)                  # LAST

    def push_camera_configs(self) -> list:
        return [CameraConfig(l, label=l, width=WIDTH, height=HEIGHT, fps=FPS)
                for l in self._labels]


class Camera:
    """A `cv2.VideoCapture` behind the four members `ThreadedCameras` reads.

    `color_mode` matters: cv2 returns BGR, and publishing it as RGB swaps
    the red and blue channels without raising an error.
    """

    color_mode = "bgr"

    def __init__(self, target) -> None:
        self._target = target
        self._cap = None
        self.connect()

    def connect(self) -> None:
        import cv2
        self._cap = cv2.VideoCapture(self._target)
        if not self._cap.isOpened():
            self._cap.release()
            self._cap = None
            raise OSError("would not open")
        self._cap.set(cv2.CAP_PROP_FRAME_WIDTH, WIDTH)
        self._cap.set(cv2.CAP_PROP_FRAME_HEIGHT, HEIGHT)
        # Newest frame, not the oldest queued one -- otherwise the picture
        # falls further behind the arm the longer the session runs.
        self._cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)

    def disconnect(self) -> None:
        if self._cap is not None:
            self._cap.release()
            self._cap = None

    def async_read(self, timeout_ms: float | None = None):
        """None on a bad read -- the capture thread backs off and retries."""
        if self._cap is None:
            return None
        ok, img = self._cap.read()
        return img if ok else None


def open_cameras(limit: int | None = None) -> dict:
    """Open every camera this machine has, as `{label: Camera}`.

    Use `available_cameras()`, not an index scan: on macOS the display is
    enumerated as a video device after the real cameras, so probing indices
    can publish the desktop instead of a camera.
    """
    try:
        import cv2                              # noqa: F401
    except ImportError:
        raise SystemExit("cameras need opencv: pip install opencv-python, "
                         "or set MAX_CAMERAS = 0 at the top of this file")

    found = available_cameras()
    if not found:
        print("no cameras on this machine -- publishing joints only")
        return {}

    cams = {}
    for i, d in enumerate(found[:limit]):
        # d.name is the handle: an index on macOS, a by-path name on Linux.
        target = int(d.name) if sys.platform == "darwin" else d.node
        label = f"cam{i}"
        try:
            cams[label] = Camera(target)
        except OSError as e:
            print(f"  {d.node}: {e}, skipping")
            continue
        print(f"  {label}: {d.node}")
    return cams


def main() -> None:
    cams = {} if MAX_CAMERAS == 0 else open_cameras(MAX_CAMERAS)

    follower = FakeArm(
        cams,
        meeting_id=MEETING_ID,
        token=TOKEN,
        safety=SafetyConfig(slew=SLEW, watchdog_timeout_s=0.5),
        control_hz=FPS,
        observation_hz=10)

    @follower.on_ready
    def _(desc):
        print(f"robot ready in {MEETING_ID}: {desc.robot_id}")
        print(f"  joints  {desc.flat_names()}")
        print(f"  cameras {follower.cameras.labels or '[] (joints only)'}")

    @follower.on_safe_state
    def _(state, reason):
        print(f"  state: {state.value}" + (f" ({reason.value})" if reason else ""))

    @follower.on_control_granted
    def _(lease, holder):
        print(f"  control granted to {holder}")

    seen = set()

    @follower.on_applied
    def _(action):
        # A held command re-applies every tick; only a new id is new intent.
        if action.command_id in seen:
            return
        seen.add(action.command_id)
        if len(seen) % FPS == 0:
            print(f"  applied {action.command_id} <- observation "
                  f"{action.observation_id}")

    # One thread per camera -- a cv2 read blocks 25-50 ms, too long for the
    # control loop. Started after the session: the frame bank comes with it.
    capture = ThreadedCameras(follower, cams) if cams else None

    follower.start()
    if capture:
        capture.start()
    try:
        for _ in follower.ticks(hz=FPS):
            pass
    except KeyboardInterrupt:
        pass
    finally:
        if capture:
            capture.stop()
            print(f"capture: pushed {dict(capture.pushed)} "
                  f"missed {dict(capture.missed)}")
        follower.stop()
        for cam in cams.values():
            cam.disconnect()


if __name__ == "__main__":
    main()
