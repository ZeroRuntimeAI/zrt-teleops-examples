import asyncio
import json
from concurrent.futures import Future
from types import SimpleNamespace

import pytest

import agent
import skills


class FakeCtl:
    def __init__(self, result=None, healthy=True):
        self.commands, self.stops, self.policies, self.dances = [], 0, [], []
        self.music_frames, self.music_stops = [], 0
        self.result = {"joints": {"gripper": 100.0}} if result is None else result
        self.healthy = healthy
        self.policy_outcome = {"ended": "done", "ran_s": 12.0}
        self.running = None

    def _done(self, value):
        fut = Future()
        fut.set_result(value)
        return fut

    def command(self, motion):
        self.commands.append(motion)
        return self._done(self.result)

    def stop(self):
        self.stops += 1

    def state(self):
        return {"mode": "idle", "control": True, "joints": {"gripper": 3.0}}

    def health(self):
        return ({"ok": True, "problem": None} if self.healthy else
                {"ok": False, "problem": "My servos report a fault"})

    def start_policy(self, task, infer, timeout_s):
        self.policies.append((task, infer, timeout_s))
        return self._done(self.policy_outcome)

    def start_dance(self, mood):
        self.dances.append(mood)
        return Future()

    def current(self):
        return self.running

    def clock(self):
        return 500.0

    def music(self, bpm, beat_at, energy):
        self.music_frames.append((bpm, beat_at, energy))

    def music_stop(self):
        self.music_stops += 1


def fake_agent(ctl=None, infer=None):
    events = []

    async def publish(payload):
        events.append(payload)

    me = SimpleNamespace(ctl=ctl or FakeCtl(), infer=infer, _publish=publish,
                         session=None)
    return me, events


def call(tool, me, *args):
    return asyncio.run(tool(me, *args))


# -- run_tool -------------------------------------------------------------------

def test_run_tool_wraps_a_plain_result_and_tells_the_page():
    me, events = fake_agent()
    out = asyncio.run(agent.run_tool("x", {"a": 1}, lambda: {"v": 2}, me._publish))
    assert out == {"ok": True, "v": 2}
    assert events == [{"t": "tool", "name": "x", "args": {"a": 1}, "ok": True,
                       "result": {"ok": True, "v": 2}}]


def test_run_tool_awaits_a_motion_future():
    me, _ = fake_agent()
    fut = Future()
    fut.set_result({"joints": {"gripper": 1.0}})
    out = asyncio.run(agent.run_tool("x", {}, lambda: fut, me._publish))
    assert out == {"ok": True, "joints": {"gripper": 1.0}}


@pytest.mark.parametrize("result,error", [
    ({"cancelled": True}, "interrupted by a newer command"),
    ({"error": "no joint state"}, "no joint state"),
])
def test_run_tool_reports_cancelled_and_failed_motions(result, error):
    me, _ = fake_agent()
    fut = Future()
    fut.set_result(result)
    assert asyncio.run(agent.run_tool("x", {}, lambda: fut, me._publish)) == \
        {"ok": False, "error": error}


def test_run_tool_turns_exceptions_into_errors():
    me, events = fake_agent()

    def boom():
        raise ValueError("unknown skill 'x'")

    out = asyncio.run(agent.run_tool("x", {}, boom, me._publish))
    assert out == {"ok": False, "error": "unknown skill 'x'"}
    assert events[-1]["ok"] is False


# -- tools ----------------------------------------------------------------------

def test_set_gripper_clamps_and_moves():
    me, _ = fake_agent()
    out = call(agent.RobotAgent.set_gripper, me, 150)
    assert out["ok"] and me.ctl.commands == [skills.gripper(100)]


def test_move_joint_with_an_unknown_joint_says_which_exist():
    me, _ = fake_agent()
    out = call(agent.RobotAgent.move_joint, me, "elbow", 10)
    assert out["ok"] is False and "shoulder_pan" in out["error"]
    assert me.ctl.commands == []


def test_perform_runs_the_named_skill():
    me, _ = fake_agent()
    assert call(agent.RobotAgent.perform, me, "Wave")["ok"]
    assert me.ctl.commands == [skills.GESTURES["wave"]]


