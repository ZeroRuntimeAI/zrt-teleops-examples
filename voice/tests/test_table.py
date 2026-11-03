import json

import numpy as np
import pytest

import table


def test_planes_roundtrip_and_observe(tmp_path, monkeypatch):
    # A made-up pinhole camera: project (x, y, z) to pixels, so a pixel's
    # (x, y) really is linear in z and two planes should give any height.
    K = np.array([[500.0, 0.0, 320.0], [0.0, 500.0, 240.0], [0.0, 0.0, 1.0]])
    R = np.array([[0.0, 1.0, 0.0], [-0.6, 0.0, -0.8], [-0.8, 0.0, 0.6]])  # looking down-forward
    t = np.array([0.0, 0.3, 0.6])

    def to_px(x, y, z):
        p = K @ (R @ np.array([x, y, z]) + t)
        return p[0] / p[2], p[1] / p[2]

    grid = [(x, y) for x in (0.14, 0.22, 0.30) for y in (-0.2, -0.1, 0.0, 0.1, 0.2)]
    planes = {}
    for z in (0.03, 0.06):
        pixels = [to_px(x, y, z) for x, y in grid]
        pixels[7] = (pixels[7][0] + 80, pixels[7][1])      # one mispointed frame
        H, rms, out = table.fit_plane(pixels, grid)
        assert rms < 1e-6 and out == [7]
        planes[z] = H
    tbl = table.Table(planes)
    for z in (0.03, 0.045, 0.06, 0.09):             # on, between and beyond the planes
        x, y = tbl.to_xy(*to_px(0.25, 0.05, z), z)
        assert abs(x - 0.25) < 1e-6 and abs(y - 0.05) < 1e-6

    tbl.save(tmp_path / "t.json", points={0.03: [{"px": [1, 2]}]})
    again = table.Table.load(tmp_path / "t.json")
    assert set(again.planes) == {0.03, 0.06}
    assert np.allclose(again.planes[0.06], planes[0.06])

    # Gemini answers [y, x] in 0-1000; a null is "not in view".
    pts = table.parse_points(json.dumps({"cube": [500, 250], "bowl": None}), 640, 480)
    assert pts == {"cube": (160.0, 240.0), "bowl": None}
    assert table.parse_points('[{"box": [500, 250]}]', 640, 480) == {"box": (160.0, 240.0)}

    cube_px = to_px(0.25, 0.05, table.CUBE_TOP_Z)
    box_px = to_px(0.18, -0.10, table.TARGET_Z)
    monkeypatch.setattr(table, "snapshot", lambda leader, camera=None: np.zeros((480, 640, 3), np.uint8))
    scene = table.observe(None, tbl, "orange",
                          point=lambda bgr, things: {"cube": cube_px, "box": box_px})
    assert scene["cubes"][0]["color"] == "orange"
    assert np.allclose(scene["cubes"][0]["pos"], [0.25, 0.05, table.CUBE_Z], atol=1e-6)
    assert np.allclose(scene["box"]["pos"], [0.18, -0.10, table.TARGET_Z], atol=1e-6)

    with pytest.raises(table.TableError):
        table.observe(None, tbl, point=lambda bgr, things: {"cube": to_px(0.9, 0.0, 0.03), "box": None})
