import time
from types import SimpleNamespace

import pytest

import motion
import skills
from motion import MIN_SEGMENT_S, SETTLE_S, MotionController, plan, setpoint_at
from skills import Keyframe

ZERO = {j: 0.0 for j in skills.JOINTS}
DT = 1 / 30


class Clock:
    def __init__(self):
        self.t = 100.0

    def __call__(self):
        return self.t


class Frame:
    def __init__(self):
        self.released = False

    def release(self):
        self.released = True


class StubLeader:
    """The Leader members the controller uses, recorded. `follow`: the pose
    tracks each non-empty setpoint, as a working arm would. `oid_step`: how
    much the observation id advances per read (0 = frozen state)."""

    def __init__(self, pose=None, images=None, follow=True, oid_step=0):
        self.pose = dict(ZERO if pose is None else pose)
        self.images = images if images is not None else {}
        self.follow, self.oid, self.oid_step = follow, 7, oid_step
        self.has_control = True
        self.robot_safe_state = "active"
        self.remote_stats = []
        self.setpoints, self.deadman, self.chunks = [], [], []

    def observation(self):
        self.oid += self.oid_step
        return SimpleNamespace(joints=dict(self.pose), images=dict(self.images),
                               observation_id=self.oid)

    def set_setpoint(self, joints):
        self.setpoints.append(dict(joints))
        if self.follow and joints:
            self.pose.update(joints)

    def hold_deadman(self, held):
        self.deadman.append(held)

    def send_action_chunk(self, rows, row_dt_s, in_reply_to=None):
        self.chunks.append((rows, row_dt_s, in_reply_to))


def make(pose=None, images=None):
    leader, clock = StubLeader(pose, images), Clock()
    return leader, clock, MotionController(leader, fps=30, clock=clock)


def run_until_done(ctl, clock, fut, limit_s=30.0):
    for _ in range(int(limit_s / DT)):
        ctl.step()
        if fut.done():
            return fut.result()
        clock.t += DT
    raise AssertionError("motion never finished")


def wait_for(cond, timeout=2.0):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if cond():
            return
        time.sleep(0.005)
    raise AssertionError("condition never met")


# -- plan / setpoint_at -------------------------------------------------------

def test_plan_resolves_relative_moves_against_the_measured_start():
    start = {**ZERO, "shoulder_pan": 20.0}
    (seg,) = plan(start, skills.nudge("shoulder_pan", 10), now=0.0)
    assert seg[2]["shoulder_pan"] == 20.0 and seg[3]["shoulder_pan"] == 30.0


def test_plan_clamps_every_target():
    (seg,) = plan(ZERO, (Keyframe({"shoulder_pan": 500.0}),), now=0.0)
    assert seg[3]["shoulder_pan"] == skills.LIMITS["shoulder_pan"][1]


def test_plan_duration_follows_the_largest_move():
    (seg,) = plan(ZERO, (Keyframe({"shoulder_pan": 60.0, "elbow_flex": 30.0}),),
                  now=0.0, speed=60.0)
    assert seg[1] - seg[0] == pytest.approx(1.0)
    (tiny,) = plan(ZERO, (Keyframe({"shoulder_pan": 1.0}),), now=0.0)
    assert tiny[1] - tiny[0] == pytest.approx(MIN_SEGMENT_S)


def test_plan_hold_adds_a_still_segment():
    segs = plan(ZERO, (Keyframe({"gripper": 50.0}, hold_s=0.5),), now=0.0)
    assert len(segs) == 2 and segs[1][2] == segs[1][3]
    assert segs[1][1] - segs[1][0] == pytest.approx(0.5)


def test_setpoint_is_smooth_from_start_to_target():
    segs = plan(ZERO, (Keyframe({"shoulder_pan": 60.0}),), now=0.0, speed=60.0)
    assert setpoint_at(segs, 0.0)["shoulder_pan"] == 0.0
    assert setpoint_at(segs, 0.5)["shoulder_pan"] == pytest.approx(30.0)
    assert setpoint_at(segs, 0.1)["shoulder_pan"] < 6.0       # eases in
    assert setpoint_at(segs, 5.0)["shoulder_pan"] == 60.0


# -- one motion ----------------------------------------------------------------

def test_motion_starts_where_the_arm_is_and_holds_deadman_only_while_moving():
    leader, clock, ctl = make({**ZERO, "shoulder_pan": 20.0})
    fut = ctl.command(skills.nudge("shoulder_pan", 10))
    result = run_until_done(ctl, clock, fut)
    assert leader.setpoints[0]["shoulder_pan"] == 20.0         # no jump
    assert leader.setpoints[-1]["shoulder_pan"] == 30.0
    assert leader.deadman == [True, False]
    assert result == {"joints": {**{j: 0.0 for j in skills.JOINTS}, "shoulder_pan": 30.0}}


