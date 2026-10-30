import numpy as np
import pytest

import policy


REST = {"shoulder_pan": 0.5, "shoulder_lift": -100.3, "elbow_flex": 99.5,
        "wrist_flex": 78.2, "wrist_roll": 0.0, "gripper": 1.6}    # this arm, folded

#: The checkpoint's own sample: Beegbrain/pick_lemon_and_drop_in_bowl, ep 0
#: frame 0 -- an SO-101 at rest, in the convention MolmoAct2 learned.
MODEL_REST = [-0.5, 189.1, 181.4, 60.6, -3.6, 1.1]


def test_state_vector_converts_to_the_models_convention_in_its_order():
    assert list(policy.state_vector(REST)) == pytest.approx(
        [0.5, 190.3, 189.5, 78.2, 0.0, 0.72])


def test_this_arms_rest_lands_near_the_models_own_rest_sample():
    got = policy.state_vector(REST)
    assert all(abs(g - m) < 20 for g, m in zip(got, MODEL_REST)), list(got)


def test_actions_come_back_in_this_arms_convention():
    rows = policy.rows_from_actions(policy.state_vector(REST)[None, :])
    assert rows[0] == pytest.approx(REST)


def test_state_vector_refuses_missing_joints():
    with pytest.raises(ValueError, match="gripper"):
        policy.state_vector({j: 0.0 for j in policy.ORDER if j != "gripper"})


def test_rows_from_actions_squeezes_and_caps_the_horizon():
    actions = np.tile(policy.state_vector(REST), (1, 40, 1))     # (1, 40, 6)
    rows = policy.rows_from_actions(actions)
    assert len(rows) == policy.HORIZON
    assert rows[-1] == pytest.approx(REST)


def test_rows_from_actions_refuses_non_finite_targets():
    actions = np.zeros((30, 6), np.float32)
    actions[3, 2] = np.nan
    with pytest.raises(ValueError, match="non-finite"):
        policy.rows_from_actions(actions)


def test_rows_from_actions_refuses_the_wrong_arm():
    with pytest.raises(ValueError, match="7 joints"):
        policy.rows_from_actions(np.zeros((30, 7), np.float32))


def test_to_rgb_converts_planar_i420():
    class F:
        array = np.full((6, 4), 128, np.uint8)      # 4x4 image, I420 planes
    rgb = policy.to_rgb(F())
    assert rgb.shape == (4, 4, 3) and rgb.dtype == np.uint8


def test_an_open_gripper_reads_as_open_to_the_model():
    """Live: this arm's open gripper is ~98 (0-100); MolmoAct2's data never
    went past ~44, so it answered 44.5 -- 'open' on its scale -- and the
    unscaled reply looked like a 53-point snap shut."""
    open_arm = {**REST, "gripper": 97.8}
    assert policy.state_vector(open_arm)[-1] == pytest.approx(44.0, abs=1.0)
    back = policy.rows_from_actions(np.array([[0, 90, 90, 0, 0, 44.5]], np.float32))
    assert back[0]["gripper"] == pytest.approx(98.9, abs=1.0)
