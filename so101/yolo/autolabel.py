"""Auto-label captured frames in YOLO format, instead of drawing boxes by hand.

    python autolabel.py              # labels every 3rd tick -> data/labels/*.txt
    python autolabel.py --preview    # also writes data/autolabel_preview.jpg to eyeball
    python autolabel.py --selftest   # cube rule on synthetic images, no model needed

cube (class 0): the bright-orange blob. Thresholds were measured on this rig's frames: cardboard
is the same hue but duller (V <= ~158), and the cube is saturated and bright (V >= ~216).
box (class 1): YOLO-World with a text prompt. It finds the box well but misses the small cube.

ponytail: colour labelling only works because nothing else on the table is bright orange.
Change the scene (lighting, other orange objects) and these labels need checking or hand-labelling.
"""
import argparse
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).parent
# Per camera: (S min, V min, area min px). Top sees a small, dimmer cube; the wrist is close to
# the box walls, so it needs the strictest brightness.
CUBE_HSV = {"top": (150, 160, 40), "side": (160, 180, 15), "wrist": (160, 180, 40)}
# Seen from above inside the box, the cube's top face is washed out: brighter than the shaded
# cardboard but LESS saturated. Only searched inside the detected box, top camera only.
CUBE_IN_BOX_TOP = (40, 230, 20)
HUE = (12, 28)
BOX_PROMPT, BOX_CONF = "cardboard box", 0.25


def find_cube(bgr, s_min, v_min, a_min):
    """Normalized (x1, y1, x2, y2) of the cube blob, or None."""
    h, w = bgr.shape[:2]
    m = cv2.inRange(cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV), (HUE[0], s_min, v_min), (HUE[1], 255, 255))
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))  # join jaw-split halves
    n, _, st, _ = cv2.connectedComponentsWithStats(m)
    best = None
    for x, y, bw, bh, a in st[1:]:
        solid = a / (bw * bh) >= 0.55                      # cube = solid blob; box walls = slivers
        squarish = 0.5 <= bw / bh <= 2.0
        inside = x > 2 and y > 2 and x + bw < w - 2 and y + bh < h - 2
        if a >= a_min and solid and squarish and inside and (best is None or a > best[4]):
            best = (x, y, bw, bh, a)
    if best is None:
        return None
    x, y, bw, bh, _ = best
    return x / w, y / h, (x + bw) / w, (y + bh) / h


def cube_in_box(bgr, box):
    """find_cube with the washed-out-top-face thresholds, searched only inside `box` (normalized)."""
    h, w = bgr.shape[:2]
    x1, y1, x2, y2 = int(box[0] * w), int(box[1] * h), int(box[2] * w), int(box[3] * h)
    r = find_cube(bgr[y1:y2, x1:x2], *CUBE_IN_BOX_TOP)
    if r is None:
        return None
    cw, ch = x2 - x1, y2 - y1
    return (x1 + r[0] * cw) / w, (y1 + r[1] * ch) / h, (x1 + r[2] * cw) / w, (y1 + r[3] * ch) / h


def iou(a, b):
    ix = max(0, min(a[2], b[2]) - max(a[0], b[0])); iy = max(0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    return inter / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter)


def yolo_line(cls, xyxy):
    x1, y1, x2, y2 = xyxy
    return f"{cls} {(x1 + x2) / 2:.5f} {(y1 + y2) / 2:.5f} {x2 - x1:.5f} {y2 - y1:.5f}"


