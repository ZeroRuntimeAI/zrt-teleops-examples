import pytest

import skills


def test_joints_are_the_wire_order():
    assert skills.JOINTS == tuple(sorted(skills.JOINTS))
    assert set(skills.LIMITS) == set(skills.JOINTS)


def test_every_skill_is_nonempty_and_inside_limits():
    for name in skills.SKILLS:
        motion = skills.named(name)
        assert motion, name
        for kf in motion:
            assert kf.joints, name
            for joint, value in kf.joints.items():
                assert joint in skills.LIMITS, (name, joint)
                if not kf.relative:
                    lo, hi = skills.LIMITS[joint]
                    assert lo <= value <= hi, (name, joint, value)


def test_relative_gesture_moves_come_back_to_where_they_started():
    for name, motion in skills.GESTURES.items():
        net = {}
        for kf in motion:
            if kf.relative:
                for joint, value in kf.joints.items():
                    net[joint] = net.get(joint, 0.0) + value
        assert all(abs(v) < 1e-9 for v in net.values()), (name, net)


def test_named_is_forgiving_about_case_and_spaces():
    assert skills.named("Point Left") == skills.named("point_left")
    assert skills.named("  WAVE ") == skills.GESTURES["wave"]


def test_unknown_skill_lists_the_real_ones():
    with pytest.raises(ValueError) as exc:
        skills.named("backflip")
    assert "wave" in str(exc.value) and "home" in str(exc.value)


def test_gripper_clamps_out_of_range():                      # Review Focus 1
    assert skills.gripper(150)[0].joints == {"gripper": 100.0}
    assert skills.gripper(-20)[0].joints == {"gripper": 0.0}
    assert skills.gripper("50")[0].joints == {"gripper": 50.0}


@pytest.mark.parametrize("bad", [float("nan"), float("inf"), "wide", None])
def test_gripper_refuses_non_numbers(bad):                  # Review Focus 1
    with pytest.raises(ValueError):
        skills.gripper(bad)


def test_nudge_is_relative_on_one_joint():
    (kf,) = skills.nudge("shoulder_pan", 10)
    assert kf.relative and kf.joints == {"shoulder_pan": 10.0}


@pytest.mark.parametrize("bad", ["gripper", "elbow", ""])
def test_nudge_refuses_gripper_and_unknown_joints(bad):
    with pytest.raises(ValueError) as exc:
        skills.nudge(bad, 10)
    assert "shoulder_pan" in str(exc.value)


@pytest.mark.parametrize("bad", [float("nan"), "lots", None])
def test_nudge_refuses_non_numbers(bad):                    # Review Focus 1
    with pytest.raises(ValueError):
        skills.nudge("shoulder_pan", bad)


def test_clamp_pins_to_the_nearest_limit():
    lo, hi = skills.LIMITS["shoulder_pan"]
    assert skills.clamp("shoulder_pan", 500) == hi
    assert skills.clamp("shoulder_pan", -500) == lo
    assert skills.clamp("shoulder_pan", 1.5) == 1.5