def test_perform_docstring_names_every_skill():
    doc = agent.RobotAgent.perform.__doc__
    assert all(name in doc for name in skills.SKILLS)


def test_get_robot_state():
    me, _ = fake_agent()
    out = call(agent.RobotAgent.get_robot_state, me)
    assert out == {"ok": True, "mode": "idle", "control": True,
                   "joints": {"gripper": 3.0}}


def test_stop_stops():
    me, _ = fake_agent()
    assert call(agent.RobotAgent.stop, me)["ok"] and me.ctl.stops == 1


def test_pick_up_without_the_model_explains_how_to_turn_it_on():
    me, _ = fake_agent(infer=None)
    out = call(agent.RobotAgent.pick_up, me, "red cube")
    assert out["ok"] is False and "PICKUP" in out["error"]


def test_pick_up_waits_for_the_policy_and_reports_how_it_ended():
    infer = object()
    me, _ = fake_agent(infer=infer)
    out = call(agent.RobotAgent.pick_up, me, " the red cube ")
    assert out == {"ok": True, "ended": "done", "ran_s": 12.0}
    assert me.ctl.policies == [("Move the arm towards the red cube, grasp it, and lift it up.",
                                infer, agent.PICK_TIMEOUT_S)]


def test_place_moves_over_the_target_and_releases():
    infer = object()
    me, _ = fake_agent(infer=infer)
    assert call(agent.RobotAgent.place, me, "the box")["ok"]
    assert me.ctl.policies[0][0] == "Move the arm over the box and release the object into it."


def test_a_failed_policy_is_not_ok():
    me, _ = fake_agent(infer=object())
    me.ctl.policy_outcome = {"ended": "error", "ran_s": 0.0, "error": "My pick-up model failed: x."}
    out = call(agent.RobotAgent.pick_up, me, "cube")
    assert out["ok"] is False and "failed" in out["error"]


@pytest.mark.parametrize("tool,args", [
    ("set_gripper", (50,)), ("move_joint", ("shoulder_pan", 10)), ("perform", ("wave",)),
    ("pick_up", ("cube",)), ("place", ("box",)), ("dance", ("smooth",)),
])
def test_an_unhealthy_arm_refuses_to_move_and_says_why(tool, args):   # Review Focus 2
    me, _ = fake_agent(ctl=FakeCtl(healthy=False), infer=object())
    out = call(getattr(agent.RobotAgent, tool), me, *args)
    assert out == {"ok": False, "error": "My servos report a fault"}
    assert not (me.ctl.commands or me.ctl.policies or me.ctl.dances)


def test_wait_for_robot_waits_for_the_running_intent():
    me, _ = fake_agent()
    fut = Future()
    fut.set_result({"ended": "done", "ran_s": 3.0})
    me.ctl.running = fut
    assert call(agent.RobotAgent.wait_for_robot, me) == {"ok": True, "ended": "done", "ran_s": 3.0}


def test_wait_for_robot_when_nothing_is_running_says_so():
    me, _ = fake_agent()
    out = call(agent.RobotAgent.wait_for_robot, me)
    assert out["ok"] and out["idle"] is True and out["mode"] == "idle"


def test_dance_starts_with_a_mood_and_returns_at_once():
    me, _ = fake_agent()
    out = call(agent.RobotAgent.dance, me, "Smooth")
    assert out == {"ok": True, "dancing": "smooth"} and me.ctl.dances == ["Smooth"]


def test_the_robot_speaks_as_itself_and_finishes_what_it_starts():
    text = agent.instructions("en")
    assert "you ARE the robot" in text
    assert "Shall I continue" in text and "look" in text and "3 tries" in text
    assert "Don't retry those" in text


# -- the page's STOP button (Review Focus 5) -----------------------------------

def test_stop_from_the_page():
    ctl = FakeCtl()
    assert agent.handle_ctrl({"message": json.dumps({"cmd": "stop"})}, False, ctl) == "stop"
    assert ctl.stops == 1


