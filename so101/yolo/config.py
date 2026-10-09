"""Rig constants shared by every script. Values set to None are unknown until measured on
the real hardware. Scripts refuse to run until the values they need are filled in."""
from pathlib import Path

# --- Frames come from the teleop session, not the cameras: capture.py joins the room as a
# watch-only peer (see capture.py). Room id + token are read from so101/.env.
SDK_ENV = Path(__file__).resolve().parent.parent / ".env"
WATCH_HZ = 10

# Our camera name -> the label follower.py publishes. follower.py names cameras cam0, cam1, ...
# in USB-port order (/dev/v4l/by-path, sorted): port 2.1 = top, 2.3 = wrist, 2.4 = side.
# Stable while the cables stay in the same ports. Never rename our keys: stage 2/3 use them.
CAMERAS = {"top": "cam0", "wrist": "cam1", "side": "cam2"}
FIXED_CAMS = ("top", "side")
WRIST_CAM = "wrist"

# --- YOLO
YOLO_CLASSES = ("cube", "box")  # label exactly these names in the labelling tool
YOLO_CONF = 0.5

# --- State rules (plan.md 1.6). All boxes and regions are normalized 0..1 (x1, y1, x2, y2).
# "Holding" = wrist-cam cube centre inside WRIST_HOLD_ROI. The wrist cam is rigid on the gripper,
# so a held cube always lands in the same spot. `python split.py` prints a suggested value.
WRIST_HOLD_ROI = None
# Optional: also require gripper.pos (0..100) inside this (min, max) band, which fixes
# "open fingers around the cube" false holds. Read the values from capture.py's status line.
GRIP_HOLD_BAND = None
DEBOUNCE_N = 5  # consecutive agreeing frames before the state switches
