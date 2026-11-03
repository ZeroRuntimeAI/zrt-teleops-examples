"""
Where things are on a REAL table: one fixed camera, a vision model that points
at what you name, and a homography from that camera's pixels onto the arm's
table plane. The result is the `scene` dict studio/agent/planner.py plans from,
so the real arm and the simulated one share one pick-and-place.

Calibrate once with calibrate_table.py (writes table_calibration.json next to
this file). Pointing needs GOOGLE_API_KEY: the voice pipeline's own model is
managed inference and can only speak, not hand pixels back to code.

Units: pixels (u right, v down) on the camera frame; metres in the arm's base
frame, z up, table top at z=0.
"""

import functools
import json
import os
from pathlib import Path

import cv2
import numpy as np

CALIBRATION = Path(__file__).with_name("table_calibration.json")

#: The follower's camera to point in: fixed, looking across the table.
CAMERA = os.getenv("ZERORUNTIME_TABLE_CAMERA", "top")
#: Gemini model for pointing: answers [y, x] in 0-1000 natively. The lite
#: model answers in ~2 s and lands within a few pixels of the big one, which
#: took 30-180 s per call (and 504s) when measured.
MODEL = os.getenv("ZERORUNTIME_GROUNDING_MODEL", "gemini-3.5-flash-lite")
#: Tried in turn when one is overloaded (503) or rate-limited (429).
MODELS = (MODEL, *(m for m in ("gemini-3.1-flash-lite", "gemini-3.5-flash-lite") if m != MODEL))

#: A 3 cm cube: its center, and its top face (what the model points at).
# ponytail: one cube size; measure yours and change these numbers.
CUBE_Z = 0.015
CUBE_TOP_Z = 0.03
#: Where things are put: what the model is asked to point at, and how high
#: that point is. The camera looks across the table, so 3 cm of height moves
#: a pixel several cm on the table. The box top was measured by sysid.py
#: from teleoperated releases.
TARGET = os.getenv("ZERORUNTIME_TARGET_NAME", "brown cardboard box")
TARGET_POINT = "the center of the top face of the " + TARGET
TARGET_Z = float(os.getenv("ZERORUNTIME_TARGET_Z", "0.053"))
#: The planes calibrate_table.py measures: the cube's top and 7 cm (a bowl's
#: rim, when it was measured). Anything else is read along the camera ray.
PLANES = (CUBE_TOP_Z, 0.07)

#: The closed fingertips, for pointing at: one tip, not two (open jaws made
#: the model pick either one, 1.6 cm rms instead of 0.7).
TIP = "the very tip of the robot gripper's fingers, the lowest point of the gripper"

#: Targets outside this box are refused before IK sees them: a mis-pointed
#: pixel must not send the arm into its own base or off the table.
REACH_X = (0.08, 0.43)   # a sanity box: the planner decides what is really reachable
REACH_Y = (-0.26, 0.26)


class TableError(RuntimeError):
    """Said out loud: no calibration, nothing seen, or out of bounds."""


def to_bgr(frame) -> np.ndarray:
    """A received I420 frame as (h, w, 3) BGR."""
    return cv2.cvtColor(frame.array, cv2.COLOR_YUV2BGR_I420)


def to_jpeg(bgr: np.ndarray) -> bytes:
    return cv2.imencode(".jpg", bgr, [cv2.IMWRITE_JPEG_QUALITY, 90])[1].tobytes()


def snapshot(leader, camera: str = CAMERA, wait_s: float = 2.0) -> np.ndarray:
    """The newest frame from `camera`, as BGR. One observation does not
    always carry every camera, so this looks again for up to `wait_s`."""
    import time
    deadline = time.monotonic() + wait_s
    while True:
        obs = leader.observation()
        try:
            frame = obs.images.get(camera)
            if frame is not None:
                return to_bgr(frame).copy()
            have = ", ".join(obs.images) or "none yet"
        finally:
            for f in obs.images.values():
                f.release()
        if time.monotonic() > deadline:
            raise TableError(f"no frame from camera {camera!r} (have: {have})")
        time.sleep(0.1)


# ── pointing ───────────────────────────────────────────────────────────────