@pytest.mark.parametrize("frame,backlog", [
    ({"message": json.dumps({"cmd": "stop"})}, True),     # replayed on join
    ({"message": "not json"}, False),
    ({"message": "[1, 2]"}, False),
    ({"message": json.dumps({"cmd": "dance"})}, False),
    ({}, False),
    ("stop", False),
    (None, False),
])
def test_malformed_or_replayed_page_messages_are_ignored(frame, backlog):
    ctl = FakeCtl()
    assert agent.handle_ctrl(frame, backlog, ctl) is None
    assert ctl.stops == 0


def test_music_frames_reach_the_dance_on_the_controller_clock():
    ctl = FakeCtl()
    frame = {"message": json.dumps({"cmd": "music", "bpm": 120, "beat_at": 999_500,
                                    "energy": 0.7, "now": 1_000_000})}
    assert agent.handle_ctrl(frame, False, ctl, now=lambda: 1000.0) == "music"
    (bpm, beat_at, energy), = ctl.music_frames
    assert (bpm, energy) == (120.0, 0.7) and beat_at == pytest.approx(500.0 - 0.5)


def test_music_stop_reaches_the_dance():
    ctl = FakeCtl()
    assert agent.handle_ctrl({"message": '{"cmd": "music_stop"}'}, False, ctl) == "music_stop"
    assert ctl.music_stops == 1


@pytest.mark.parametrize("msg", [                                   # Review Focus 1
    {"cmd": "music", "bpm": 0, "beat_at": 1, "energy": 0.5},
    {"cmd": "music", "bpm": 999, "beat_at": 1, "energy": 0.5},
    {"cmd": "music", "bpm": "fast", "beat_at": 1, "energy": 0.5},
    {"cmd": "music", "bpm": 120, "energy": 0.5},
    {"cmd": "music", "bpm": float("nan"), "beat_at": 1, "energy": 0.5},
])
def test_bad_music_frames_are_ignored(msg):
    ctl = FakeCtl()
    assert agent.handle_ctrl({"message": json.dumps(msg)}, False, ctl) is None
    assert ctl.music_frames == []


# -- languages ------------------------------------------------------------------

def test_english_speaks_through_deepgram_and_cartesia():
    s = agent.speech("en")
    assert type(s["stt"]).__name__ == "DeepgramSTT"
    assert type(s["tts"]).__name__ == "CartesiaTTS"


def test_hindi_hears_through_deepgram_and_speaks_through_sarvam():
    s = agent.speech("hi")
    assert type(s["stt"]).__name__ == "DeepgramSTT" and s["stt"].language == "hi"
    assert any(k.startswith("cube") for k in s["stt"].keywords)
    assert type(s["tts"]).__name__ == "SarvamAITTS" and s["tts"].language == "hi-IN"


def test_hindi_is_the_default(monkeypatch):
    import importlib
    monkeypatch.delenv("ZERORUNTIME_LANGUAGE", raising=False)
    try:
        assert importlib.reload(agent).LANGUAGE == "hi"
    finally:
        monkeypatch.undo()
        importlib.reload(agent)


def test_an_unknown_language_says_which_exist():
    with pytest.raises(SystemExit) as exc:
        agent.speech("fr")
    assert "en" in str(exc.value) and "hi" in str(exc.value)


def test_hindi_instructions_answer_in_the_speakers_language():
    assert "Devanagari" in agent.instructions("hi")
    assert "Devanagari" not in agent.instructions("en")
    assert set(agent.GREETINGS) == {"en", "hi"}


def test_the_agent_is_built_in_the_language_asked_for():
    built = agent.RobotAgent(ctl=None, language="hi")
    assert type(built.pipeline.stt).__name__ == "DeepgramSTT"
    assert "Devanagari" in built.instructions


# -- warming the policy on the live cameras -----------------------------------

class _Frame:
    released = False

    def release(self):
        self.released = True


class _Watch:
    def __init__(self, images, cameras=None):
        self.images = images
        self.cameras = list(images) if cameras is None else cameras

    def observation(self):
        return SimpleNamespace(images=dict(self.images),
                               joints={j: 0.0 for j in skills.JOINTS})


def test_warm_policy_runs_one_inference_on_live_frames_and_releases_them():
    frame, seen = _Frame(), []
    agent.warm_policy(_Watch({"cam1": frame}), lambda obs, task: seen.append(list(obs.images)))
    assert seen == [["cam1"]] and frame.released


