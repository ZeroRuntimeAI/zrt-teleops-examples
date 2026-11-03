import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "studio" / "agent"))

import real_agent  # noqa: E402
import sysid  # noqa: E402


def test_fit_recovers_a_known_arm_and_the_planner_uses_it():
    planner = real_agent.shared_planner()
    truth = sysid.Correction({"shoulder_pan": 4.0, "shoulder_lift": -6.0,
                              "elbow_flex": 1.0, "wrist_flex": -3.0}, (-0.006, -0.01, 0.002))
    rng = np.random.default_rng(0)
    home = {"shoulder_pan": 0.0, "shoulder_lift": -60.0, "elbow_flex": 60.0,
            "wrist_flex": 35.0, "wrist_roll": 0.0, "gripper": 0.0}
    demos = []
    for x, y in rng.uniform((0.18, -0.15), (0.34, 0.1), size=(10, 2)):
        # A grasp a person might make: joints that put the TRUE grasp point on a cube.
        joints = real_agent.solve(planner, truth, (x, y, 0.015), home, "demo")
        demos.append({"joints": joints, "target": truth.grasp_point(planner, joints)})

    fitted, res = sysid.fit(planner, demos)
    assert np.abs(res).max() < 0.002                        # metres
    # Not each number: with every grasp pointing down, a wrist_flex offset and
    # the grasp point's offset move the jaws alike, so only their sum is seen.
    for j in ("shoulder_pan", "shoulder_lift"):
        assert abs(fitted.offsets[j] - truth.offsets[j]) < 1.0, j

    # Planned on the fitted model, the real (true) arm's jaws land on the cube.
    above, pre, grasp, lift = real_agent.plan_pick(planner, fitted, (0.28, -0.05, 0.015), home)
    assert np.linalg.norm(truth.grasp_point(planner, grasp) - (0.28, -0.05, 0.015)) < 0.003