def parse_points(text: str, width: int, height: int) -> dict[str, tuple[float, float] | None]:
    """Gemini's JSON {"key": [y, x] | null} (0-1000) into pixel (u, v)."""
    try:
        raw = json.loads(text)
    except ValueError:
        raise TableError(f"pointing answered {text[:80]!r}, not JSON") from None
    if isinstance(raw, list) and all(isinstance(r, dict) for r in raw):
        raw = {k: v for r in raw for k, v in r.items()}      # 3.5 Flash-Lite: [{"box": [y, x]}]
    if not isinstance(raw, dict):
        raise TableError(f"pointing answered {text[:80]!r}, not an object")
    out = {}
    for key, val in raw.items():
        if val is None:
            out[key] = None
            continue
        if isinstance(val, dict):            # some answers wrap: {"point": [y, x]}
            val = val.get("point") or val.get("position") or val.get("xy")
        try:
            y, x = (float(v) for v in val[:2])
        except (TypeError, ValueError):
            raise TableError(f"pointing answered {val!r} for {key}") from None
        out[key] = (x / 1000.0 * width, y / 1000.0 * height)
    return out


@functools.cache
def _client():
    """One client per process: a throwaway one is closed under the request."""
    from google import genai
    return genai.Client()


def point_at(bgr: np.ndarray, things: dict[str, str]) -> dict[str, tuple[float, float] | None]:
    """Where each thing is in the image. `things` maps a key to what to look
    for ("the center of the top face of the orange cube"). Pixel (u, v) per
    key, None for one that is not in view."""
    from google.genai import types

    h, w = bgr.shape[:2]
    asks = "; ".join(f'"{k}": {what}' for k, what in things.items())
    prompt = (f"Point to each of these in the image: {asks}. Answer with JSON "
              f"only, one entry per key: {{\"<key>\": [y, x]}} with y and x "
              f"normalized to 0-1000, or null when it is not in the image.")
    from google.genai import errors

    image = types.Part.from_bytes(data=to_jpeg(bgr), mime_type="image/jpeg")
    # 503 "high demand" lasts minutes on one model while another answers in
    # under a second: a short retry, then the next model.
    config = types.GenerateContentConfig(
        response_mime_type="application/json", temperature=0,
        http_options=types.HttpOptions(timeout=15000, retry_options=types.HttpRetryOptions(
            attempts=2, initial_delay=1.0, max_delay=4.0)))
    for i, model in enumerate(MODELS):
        try:
            resp = _client().models.generate_content(model=model, contents=[image, prompt],
                                                     config=config)
            break
        except errors.APIError as exc:          # overloaded or rate-limited: next model
            if exc.code not in (429, 500, 503, 504) or i == len(MODELS) - 1:
                raise
        except Exception as exc:                # a timeout or dropped connection: same
            if "timed out" not in str(exc).lower() and "connect" not in str(exc).lower() \
                    or i == len(MODELS) - 1:
                raise
    pts = parse_points(resp.text, w, h)
    missing = [k for k in things if k not in pts]
    if missing:
        raise TableError(f"pointing left out {', '.join(missing)}")
    return pts


# ── the table plane ────────────────────────────────────────────────────────

#: A calibration point further off than this (metres) is a mispointed frame
#: (the model picked the wrist camera once), not geometry: left out.
OUTLIER_M = 0.015


def fit_plane(pixels, xys) -> tuple[np.ndarray, float, list[int]]:
    """Homography from >= 4 (u, v) -> (x, y) pairs on one plane, fit on the
    points that agree with each other; its RMS error in metres on those, and
    the indices it left out."""
    px = np.asarray(pixels, dtype=np.float32).reshape(-1, 1, 2)
    xy = np.asarray(xys, dtype=np.float32).reshape(-1, 1, 2)
    if len(px) < 4:
        raise TableError(f"need at least 4 points to fit, have {len(px)}")
    H, mask = cv2.findHomography(px, xy, cv2.RANSAC, OUTLIER_M)
    if H is None:
        raise TableError("the points are degenerate (all on a line?)")
    inliers = mask.ravel().astype(bool)
    back = cv2.perspectiveTransform(px.astype(np.float64), H).reshape(-1, 2)
    err = np.sum((back - xy.reshape(-1, 2)) ** 2, axis=1)
    rms = float(np.sqrt(np.mean(err[inliers])))
    return H, rms, [int(i) for i in np.nonzero(~inliers)[0]]


