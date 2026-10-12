"""Rig constants shared by every script. Values set to None are unknown until measured on
the real hardware. Scripts refuse to run until the values they need are filled in."""
from pathlib import Path

# --- Frames come from the teleop session, not the cameras: capture.py joins the room as a
# watch-only peer (see capture.py). Room id + token are read from so101/.env.
SDK_ENV = Path(__file__).resolve().parent.parent / ".env"
WATCH_HZ = 10

# Our camera name -> the label follower.py publishes. follower.py names cameras by USB port
# (CAMERA_PORTS), using pi0.5's own names, which are also the dataset's camera keys.
CAMERAS = {"top": "base_0_rgb", "wrist": "left_wrist_0_rgb", "side": "right_wrist_0_rgb"}
FIXED_CAMS = ("top", "side")
WRIST_CAM = "wrist"

# --- YOLO
YOLO_CLASSES = ("cube", "box")  # label exactly these names in the labelling tool
YOLO_CONF = 0.5

# --- State rules (plan.md 1.6). All boxes and regions are normalized 0..1 (x1, y1, x2, y2).
# "Holding" = wrist-cam cube centre inside WRIST_HOLD_ROI. The wrist cam is rigid on the gripper,
# so a held cube always lands in the same spot. `python split.py` prints a suggested value.
WRIST_HOLD_ROI = (0.43, 0.43, 0.56, 0.64)  # split.py suggested (0.469, 0.478, 0.516, 0.588); widened for YOLO jitter
# Optional: also require gripper.pos (0..100) inside this (min, max) band, which fixes
# "open fingers around the cube" false holds. Read the values from capture.py's status line.
GRIP_HOLD_BAND = (8.0, 13.0)  # measured: closed empty ~2.3, closed on cube ~10.3, open 20-85
DEBOUNCE_N = 5  # consecutive agreeing frames before the state switches
LOST_S = 15.0  # fallback: seconds of "can't tell" before NO_CUBE (longest arm-over-box gap seen: 9.5 s)
