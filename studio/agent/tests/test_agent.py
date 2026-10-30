"""StudioRobotAgent's pick_up/place, and the per-room worker factory. No room."""

import asyncio
import threading
from concurrent.futures import Future
from types import SimpleNamespace

import pytest

import studio_agent
import worker
from studio_agent import EXECUTOR, StudioRobotAgent

SCENE = {
    "cubes": [{"color": "red", "pos": [0.24, 0.05, 0.015], "quat": [1, 0, 0, 0], "inBox": False},
              {"color": "blue", "pos": [0.30, -0.05, 0.015], "quat": [1, 0, 0, 0], "inBox": False}],
    "box": {"pos": [0.22, 0.125, 0.0], "innerHalf": 0.045},
    "gripper": {"pos": [0.26, 0.0, 0.12]},
}
HOME = {"shoulder_pan": 0.0, "shoulder_lift": -60.0, "elbow_flex": 60.0,
        "wrist_flex": 35.0, "wrist_roll": 0.0, "gripper": 30.0}


class FakeLeader:
    robot_peer = "browser-tab"

    def __init__(self, scene=SCENE, error=None):
        self.scene, self.error, self.calls = scene, error, []

    def perform_rpc(self, peer, method, payload=None, timeout=5.0):
        self.calls.append((peer, method))
        if self.error:
            raise self.error
        return self.scene


class FakeCtl:
    def __init__(self):
        self.commands = []

    def health(self):
        return {"ok": True, "problem": None}

    def measured(self):
        return dict(HOME)

    def command(self, motion):
        self.commands.append(motion)
        fut = Future()
        fut.set_result({"joints": dict(motion[-1].joints)})
        return fut


def tool_self(leader=None):
    """A real StudioRobotAgent on fakes; what it tells the page is recorded."""
    events = []

    async def publish(payload):
        events.append(payload)

    me = StudioRobotAgent(FakeCtl(), leader or FakeLeader(), studio_agent.shared_planner())
    me._publish = publish
    return me, events


def call(tool, me, *args):
    return asyncio.run(tool(me, *args))


def test_pick_up_plans_from_the_scene_and_commands_once():
    me, events = tool_self()
    out = call(StudioRobotAgent.pick_up, me, "the red cube")
    assert out["ok"] is True, out
    assert out["executor"] == "scripted planner · uses exact simulator positions"
    assert out["executor"] == EXECUTOR
    assert len(me.ctl.commands) == 1
    assert me.leader.calls == [("browser-tab", "observe_scene")]
    assert me.ctl.commands[0][-1].joints["gripper"] <= 5
    assert events[-1]["name"] == "pick_up" and events[-1]["result"]["executor"] == EXECUTOR


def test_place_commands_once_with_the_executor_label():
    me, _ = tool_self()
    out = call(StudioRobotAgent.place, me, "box")
    assert out["ok"] is True and out["executor"] == EXECUTOR
    assert len(me.ctl.commands) == 1
    assert me.ctl.commands[0][-1].joints["gripper"] >= 50


def test_pick_up_of_a_missing_color_says_which():
    me, _ = tool_self()
    out = call(StudioRobotAgent.pick_up, me, "purple cube")
    assert out["ok"] is False and "purple" in out["error"]
    assert me.ctl.commands == []


def test_pick_up_without_the_lease_reports_control_and_never_moves():
    me, _ = tool_self(FakeLeader(error=RuntimeError("perform_rpc: not the lease holder")))
    out = call(StudioRobotAgent.pick_up, me, "red cube")
    assert out["ok"] is False and "control" in out["error"]
    assert me.ctl.commands == []


@pytest.mark.parametrize("item,color", [("red cube", "red"), ("the Blue one", "blue"),
                                        ("yellow", "yellow"), ("purple cube", "purple"),
                                        ("cube", None)])
def test_color_of(item, color):
    assert studio_agent.color_of(item) == color


# -- worker ---------------------------------------------------------------------

class FakeVoiceLeader:
    made = []

    def __init__(self, **kw):
        self.kw, self.started, self.stopped, self.claims = kw, False, False, []
        FakeVoiceLeader.made.append(self)

    def start(self):
        self.started = True

    def claim_control(self, timeout_s):
        self.claims.append(timeout_s)
        return False                     # the visitor still drives: must not crash

    def ticks(self, hz):
        return iter(())

    def stop(self):
        self.stopped = True