class Table:
    """Pixels on the calibrated camera to (x, y) at a height above the table.

    One homography per calibrated plane. A pixel is a ray from the camera,
    so between (or beyond) two planes its (x, y) is linear in z: two planes
    give every height."""

    def __init__(self, planes: dict[float, np.ndarray], camera: str = CAMERA,
                 image_size: tuple[int, int] = (640, 480)) -> None:
        if not planes:
            raise TableError("no calibrated planes")
        self.planes = {float(z): np.asarray(H, dtype=float).reshape(3, 3)
                       for z, H in planes.items()}
        self.camera = camera
        self.image_size = tuple(image_size)

    @classmethod
    def load(cls, path: Path = CALIBRATION) -> "Table":
        if not path.exists():
            raise TableError(f"the table is not calibrated: run voice/calibrate_table.py "
                             f"(writes {path.name})")
        d = json.loads(path.read_text())
        return cls({p["z"]: p["H"] for p in d["planes"]}, d["camera"], tuple(d["image_size"]))

    def _on_plane(self, u: float, v: float, H: np.ndarray) -> np.ndarray:
        return cv2.perspectiveTransform(np.array([[[u, v]]], dtype=np.float64), H)[0, 0]

    def to_xy(self, u: float, v: float, z: float = CUBE_TOP_Z) -> tuple[float, float]:
        """Where the pixel's ray crosses height `z`."""
        zs = sorted(self.planes)
        if len(zs) == 1:
            p = self._on_plane(u, v, self.planes[zs[0]])
            return float(p[0]), float(p[1])
        z0, z1 = sorted(zs, key=lambda k: abs(k - z))[:2]      # the two nearest
        p0, p1 = self._on_plane(u, v, self.planes[z0]), self._on_plane(u, v, self.planes[z1])
        p = p0 + (p1 - p0) * (z - z0) / (z1 - z0)
        return float(p[0]), float(p[1])

    def save(self, path: Path = CALIBRATION, points: dict[float, list] | None = None) -> None:
        points = points or {}
        path.write_text(json.dumps({
            "camera": self.camera, "image_size": list(self.image_size),
            "planes": [{"z": z, "H": H.tolist(), "points": points.get(z, [])}
                       for z, H in sorted(self.planes.items())]}, indent=1))


def in_reach(x: float, y: float, what: str) -> tuple[float, float]:
    if not (REACH_X[0] <= x <= REACH_X[1] and REACH_Y[0] <= y <= REACH_Y[1]):
        raise TableError(f"{what} is at ({x * 100:.0f}, {y * 100:.0f}) cm, outside "
                         f"where I can reach")
    return x, y


# ── the scene, as the planner wants it ─────────────────────────────────────

def observe(leader, table: Table, color: str = "orange", point=point_at) -> dict:
    """One look at the table: the cube and the place to put it, as
    planner.py's `scene` ({"cubes": [...], "box": {...}}), plus the pixels
    they were seen at. The box's pos is its top-face centre, at TARGET_Z.
    A thing that is not in view is simply absent (no cube: [], no box: None)."""
    bgr = snapshot(leader, table.camera)
    pts = point(bgr, {"cube": f"the center of the top face of the {color} cube",
                      "box": TARGET_POINT})
    scene = {"cubes": [], "box": None, "pixels": pts}
    if pts.get("cube") is not None:
        x, y = in_reach(*table.to_xy(*pts["cube"], CUBE_TOP_Z), f"the {color} cube")
        scene["cubes"].append({"color": color, "pos": [x, y, CUBE_Z],
                               "quat": [1.0, 0.0, 0.0, 0.0]})
    if pts.get("box") is not None:
        x, y = in_reach(*table.to_xy(*pts["box"], TARGET_Z), f"the {TARGET}")
        scene["box"] = {"pos": [x, y, TARGET_Z]}
    return scene