def main(every, preview):
    from ultralytics import YOLOWorld
    world = YOLOWorld("yolov8s-worldv2.pt")
    world.set_classes([BOX_PROMPT])
    out = ROOT / "data" / "labels"
    out.mkdir(parents=True, exist_ok=True)
    counts, tiles = {}, []
    for img in sorted((ROOT / "data" / "yolo_raw").glob("*/*/*.jpg")):
        state, _, cam, idx = img.stem.split("__")
        if int(idx) % every:
            continue
        bgr = cv2.imread(str(img))
        r = world.predict(bgr, conf=BOX_CONF, verbose=False)[0]
        box = r.boxes.xyxyn[int(r.boxes.conf.argmax())].tolist() if len(r.boxes) else None
        cube = find_cube(bgr, *CUBE_HSV[cam])
        if cube is None and box is not None and cam == "top":
            cube = cube_in_box(bgr, box)
        # YOLO-World sometimes calls the cube itself a "box", or boxes half the frame (wrist view).
        if box is not None and ((cube and iou(box, cube) > 0.3) or (box[2] - box[0]) * (box[3] - box[1]) > 0.5):
            box = None
        lines = [yolo_line(0, cube)] if cube else []
        if box is not None:
            lines.append(yolo_line(1, box))
        # A cube session where we found no cube: the cube may still be visible (occluded, missed), so
        # an empty label would teach "no cube here". Leave it unlabelled; split.py then skips it.
        if cube or state == "NO_CUBE":
            (out / f"{img.stem}.txt").write_text("".join(l + "\n" for l in lines))  # empty = background
        c = counts.setdefault((state, cam), [0, 0, 0])
        c[0] += 1; c[1] += bool(cube); c[2] += box is not None
        if preview and int(idx) % (every * 10) == 0:
            h, w = bgr.shape[:2]
            for line in lines:
                k, cx, cy, bw, bh = map(float, line.split())
                col = (255, 0, 255) if k == 0 else (255, 255, 0)
                cv2.rectangle(bgr, (int((cx - bw / 2) * w), int((cy - bh / 2) * h)),
                              (int((cx + bw / 2) * w), int((cy + bh / 2) * h)), col, 3)
            t = cv2.resize(bgr, (256, 192))
            cv2.putText(t, f"{state[:11]} {cam} {idx}", (3, 185), 0, .4, (0, 255, 255), 1)
            tiles.append(t)
    print(f"{'state':16s} {'cam':6s} frames  cube  box")
    for (state, cam), (n, nc, nb) in sorted(counts.items()):
        print(f"{state:16s} {cam:6s} {n:6d} {nc:5d} {nb:4d}")
    print(f"wrote {len(list(out.glob('*.txt')))} label files to {out}")
    if tiles:
        cols = 6
        tiles += [np.zeros_like(tiles[0])] * (-len(tiles) % cols)
        sheet = np.vstack([np.hstack(tiles[i:i + cols]) for i in range(0, len(tiles), cols)])
        cv2.imwrite(str(ROOT / "data" / "autolabel_preview.jpg"), sheet)
        print(f"preview: {ROOT / 'data' / 'autolabel_preview.jpg'} (magenta = cube, cyan = box)")


def selftest():
    bg = np.full((480, 640, 3), (120, 160, 190), np.uint8)               # dull tan, like the table
    cube = bg.copy(); cv2.rectangle(cube, (300, 200), (340, 240), (0, 140, 255), -1)  # bright orange
    x1, y1, x2, y2 = find_cube(cube, *CUBE_HSV["wrist"])
    assert abs(x1 - 300 / 640) < 0.01 and abs(y2 - 241 / 480) < 0.01, (x1, y2)
    assert find_cube(bg, *CUBE_HSV["wrist"]) is None
    sliver = bg.copy(); cv2.rectangle(sliver, (300, 100), (310, 300), (0, 140, 255), -1)
    assert find_cube(sliver, *CUBE_HSV["wrist"]) is None                 # box-wall-like sliver
    edge = bg.copy(); cv2.rectangle(edge, (0, 200), (40, 240), (0, 140, 255), -1)
    assert find_cube(edge, *CUBE_HSV["wrist"]) is None                   # touches the border
    dull = bg.copy(); cv2.rectangle(dull, (300, 200), (340, 240), (60, 110, 150), -1)
    assert find_cube(dull, *CUBE_HSV["wrist"]) is None                   # cardboard-dull orange
    assert yolo_line(0, (0.25, 0.5, 0.75, 1.0)) == "0 0.50000 0.75000 0.50000 0.50000"
    pale = bg.copy(); cv2.rectangle(pale, (100, 100), (300, 300), (60, 110, 150), -1)  # shaded cardboard box
    cv2.rectangle(pale, (180, 180), (210, 210), (200, 235, 250), -1)                  # washed-out cube top
    c = cube_in_box(pale, (100 / 640, 100 / 480, 300 / 640, 300 / 480))
    assert c and abs(c[0] - 180 / 640) < 0.01 and abs(c[1] - 180 / 480) < 0.01, c
    assert find_cube(pale, *CUBE_HSV["top"]) is None                         # normal rule misses it
    assert abs(iou((0, 0, 1, 1), (0, 0, 1, 0.5)) - 0.5) < 1e-9 and iou((0, 0, .1, .1), (.5, .5, 1, 1)) == 0
    print("autolabel.py selftest OK")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--every", type=int, default=3, help="label every Nth tick")
    ap.add_argument("--preview", action="store_true")
    ap.add_argument("--selftest", action="store_true")
    a = ap.parse_args()
    selftest() if a.selftest else main(a.every, a.preview)