def test_settles_before_letting_go():
    leader, clock, ctl = make()
    fut = ctl.command(skills.gripper(50))
    ctl.step()
    end = ctl._run["end"]
    clock.t = end + SETTLE_S / 2
    ctl.step()
    assert not fut.done() and leader.deadman == [True]
    clock.t = end + SETTLE_S
    ctl.step()
    assert fut.done() and leader.deadman == [True, False]


def test_arm_outside_limits_does_not_jump_and_never_goes_further_out():   # Review Focus 2
    leader, clock, ctl = make({**ZERO, "shoulder_pan": 120.0})
    fut = ctl.command(skills.nudge("shoulder_pan", 10))
    run_until_done(ctl, clock, fut)
    pans = [s["shoulder_pan"] for s in leader.setpoints]
    assert pans[0] == 120.0
    assert pans[-1] == skills.LIMITS["shoulder_pan"][1]
    assert all(a >= b for a, b in zip(pans, pans[1:]))         # only toward the limit


def test_no_joint_state_is_an_error_not_a_motion():            # Review Focus 4
    leader, clock, ctl = make(pose={})
    fut = ctl.command(skills.gripper(50))
    ctl.step()
    assert "error" in fut.result()
    assert leader.deadman == [] and leader.setpoints == []


def test_partial_joint_state_is_an_error():                    # Review Focus 4
    pose = dict(ZERO)
    del pose["gripper"]
    leader, clock, ctl = make(pose)
    fut = ctl.command(skills.nudge("shoulder_pan", 5))
    ctl.step()
    assert "error" in fut.result() and leader.deadman == []


# -- overlapping intents (Review Focus 3) ------------------------------------

def test_new_command_cancels_the_running_one():
    leader, clock, ctl = make()
    first = ctl.command(skills.named("wave"))
    ctl.step()
    clock.t += 0.2
    second = ctl.command(skills.named("home"))
    assert first.result() == {"cancelled": True}
    assert "joints" in run_until_done(ctl, clock, second)


def test_command_posted_while_measuring_supersedes_the_one_being_started():
    leader, clock, ctl = make()
    first = ctl.command(skills.gripper(50))
    real = ctl.measured
    seen = {}

    def measured_then_race():
        pose = real()
        if "second" not in seen:
            seen["second"] = ctl.command(skills.gripper(10))
        return pose

    ctl.measured = measured_then_race
    ctl.step()
    ctl.measured = real
    assert first.result() == {"cancelled": True}
    result = run_until_done(ctl, clock, seen["second"])
    assert result["joints"]["gripper"] == 10.0


def test_stop_cancels_and_halts_with_a_hold_chunk():
    leader, clock, ctl = make({**ZERO, "elbow_flex": 5.0})
    fut = ctl.command(skills.named("wave"))
    ctl.step()
    ctl.stop()
    assert fut.result() == {"cancelled": True}
    ctl.step()
    rows, row_dt, _ = leader.chunks[-1]
    assert rows == [{**ZERO, "elbow_flex": 5.0}] and row_dt == pytest.approx(DT)
    assert leader.deadman[-1] is False
    assert ctl.state()["mode"] == "idle"


def test_stop_then_command_runs_the_command():
    leader, clock, ctl = make()
    ctl.stop()
    fut = ctl.command(skills.gripper(40))
    assert run_until_done(ctl, clock, fut)["joints"]["gripper"] == 40.0
    assert leader.deadman[:2] == [False, True]


def test_agent_cancelling_its_future_does_not_break_the_controller():
    leader, clock, ctl = make()
    fut = ctl.command(skills.gripper(50))
    ctl.step()
    fut.cancel()                    # what asyncio.wrap_future does on interrupt
    for _ in range(int(3 / DT)):
        ctl.step()                  # must not raise InvalidStateError
        clock.t += DT
    assert leader.deadman[-1] is False


# -- state / measured ---------------------------------------------------------

def test_state_reports_mode_and_rounded_joints():
    leader, clock, ctl = make({**ZERO, "gripper": 12.345})
    assert ctl.state() == {"mode": "idle", "control": True,
                           "joints": {**ZERO, "gripper": 12.3}}
    ctl.command(skills.gripper(50))
    assert ctl.state()["mode"] == "moving"


def test_measured_releases_every_frame():
    frame = Frame()
    leader, clock, ctl = make(images={"cam0": frame})
    ctl.measured()
    assert frame.released