def ctx(**kw):
    return SimpleNamespace(**{"room_id": "room-1", "token": "tok", "metadata": {}, **kw})


@pytest.fixture
def fake_leader(monkeypatch):
    FakeVoiceLeader.made = []
    monkeypatch.setattr(worker, "StudioVoiceLeader", FakeVoiceLeader)
    return FakeVoiceLeader


def test_make_agent_speaks_hindi_when_dispatched_with_it(fake_leader):
    agent = worker.make_agent(ctx(metadata={"language": "hi"}))
    assert isinstance(agent, StudioRobotAgent)
    assert agent._language == "hi"
    agent.link.join(timeout=5)
    leader = fake_leader.made[0]
    assert leader.kw["meeting_id"] == "room-1" and leader.kw["token"] == "tok"
    assert leader.started


@pytest.mark.parametrize("metadata", [{}, {"language": "fr"}, {"language": None}])
def test_make_agent_defaults_to_english(fake_leader, metadata):
    assert worker.make_agent(ctx(metadata=metadata))._language == "en"


def test_make_agent_falls_back_to_the_env_token(fake_leader, monkeypatch):
    monkeypatch.setenv("ZERORUNTIME_AUTH_TOKEN", "env-tok")
    worker.make_agent(ctx(token=""))
    assert fake_leader.made[0].kw["token"] == "env-tok"


def test_serves_template_context_without_joining_a_room(fake_leader):
    """serve() builds one agent from an empty AgentContext to check the factory."""
    from zeroruntime import AgentContext
    agent = worker.make_agent(AgentContext())
    assert isinstance(agent, StudioRobotAgent) and fake_leader.made == []


def test_on_exit_stops_the_arm_then_leaves(fake_leader):
    agent = worker.make_agent(ctx())
    agent.link.join(timeout=5)
    order = []
    agent.ctl.stop = lambda: order.append("ctl")
    fake_leader.made[0].stop = lambda: order.append("leader")
    asyncio.run(agent.on_exit())
    assert order == ["ctl", "leader"]


def test_the_leader_targets_studio_with_the_studio_schema():
    assert worker.StudioVoiceLeader.target_robot_id == "studio-so101"
    leader = worker.StudioVoiceLeader(meeting_id="r", token="t", fps=30)
    assert leader.descriptor_.schema_hash == "42f4c231"


def test_cleanup_without_on_exit_stops_the_arm_then_leaves(fake_leader):
    """The SDK guarantees cleanup(), not on_exit (a refused job skips it)."""
    agent = worker.make_agent(ctx())
    agent.link.join(timeout=5)
    order = []
    agent.ctl.stop = lambda: order.append("ctl")
    fake_leader.made[0].stop = lambda: order.append("leader")
    asyncio.run(agent.cleanup())
    assert order == ["ctl", "leader"] and agent.stopped.is_set()


def test_teardown_runs_once_however_it_is_reached(fake_leader):
    agent = worker.make_agent(ctx())
    agent.link.join(timeout=5)
    order = []
    agent.ctl.stop = lambda: order.append("ctl")
    fake_leader.made[0].stop = lambda: order.append("leader")
    asyncio.run(agent.on_exit())
    asyncio.run(agent.cleanup())
    asyncio.run(agent.on_exit())
    assert order == ["ctl", "leader"]


def test_template_agent_tears_down_quietly(fake_leader):
    from zeroruntime import AgentContext
    agent = worker.make_agent(AgentContext())
    asyncio.run(agent.cleanup())
    asyncio.run(agent.on_exit())


# -- the leader thread: join, claim until granted, drive ------------------------

class LinkLeader:
    """Ticks at 30 Hz on a fake clock; grants on the `grant_on`-th claim."""

    def __init__(self, grant_on=None, seconds=90.0):
        self.grant_on, self.n = grant_on, int(seconds * 30)
        self.t, self.claims, self.has_control = 0.0, [], False
        self.events = []

    def start(self):
        self.events.append("start")

    def claim_control(self, timeout_s):
        self.claims.append(self.t)
        assert timeout_s == 0                    # never a blocking wait
        if len(self.claims) == self.grant_on:
            self.has_control = True
        return self.has_control

    def ticks(self, hz):
        for i in range(self.n):
            self.t = i / hz
            yield i

    def stop(self):
        self.events.append("stop")


