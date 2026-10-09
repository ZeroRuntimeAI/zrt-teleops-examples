"""Scene state from per-camera YOLO detections + optional gripper.pos (plan.md 1.2, 1.6). Pure functions."""

STATES = ("CUBE_IN_BOX", "CUBE_IN_GRIPPER", "CUBE_ON_TABLE", "NO_CUBE")  # priority order
# Det = (cls_name: str, conf: float, (x1, y1, x2, y2) normalized 0..1)


def yolo_to_dets(result, conf_min: float) -> list[tuple]:
    b = result.boxes
    return [(result.names[int(c)], p, tuple(xyxy))
            for c, p, xyxy in zip(b.cls.tolist(), b.conf.tolist(), b.xyxyn.tolist())
            if p >= conf_min]


def _best(dets, name):
    return max((d for d in dets if d[0] == name), key=lambda d: d[1], default=None)


def _inside(cube, xyxy):
    cx = (cube[2][0] + cube[2][2]) / 2
    cy = (cube[2][1] + cube[2][3]) / 2
    x1, y1, x2, y2 = xyxy
    return x1 <= cx <= x2 and y1 <= cy <= y2


def classify(dets: dict[str, list[tuple]], wrist_roi, gripper_pos=None, grip_band=None,
             fixed_cams=("top", "side"), wrist_cam="wrist") -> str:
    if wrist_roi is None:
        raise ValueError("WRIST_HOLD_ROI not set yet (plan.md 1.6, `python split.py` suggests one)")
    wcube = _best(dets.get(wrist_cam, []), "cube")
    holding = wcube is not None and _inside(wcube, wrist_roi)
    # Vision alone can't tell "open fingers around the cube" (pre-grasp) from "gripped".
    if grip_band is not None:
        holding = holding and gripper_pos is not None and grip_band[0] <= gripper_pos <= grip_band[1]

    votes = []  # one per fixed cam that sees a cube: True = inside box
    for cam in fixed_cams:
        cube = _best(dets.get(cam, []), "cube")
        if cube is not None:
            box = _best(dets.get(cam, []), "box")
            votes.append(box is not None and _inside(cube, box[2]))
    # Conservative: any fixed cam seeing the cube outside vetoes, since a false "done" is the worst error.
    if not holding and votes and all(votes):
        return "CUBE_IN_BOX"
    if holding:
        return "CUBE_IN_GRIPPER"
    if any(_best(d, "cube") for d in dets.values()):
        return "CUBE_ON_TABLE"
    return "NO_CUBE"


class Debouncer:
    def __init__(self, n: int):
        self.n, self.stable, self.last, self.count = n, None, None, 0

    def update(self, state: str) -> str | None:
        self.count = self.count + 1 if state == self.last else 1
        self.last = state
        if self.count >= self.n:
            self.stable = state
        return self.stable


if __name__ == "__main__":
    from types import SimpleNamespace as NS

    BOX = ("box", 0.9, (100, 100, 300, 300))
    IN = ("cube", 0.8, (180, 180, 220, 220))   # center (200, 200): inside BOX
    OUT = ("cube", 0.8, (400, 400, 440, 440))  # center (420, 420): outside BOX
    ROI = (250, 300, 390, 480)                 # wrist "between the fingers" region
    HELD = ("cube", 0.9, (290, 350, 350, 450))  # center (320, 400): inside ROI
    NEAR = ("cube", 0.9, (290, 100, 350, 160))  # center (320, 130): cube seen, not held

    def c(dets, grip=None, band=None):
        return classify(dets, ROI, grip, band)

    assert c({"top": [BOX, IN], "side": [BOX, IN], "wrist": []}) == "CUBE_IN_BOX"
    assert c({"top": [BOX, IN], "side": [BOX]}) == "CUBE_IN_BOX"  # side occluded: no veto
    assert c({"top": [BOX, IN], "side": [BOX, IN], "wrist": [HELD]}) == "CUBE_IN_GRIPPER"  # held above box
    assert c({"top": [BOX, IN], "side": [BOX, OUT]}) == "CUBE_ON_TABLE"  # disagreement -> not done
    assert c({"top": [BOX, IN], "side": [OUT]}) == "CUBE_ON_TABLE"  # cube but no box = outside
    assert c({"top": [], "side": [], "wrist": [NEAR]}) == "CUBE_ON_TABLE"  # wrist sees it, not held
    assert c({"top": [], "side": [], "wrist": [BOX, NEAR]}) == "CUBE_ON_TABLE"  # wrist ignored for in_box
    assert c({"top": [BOX, OUT], "side": [BOX]}) == "CUBE_ON_TABLE"
    assert c({"top": [BOX], "side": [BOX], "wrist": [HELD]}) == "CUBE_IN_GRIPPER"  # fixed cams occluded
    assert c({"wrist": [HELD]}, grip=30.0, band=(20, 40)) == "CUBE_IN_GRIPPER"  # closed on cube
    assert c({"wrist": [HELD]}, grip=80.0, band=(20, 40)) == "CUBE_ON_TABLE"  # pre-grasp, fingers open
    assert c({"wrist": [HELD]}, grip=None, band=(20, 40)) == "CUBE_ON_TABLE"  # no reading: not held
    assert c({"top": [BOX], "side": [], "wrist": []}) == "NO_CUBE"
    assert c({}) == "NO_CUBE"
    # highest-conf cube wins
    assert c({"top": [BOX, ("cube", 0.6, OUT[2]), ("cube", 0.95, IN[2])], "side": []}) == "CUBE_IN_BOX"
    try:
        classify({}, None)
        raise AssertionError("expected ValueError")
    except ValueError:
        pass

    class T(list):
        def tolist(self):
            return list(self)

    res = NS(names={0: "cube", 1: "box"},
             boxes=NS(cls=T([0.0, 1.0, 0.0]), conf=T([0.9, 0.7, 0.3]),
                      xyxyn=T([[1, 2, 3, 4], [5, 6, 7, 8], [9, 9, 9, 9]])))
    assert yolo_to_dets(res, 0.5) == [("cube", 0.9, (1, 2, 3, 4)), ("box", 0.7, (5, 6, 7, 8))]

    d = Debouncer(3)
    assert [d.update(s) for s in ("A", "A")] == [None, None]
    assert d.update("A") == "A"
    assert [d.update(s) for s in ("B", "A", "B", "B")] == ["A"] * 4  # flicker doesn't switch
    assert d.update("B") == "B"

    print("state.py OK")