# -- policy --------------------------------------------------------------------

def test_policy_arms_quiets_the_tick_stream_and_sends_chunks():
    leader, clock, ctl = make(images={"cam0": Frame()})
    rows = [{**ZERO, "gripper": 1.0}]
    ctl.start_policy("pick up the cube", lambda obs, task: rows, timeout_s=1e9)
    wait_for(lambda: ctl._chunk is not None)
    ctl.step()
    assert leader.deadman == [True]
    assert leader.setpoints[-1] == {}                          # tick sends nothing
    assert leader.chunks[-1] == (rows, pytest.approx(DT), 7)
    assert ctl.state()["mode"] == "policy"
    ctl.stop()
    ctl.policy_thread.join(timeout=2)
    assert not ctl.policy_thread.is_alive()


def test_policy_times_out_and_halts():
    leader, clock, ctl = make(images={"cam0": Frame()})

    def slow_infer(obs, task):
        clock.t += 10.0
        return [dict(ZERO)]

    ctl.start_policy("pick up the cube", slow_infer, timeout_s=15.0)
    ctl.policy_thread.join(timeout=2)
    ctl.step()
    assert leader.deadman[-1] is False and ctl.state()["mode"] == "idle"


def test_policy_error_stops_the_policy_and_is_reported():
    leader, clock, ctl = make(images={"cam0": Frame()})

    def broken(obs, task):
        raise RuntimeError("boom")

    ctl.start_policy("pick up the cube", broken, timeout_s=1e9)
    ctl.policy_thread.join(timeout=2)
    assert ctl.policy_error == "boom"
    ctl.step()
    assert leader.deadman[-1] is False


def test_a_command_ends_the_policy():
    leader, clock, ctl = make(images={"cam0": Frame()})
    ctl.start_policy("pick up the cube", lambda o, t: [dict(ZERO)], timeout_s=1e9)
    ctl.command(skills.named("home"))
    ctl.policy_thread.join(timeout=2)
    assert not ctl.policy_thread.is_alive()
    assert ctl.state()["mode"] == "moving"


# -- VoiceLeader ----------------------------------------------------------------

def test_voice_leader_declares_what_the_follower_announces():
    from zeroruntime.teleops.protocol import Units
    leader = motion.VoiceLeader(meeting_id="room", token="t", fps=30)
    (group,) = leader.descriptor().groups
    assert tuple(group.names) == skills.JOINTS and group.units == Units.NORMALIZED
    leader.set_setpoint({"gripper": 5.0})
    got = leader.read_joints()
    got["gripper"] = 99.0
    assert leader.read_joints() == {"gripper": 5.0}           # a copy


# -- policy guard ---------------------------------------------------------------

def test_guard_clamps_policy_targets_to_limits():
    near_open = {**ZERO, "gripper": 95.0}
    rows = motion.guard_chunk([{**ZERO, "gripper": 110.0}], near_open)
    assert rows[0]["gripper"] == skills.LIMITS["gripper"][1]


def test_guard_refuses_a_chunk_that_starts_far_from_the_arm():
    with pytest.raises(ValueError, match="shoulder_lift"):
        motion.guard_chunk([{**ZERO, "shoulder_lift": 60.0}], ZERO)


def test_a_policy_that_wants_to_jump_is_stopped_before_anything_is_sent():
    leader, clock, ctl = make(images={"cam0": Frame()})
    ctl.start_policy("pick up the cube",
                     lambda obs, task: [{**ZERO, "elbow_flex": 80.0}], timeout_s=1e9)
    ctl.policy_thread.join(timeout=2)
    assert "jump" in ctl.policy_error
    ctl.step()
    assert all(len(rows) == 1 for rows, _, _ in leader.chunks)   # only the halt
    assert leader.deadman[-1] is False


def test_a_slow_first_inference_delays_the_attempt_instead_of_ending_it():
    """Live: the first MolmoAct2 call took 38 s on MPS. The 30 s budget is for
    moving, so it starts at the first chunk -- not at the tool call."""
    leader, clock, ctl = make(images={"cam0": Frame()})
    calls = []

    def infer(obs, task):
        calls.append(clock.t)
        clock.t += 40.0 if len(calls) == 1 else 5.0
        return [dict(ZERO)]

    ctl.start_policy("pick up the cube", infer, timeout_s=30.0)
    ctl.policy_thread.join(timeout=2)
    assert len(calls) > 1 and ctl.policy_error is None
    assert calls[-1] < 100.0 + 40.0 + 30.0          # then the budget still ends it