def test_warm_policy_gives_up_quietly_without_frames():
    seen = []
    agent.warm_policy(_Watch({}), lambda obs, task: seen.append(1), wait_s=0.3)
    assert seen == []


def test_a_failed_warm_up_does_not_take_the_agent_down():
    def broken(obs, task):
        raise RuntimeError("mps out of memory")

    agent.warm_policy(_Watch({"cam1": _Frame()}), broken)     # no exception


def test_warm_policy_waits_for_every_camera():
    """Live: it warmed on the first camera to arrive, then the 3-camera
    pick-up paid the MPS recompile anyway."""
    seen = []
    one_of_three = _Watch({"cam0": _Frame()}, cameras=["cam0", "cam1", "cam2"])
    agent.warm_policy(one_of_three, lambda obs, task: seen.append(1), wait_s=0.3)
    assert seen == []


def test_english_hearing_boosts_the_robots_words():
    """Live: 'orange cube' came out as 'orange tube'. Boosted through Nova-2
    keywords -- the gateway rejects nova-3 ('Unsupported model')."""
    stt = agent.speech("en")["stt"]
    assert stt.model != "nova-3"
    assert any(k.split(":")[0] == "cube" for k in stt.keywords)


# -- a tool interrupted by the speaker (final review) ----------------------------

def test_an_interrupted_tool_leaves_the_running_intent_for_wait_for_robot(tmp_path):
    """The SDK cancels a tool's task when the speaker talks over it. That must
    not cancel the controller's future: wait_for_robot waits on it next."""
    import events
    log = events.open_log(tmp_path, "cancel")
    me, _ = fake_agent(infer=object())
    running = Future()
    me.ctl.start_policy = lambda task, infer, timeout_s: running

    async def interrupt():
        task = asyncio.ensure_future(agent.RobotAgent.pick_up(me, "cube"))
        await asyncio.sleep(0.01)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    asyncio.run(interrupt())
    assert not running.cancelled()
    lines = [json.loads(l) for l in log.read_text().splitlines()]
    assert lines[-1]["kind"] == "tool" and lines[-1]["name"] == "pick_up"
    assert lines[-1]["result"]["error"] == "interrupted"


def test_hindi_keeps_every_tool_argument_in_english_and_hears_hindi_stops():
    """MolmoAct2 reads the pick-up item; a Devanagari "लाल क्यूब" would be
    noise to it, and an unknown mood silently becomes playful."""
    text = agent.instructions("hi")
    assert "object names" in text and "moods" in text
    assert "रुको" in text


def test_the_voice_session_survives_the_page_leaving():
    """Live: closing or reloading the page ended the voice session for good
    (the SDK's default auto_end_session); ./demo.sh down is what ends it."""
    room = agent.voice_room("abcd-efgh")
    assert room.room_id == "abcd-efgh" and room.vision is True
    assert room.auto_end_session is False


def test_the_voice_session_outlasts_a_long_demo():
    """Live: two sessions ended by themselves about 15 minutes in -- the
    runtime's default ceiling. A demo runs until ./demo.sh down."""
    assert agent.voice_room("abcd-efgh").session_timeout_seconds == agent.SESSION_HOURS * 3600
    assert agent.SESSION_HOURS >= 4


def test_the_voice_session_waits_for_the_page_to_come_back():
    """Live: the page left (tab closed or discarded) and the session ended
    ~5 minutes later -- the runtime's default no-participant timeout."""
    room = agent.voice_room("abcd-efgh")
    assert room.no_participant_timeout_seconds == agent.SESSION_HOURS * 3600


def test_the_robot_is_honest_about_its_one_camera_view():
    """Live: it said it saw the user's hand "in the gripper camera", which
    can't see it. look gets one camera view and not which camera it is."""
    text = agent.instructions("en")
    assert "one camera view" in text and "which camera" in text


def test_questions_about_what_it_just_did_need_no_tool():
    """Live: "what is this pose called?" ran wait_for_robot instead of an answer."""
    assert "from memory" in agent.instructions("en")