class Steps:
    def __init__(self):
        self.n = 0

    def step(self):
        self.n += 1


def link(leader, stopped=None):
    steps = Steps()
    worker._link(leader, steps, "room-1", stopped or threading.Event(),
                 clock=lambda: leader.t)
    return steps


def test_link_keeps_claiming_until_the_nth_claim_is_granted():
    leader = LinkLeader(grant_on=4)
    steps = link(leader)
    assert leader.claims == pytest.approx([0.0, 1.5, 3.0, 4.5], abs=0.04)
    assert steps.n == leader.n                   # claiming never skipped a tick


def test_link_stops_claiming_after_the_window():
    leader = LinkLeader(grant_on=None)
    steps = link(leader)
    assert len(leader.claims) == int(worker.CLAIM_WINDOW_S / worker.CLAIM_EVERY_S) + 1
    assert leader.claims[-1] == pytest.approx(worker.CLAIM_WINDOW_S, abs=0.04)
    assert steps.n == leader.n


def test_link_claims_once_when_granted_at_once():
    leader = LinkLeader(grant_on=1)
    link(leader)
    assert leader.claims == [0.0]


def test_link_leaves_at_once_if_torn_down_while_joining():
    leader, stopped = LinkLeader(grant_on=1), threading.Event()
    stopped.set()                                # stop() landed before start() cleared it
    steps = link(leader, stopped)
    assert leader.events == ["start", "stop"]
    assert leader.claims == [] and steps.n == 0


# -- Studio's words for a lost arm ----------------------------------------------

class ArmLeader:
    """The Leader members MotionController.health() reads. `oid_step` 0 freezes
    the joint state, as when the visitor's tab has gone."""
    peer_id = "voice-agent"

    def __init__(self, has_control=True, holder=None, oid_step=1):
        self.has_control, self.robot_lease_holder, self.oid_step = has_control, holder, oid_step
        self.robot_safe_state, self.remote_stats, self.oid = "active", [], 0

    def observation(self):
        self.oid += self.oid_step
        return SimpleNamespace(joints=dict(HOME), images={}, observation_id=self.oid)


class Clock:
    def __init__(self):
        self.t = 0.0

    def __call__(self):
        return self.t


def studio_ctl(leader):
    clock = Clock()
    return clock, studio_agent.StudioMotionController(leader, fps=30, clock=clock)


def test_a_gone_tab_reads_as_the_session_ending():
    leader = ArmLeader(oid_step=0)
    clock, ctl = studio_ctl(leader)
    ctl.measured()
    clock.t += 10.0
    assert ctl.health() == {"ok": False, "problem": studio_agent.SESSION_OVER}


def test_losing_control_with_a_gone_tab_reads_as_the_session_ending():
    leader = ArmLeader(has_control=False, holder="voice-agent", oid_step=0)
    clock, ctl = studio_ctl(leader)
    ctl.measured()
    clock.t += 10.0
    assert ctl.health()["problem"] == studio_agent.SESSION_OVER


def test_the_visitor_holding_the_arm_reads_as_the_visitor_driving():
    clock, ctl = studio_ctl(ArmLeader(has_control=False, holder="studio-robot-1"))
    assert ctl.health() == {"ok": False, "problem": studio_agent.VISITOR_DRIVING}


def test_nobody_holding_the_arm_yet_reads_as_not_handed_over():
    clock, ctl = studio_ctl(ArmLeader(has_control=False, holder=None))
    assert ctl.health() == {"ok": False, "problem": studio_agent.NOT_HANDED_OVER}


def test_a_healthy_arm_and_other_faults_keep_voice_words():
    from motion import ROBOT_FAULT
    clock, ctl = studio_ctl(ArmLeader())
    assert ctl.health() == {"ok": True, "problem": None}
    leader = ArmLeader()
    leader.robot_safe_state = "holding (robot_fault)"
    assert studio_ctl(leader)[1].health()["problem"] == ROBOT_FAULT


def test_make_agent_uses_studio_words(fake_leader):
    agent = worker.make_agent(ctx())
    agent.link.join(timeout=5)
    assert isinstance(agent.ctl, studio_agent.StudioMotionController)