def test_a_gripper_snap_is_not_a_jump():
    """The guard catches arm-convention mistakes; a gripper opening or
    closing in one chunk can't throw the arm anywhere."""
    rows = motion.guard_chunk([{**ZERO, "gripper": 80.0}], ZERO)
    assert rows[0]["gripper"] == 80.0


# -- policy outcomes, current(), health() ---------------------------------------

def test_policy_future_reports_done_when_its_budget_runs_out():
    leader, clock, ctl = make(images={"cam0": Frame()})

    def infer(obs, task):
        clock.t += 10.0
        return [dict(ZERO)]

    fut = ctl.start_policy("t", infer, timeout_s=15.0)
    ctl.policy_thread.join(timeout=2)
    out = fut.result(timeout=1)
    assert out["ended"] == "done" and out["ran_s"] >= 10.0


def test_stop_ends_a_waiting_policy_promptly():                 # Review Focus 3
    leader, clock, ctl = make(images={"cam0": Frame()})
    fut = ctl.start_policy("t", lambda o, t: [dict(ZERO)], timeout_s=1e9)
    wait_for(lambda: ctl._chunk is not None)
    ctl.stop()
    assert fut.result(timeout=2)["ended"] == "stopped"


def test_a_policy_error_comes_back_as_words_the_agent_can_say():
    leader, clock, ctl = make(images={"cam0": Frame()})

    def broken(obs, task):
        raise RuntimeError("boom")

    out = ctl.start_policy("t", broken, timeout_s=1e9).result(timeout=2)
    assert out["ended"] == "error" and "boom" in out["error"]
    assert out["error"].startswith("My pick-up model failed")


def test_current_is_the_running_intent():
    leader, clock, ctl = make()
    assert ctl.current() is None
    fut = ctl.command(skills.gripper(50))
    assert ctl.current() is fut
    run_until_done(ctl, clock, fut)
    assert ctl.current() is None


def test_a_healthy_arm():
    leader, clock, ctl = make()
    leader.oid_step = 1
    clock.t += 5.0
    assert ctl.health() == {"ok": True, "problem": None}


@pytest.mark.parametrize("breakage,problem", [
    (lambda l: setattr(l, "has_control", False), motion.NO_CONTROL),
    (lambda l: setattr(l, "robot_safe_state", "holding (robot_fault)"), motion.ROBOT_FAULT),
])
def test_an_unhealthy_arm_says_why(breakage, problem):
    leader, clock, ctl = make()
    breakage(leader)
    assert ctl.health() == {"ok": False, "problem": problem}


def test_no_new_joint_state_reads_as_stale():
    leader, clock, ctl = make()              # oid frozen
    ctl.measured()                           # one reading, then nothing new
    clock.t += motion.STALE_S + 0.5
    assert ctl.health() == {"ok": False, "problem": motion.STALE}


def test_a_missed_target_comes_back_as_a_warning():
    leader, clock, ctl = make()
    leader.follow = False                    # the arm doesn't move
    out = run_until_done(ctl, clock, ctl.command(skills.nudge("elbow_flex", 20)))
    assert "elbow flex" in out["warning"] and "joints" in out


def test_an_arm_that_arrives_late_is_not_called_blocked():
    """Live: "rest" came back "52 degrees short" with nothing in the way --
    the reported pose lags the command. Arriving within REACH_WAIT_S is fine."""
    leader, clock, ctl = make()
    leader.follow = False
    fut = ctl.command(skills.nudge("elbow_flex", 20))
    for _ in range(int(10 / DT)):
        ctl.step()
        run = ctl._run
        if run and clock.t >= run["end"] + SETTLE_S + 0.5:
            leader.pose["elbow_flex"] = 20.0        # it gets there, late
        if fut.done():
            break
        clock.t += DT
    assert fut.done() and "warning" not in fut.result()


def test_a_missed_target_is_only_reported_after_the_wait():
    leader, clock, ctl = make()
    leader.follow = False
    fut = ctl.command(skills.nudge("elbow_flex", 20))
    ticks_after_end = 0
    for _ in range(int(10 / DT)):
        ctl.step()
        if fut.done():
            break
        if ctl._run and clock.t >= ctl._run["end"] + SETTLE_S:
            ticks_after_end += 1
        clock.t += DT
    assert "warning" in fut.result()
    assert ticks_after_end * DT >= motion.REACH_WAIT_S - DT


def test_a_reached_target_has_no_warning():
    leader, clock, ctl = make()
    out = run_until_done(ctl, clock, ctl.command(skills.nudge("elbow_flex", 20)))
    assert "warning" not in out


