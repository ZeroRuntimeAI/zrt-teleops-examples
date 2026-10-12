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


def _contained(cube, xyxy):
    """Whole cube bbox inside xyxy: stricter than _inside, used for the close-up wrist view."""
    x1, y1, x2, y2 = xyxy
    return x1 <= cube[2][0] and y1 <= cube[2][1] and cube[2][2] <= x2 and cube[2][3] <= y2


def classify(dets: dict[str, list[tuple]], wrist_roi, gripper_pos=None, grip_band=None,
             fixed_cams=("top", "side"), wrist_cam="wrist", box_view_cam="top") -> str | None:
    """The state this frame shows, or None when it can't tell (no fixed camera sees the cube and
    the wrist view doesn't settle it, usually because the arm is in the way). Tracker holds the
    last state through None frames. `box_view_cam` is the one camera that sees INTO the box: from
    the side, the walls hide a cube inside even when the box itself is visible."""
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
    if votes:
        return "CUBE_ON_TABLE"  # a fixed cam sees the cube outside the box
    # No fixed cam sees the cube (arm in the way, or it's gone). Only the wrist can settle it.
    wbox = _best(dets.get(wrist_cam, []), "box")
    if wcube is not None and wbox is not None:
        return "CUBE_IN_BOX" if _contained(wcube, wbox[2]) else "CUBE_ON_TABLE"
    # No cube anywhere. Only call it NO_CUBE if the camera that sees into the box sees the box
    # (so it would see a cube in it). Box hidden too = the arm is covering it: can't tell.
    if wcube is None and _best(dets.get(box_view_cam, []), "box") is not None:
        return "NO_CUBE"
    return None


class Tracker:
    """Debounce + hold. The stable state switches only after `n` identical frames in a row. A
    None frame (can't tell) holds the stable state; after `lost_s` seconds of nothing but None,
    it counts as NO_CUBE. Returns None until the first state is stable."""

    def __init__(self, n: int, lost_s: float):
        self.n, self.lost_s = n, lost_s
        self.stable, self.last, self.count, self.seen_t = None, None, 0, None

    def update(self, state: str | None, t: float) -> str | None:
        if self.seen_t is None:
            self.seen_t = t
        if state is None:
            if t - self.seen_t < self.lost_s:
                return self.stable
            state = "NO_CUBE"
        else:
            self.seen_t = t
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
    assert c({"top": [], "side": [], "wrist": [NEAR]}) is None  # wrist cube, no box to compare: can't tell
    WBOX = ("box", 0.9, (200, 50, 450, 250))   # wrist-view box around NEAR
    assert c({"top": [], "side": [], "wrist": [WBOX, NEAR]}) == "CUBE_IN_BOX"  # fixed cams blocked, wrist sees it in box
    assert c({"top": [], "side": [], "wrist": [("box", 0.9, (0, 0, 100, 100)), NEAR]}) == "CUBE_ON_TABLE"
    assert c({"top": [], "side": [], "wrist": [("box", 0.9, (300, 50, 450, 250)), NEAR]}) == "CUBE_ON_TABLE"  # only partly in
    assert c({"top": [BOX, OUT], "wrist": [WBOX, NEAR]}) == "CUBE_ON_TABLE"  # a fixed cam outranks the wrist
    assert c({"top": [BOX, OUT], "side": [BOX]}) == "CUBE_ON_TABLE"
    assert c({"top": [BOX], "side": [BOX], "wrist": [HELD]}) == "CUBE_IN_GRIPPER"  # fixed cams occluded
    assert c({"wrist": [HELD]}, grip=30.0, band=(20, 40)) == "CUBE_IN_GRIPPER"  # closed on cube
    assert c({"top": [BOX, OUT], "wrist": [HELD]}, grip=80.0, band=(20, 40)) == "CUBE_ON_TABLE"  # pre-grasp
    assert c({"top": [BOX, OUT], "wrist": [HELD]}, grip=None, band=(20, 40)) == "CUBE_ON_TABLE"  # no reading
    assert c({"top": [BOX], "side": [BOX], "wrist": []}) == "NO_CUBE"  # top sees an empty box
    assert c({"top": [], "side": [BOX], "wrist": []}) is None  # box hidden from top (arm): can't tell
    assert c({"top": [BOX], "wrist": [NEAR]}) is None  # wrist sees a cube somewhere: not NO_CUBE
    assert c({}) is None
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

    d = Tracker(3, lost_s=2.0)
    assert [d.update(s, 0) for s in ("A", "A")] == [None, None]
    assert d.update("A", 0) == "A"
    assert [d.update(s, 0) for s in ("B", "A", "B", "B")] == ["A"] * 4  # flicker doesn't switch
    assert d.update("B", 0) == "B"
    assert [d.update(None, t) for t in (0.5, 1.0, 1.9)] == ["B"] * 3  # can't tell: hold
    assert d.update("B", 2.5) == "B"                                   # seen again: timer resets
    assert [d.update(None, t) for t in (3.0, 4.6, 4.7, 4.8)] == ["B", "B", "B", "NO_CUBE"]  # lost 2 s, then debounced
    e = Tracker(2, lost_s=1.0)
    assert [e.update(None, t) for t in (0, 0.5, 1.0, 1.1)] == [None, None, None, "NO_CUBE"]  # empty from the start

    print("state.py OK")