def test_the_policy_loop_logs_its_inferences(tmp_path):
    import json
    import events
    path = events.open_log(tmp_path, "m")
    leader, clock, ctl = make(images={"cam0": Frame()})

    def infer(obs, task):
        clock.t += 10.0
        return [dict(ZERO)]

    ctl.start_policy("pick", infer, timeout_s=15.0).result(timeout=2)
    kinds = [json.loads(l)["kind"] for l in path.read_text().splitlines()]
    assert "policy_start" in kinds and "infer" in kinds and "policy_end" in kinds


def test_rising_joint_read_faults_read_as_a_servo_fault():
    """Live: the leader's safe state is just 'holding' -- no reason -- but
    the robot's stats count joint read faults."""
    leader, clock, ctl = make()
    leader.oid_step = 1
    leader.remote_stats = [{"id": "control"}, {"jointReadFaults": 3}]
    assert ctl.health()["ok"]                    # old faults are a baseline
    leader.remote_stats = [{"id": "control"}, {"jointReadFaults": 9}]
    assert ctl.health() == {"ok": False, "problem": motion.ROBOT_FAULT}
    assert ctl.health()["ok"]                    # no new faults since


# -- dancing ---------------------------------------------------------------------

import random as _random


def dance_ticks(ctl, clock, seconds):
    for _ in range(int(seconds / DT)):
        ctl.step()
        clock.t += DT


def test_the_dance_moves_into_base_then_keeps_dancing_without_gaps():
    leader, clock, ctl = make()
    ctl.start_dance("smooth", _random.Random(1))
    dance_ticks(ctl, clock, 8.0)
    assert leader.deadman == [True]
    assert all(sp for sp in leader.setpoints)                  # never an empty tick
    distinct = {tuple(round(v, 1) for v in sp.values()) for sp in leader.setpoints[-120:]}
    assert len(distinct) > 20                                 # it is moving
    assert ctl.state()["mode"] == "dancing"


def test_every_dance_setpoint_stays_inside_limits():
    leader, clock, ctl = make()
    ctl.start_dance("energetic", _random.Random(2))
    ctl.music(bpm=140, beat_at=clock.t, energy=1.0)
    dance_ticks(ctl, clock, 10.0)
    for sp in leader.setpoints:
        for joint, v in sp.items():
            lo, hi = skills.LIMITS[joint]
            assert lo - 1e-6 <= v <= hi + 1e-6


def test_music_sets_the_tempo():
    leader, clock, ctl = make()
    ctl.start_dance("playful", _random.Random(3))
    ctl.step()
    ctl.music(bpm=120, beat_at=clock.t, energy=0.8)
    assert ctl._dance["period"] == pytest.approx(0.5)
    assert ctl._dance["energy"] == pytest.approx(0.8)


def test_music_while_not_dancing_is_ignored():                  # Review Focus 4
    leader, clock, ctl = make()
    ctl.music(bpm=120, beat_at=clock.t, energy=1.0)
    dance_ticks(ctl, clock, 1.0)
    assert leader.setpoints == [] and leader.deadman == []


def test_music_stopping_ends_the_dance_and_holds():
    leader, clock, ctl = make()
    fut = ctl.start_dance("smooth", _random.Random(4))
    ctl.step()
    ctl.music(bpm=100, beat_at=clock.t, energy=0.5)
    dance_ticks(ctl, clock, 2.0)
    ctl.music_stop()
    ctl.step()
    assert fut.result(timeout=1) == {"ended": "music_stopped"}
    assert leader.deadman[-1] is False and ctl.state()["mode"] == "idle"


@pytest.mark.parametrize("interrupt", ["stop", "command"])
def test_stop_or_a_command_ends_the_dance(interrupt):
    leader, clock, ctl = make()
    fut = ctl.start_dance("smooth", _random.Random(5))
    dance_ticks(ctl, clock, 1.5)
    if interrupt == "stop":
        ctl.stop()
    else:
        ctl.command(skills.named("home"))
    assert fut.result(timeout=1) == {"ended": "stopped"}


def test_a_solo_dance_ends_by_itself():
    leader, clock, ctl = make()
    fut = ctl.start_dance("smooth", _random.Random(6))
    dance_ticks(ctl, clock, motion.DANCE_SOLO_S + 2.0)
    assert fut.result(timeout=1) == {"ended": "done"}
    assert leader.deadman[-1] is False


def test_no_joint_state_means_no_dance():                        # Review Focus 2
    leader, clock, ctl = make(pose={})
    fut = ctl.start_dance("smooth")
    ctl.step()
    assert "error" in fut.result(timeout=1) and leader.deadman == []
