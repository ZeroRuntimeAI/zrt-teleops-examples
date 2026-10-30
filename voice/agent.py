#!/usr/bin/env python3
"""
The voice side: a Zero Runtime agent that hears you, reasons, and moves the
arm -- joined to the robot's room next to a teleops Leader.

    python agent.py

Start ../so101/follower.py first, with the same ZERORUNTIME_MEETING_ID in
so101/.env and voice/.env. This prints a link: open it, click Join, talk.

One process, two participants: the teleops leader that drives the arm, and
the voice agent that hears you. A tool reaches the arm as a plain method
call -- nothing is serialised between them.

Ctrl-c stops the arm where it is; the follower holds it.

SETTINGS -- edit the block below the imports:

    LLM_MODEL       the model that reasons over what you said and picks tools
    LANGUAGE        "hi" (default; also hears English) or "en" -- ZERORUNTIME_LANGUAGE
    GREETINGS       what the agent says when it joins, per language
    PICKUP          load the experimental MolmoAct2 pick-up -- ZERORUNTIME_PICKUP=1
    PICK_TIMEOUT_S  how long one pick-up or place attempt may run

Logs: voice/logs/events-<time>.jsonl -- one JSON line per thing heard, tool
run, policy inference and dance phrase.

Needs ZERORUNTIME_AUTH_TOKEN and ZERORUNTIME_MEETING_ID -- see .env.example.
"""

import asyncio
import functools
import http.server
import inspect
import json
import logging
import os
import threading
import time
import traceback
from concurrent.futures import Future
from urllib.parse import quote

import zeroruntime
from zeroruntime import (Agent, Pipeline, PubSubPublishConfig,
                         PubSubSubscribeConfig, Room, function_tool)
from zeroruntime.inference import (CartesiaTTS, DeepgramSTT, GoogleLLM,
                                   SarvamAITTS, TurnDetector)
from zeroruntime.plugins import SileroVAD

import dance as dance_mod          # the agent has a tool named dance
import events
import skills
from config import FPS, HERE, WEB_PORT, required
from motion import MotionController, VoiceLeader

_log = logging.getLogger("voice")

# ── Settings ───────────────────────────────────────────────────────────────

#: Reasons over what you said and picks the tools. Runs on the Zero Runtime
#: gateway, on your token.
LLM_MODEL = "gemini-3.5-flash"

#: "hi": Deepgram Hindi + Sarvam voice -- hears Hindi, English and Hinglish,
#: answers in whichever you spoke. "en": Deepgram + Cartesia.
#: ZERORUNTIME_LANGUAGE in .env.
LANGUAGE = os.getenv("ZERORUNTIME_LANGUAGE", "hi")

#: What the agent says when it joins, per language.
GREETINGS = {
    "en": "Robot arm online. Tell me what to do.",
    "hi": "रोबोट आर्म तैयार है। बताइए, क्या करना है?",
}

#: Load MolmoAct2 for pick_up/place: ZERORUNTIME_PICKUP=1 in .env.
#: Experimental: 21.8 GB on first start, ~14 GB of memory.
PICKUP = os.getenv("ZERORUNTIME_PICKUP", "0") == "1"

#: One pick-up attempt runs at most this long, then the arm holds.
PICK_TIMEOUT_S = 30.0

#: How long the model waits for a tool: a pick-up is up to 30 s of motion
#: plus a slow first inference.
TOOL_TIMEOUT_S = 120

#: How often the page gets the arm's joints.
STATE_HZ = 2.0

#: How long one voice session may last, and may wait for the page to come
#: back. Unset, the runtime ends it after ~15 minutes, or ~5 minutes after
#: the page leaves. ./demo.sh down ends it sooner.
SESSION_HOURS = 4

# ───────────────────────────────────────────────────────────────────────────

#: Pubsub topics shared with web/index.html.
EVENTS = "ROBOT_EVENTS"
CTRL = "ROBOT_CTRL"

INSTRUCTIONS = """\
You are a robot: an SO-101 arm with a two-finger gripper and cameras. You are
not an assistant operating a robot -- you ARE the robot. Speak in first
person about your own body ("I'm opening my gripper", "I can see a cube in
front of me"). You act only through your tools.

- If you hear stop, freeze, wait, halt or "no!", call stop FIRST.
- Simple requests: call the tool, then say what happened in one short sentence.
- Goals with several parts ("pick up the cube and put it in the box"): plan
  the steps silently. For each step: act, call look to check it worked, then
  move on. If a check fails, retry that step -- at most 3 tries -- adjusting
  first if that helps (move_joint toward the object, or perform "ready").
  After 3 failed tries, stop and say what failed.
- Say one short sentence of progress per step ("Got the cube, moving to the box").
- Never end your turn with a goal unfinished in silence. If you stop before
  the goal is done, for any reason, ask "Shall I continue with <next step>?"
  and carry on if the answer is yes.
- If you were interrupted mid-step by anything but stop, call wait_for_robot,
  then continue.
- If a tool says something is wrong with your body (not connected, servo
  fault, no position updates, a joint didn't reach), stop the goal and tell
  the user plainly what is wrong and what they can check. Don't retry those.
- To dance, call dance with a mood (energetic, smooth, robotic, playful)
  that fits what was asked or how the music feels. Named moves and poses are
  perform.
- pick_up and place are experimental and often miss: say you're trying, and
  check with look before saying it worked.
- look shows you one camera view, and you are not told which camera it is
  (you have a wrist, a top and a side camera). If asked which camera you see
  through, say you don't know. Describe only what is in that image; never
  claim what another camera shows.
- Questions about what you just did ("what is this pose called?") are
  answered from memory, without a tool.
- Report only what tools returned. One short sentence per reply.
"""

#: Added for LANGUAGE = "hi". Sarvam's voice reads Hindi from Devanagari,
#: so romanized Hindi would be read out as English.
HINDI = """
- Reply in the language the user spoke: Hindi in Devanagari script, English
  in English. Every tool argument is in English, whatever language you
  heard: object names ("red cube", not "लाल क्यूब"), places, moods, skill and
  joint names.
- रुको, रुक जाओ, बस, ठहरो mean stop: call stop FIRST.
"""


def instructions(language: str) -> str:
    return INSTRUCTIONS + (HINDI if language == "hi" else "")


#: Words speech-to-text should favour: live, "orange cube" came out as
#: "orange tube". Add the objects on your table.
KEYTERMS = ["cube", "gripper", "wrist", "elbow", "shoulder", "box", "charger",
            "wave", "nod"]


def speech(language: str) -> dict:
    """The ears and voice of the pipeline, for one language."""
    boost = [f"{k}:2" for k in KEYTERMS]
    if language == "en":
        # Nova-2 keywords. (Nova-3 keyterms would be nicer; the gateway
        # rejects nova-3: "Unsupported model".)
        return {"stt": DeepgramSTT(keywords=boost), "tts": CartesiaTTS()}
    if language == "hi":
        # Deepgram's Hindi model also catches English and Hinglish.
        return {"stt": DeepgramSTT(language="hi", keywords=boost),
                "tts": SarvamAITTS(language="hi-IN")}
    raise SystemExit(f"ZERORUNTIME_LANGUAGE={language!r}: use one of "
                     f"{', '.join(GREETINGS)}")


async def run_tool(name: str, args: dict, start, publish) -> dict:
    """Run one tool body and turn every outcome into JSON the model can read.

    `start()` returns a dict, a Future of one (a motion), or an awaitable.
    An exception becomes {"ok": false, "error": ...}: the model is told what
    went wrong instead of the turn dying. The page hears about every call.

    A motion's Future is shielded: when the speaker talks over a tool, the
    SDK cancels the tool, but the arm's intent keeps running for
    wait_for_robot to wait on -- only stop() or a new command ends it.
    """
    t0 = time.perf_counter()
    try:
        out = start()
        if isinstance(out, Future):
            out = await asyncio.shield(asyncio.wrap_future(out))
        elif inspect.isawaitable(out):
            out = await out
        if out.get("cancelled"):
            result = {"ok": False, "error": "interrupted by a newer command"}
        elif "error" in out:
            result = {"ok": False, "error": out["error"]}
        else:
            result = {"ok": True, **out}
    except asyncio.CancelledError:
        events.log("tool", name=name, args=args,
                   result={"ok": False, "error": "interrupted"},
                   ms=round((time.perf_counter() - t0) * 1e3))
        raise
    except Exception as exc:
        result = {"ok": False, "error": str(exc)}
    events.log("tool", name=name, args=args, result=result,
               ms=round((time.perf_counter() - t0) * 1e3))
    await publish({"t": "tool", "name": name, "args": args,
                   "ok": result["ok"], "result": result})
    return result


PICKUP_OFF = "pick-up is off on this machine: set ZERORUNTIME_PICKUP=1 in voice/.env"


def _bare(s: str) -> str:
    s = str(s).strip()
    return s[4:].strip() if s.lower().startswith("the ") else s


def pick_task(item: str) -> str:
    """In the words MolmoAct2's data was labelled with -- "Move the arm
    towards the lemon, grasp it, lift it up, ..." -- not "pick up the lemon"."""
    return f"Move the arm towards the {_bare(item)}, grasp it, and lift it up."


def place_task(into: str) -> str:
    return f"Move the arm over the {_bare(into)} and release the object into it."


def checked(ctl, start):
    """`start`, but only on an arm that can move -- otherwise the reason,
    in words the agent can say."""
    def go():
        h = ctl.health()
        if not h["ok"]:
            raise RuntimeError(h["problem"])
        return start()
    return go


def handle_ctrl(frame, backlog: bool, ctl, now=time.time) -> str | None:
    """Act on one frame from the page: "stop", "music" or "music_stop".
    Returns what it did, or None. Anything malformed is ignored -- the page
    is a peer in the room, not trusted to be well-formed. A backlog replay
    on join is ignored too."""
    if backlog:
        return None
    try:
        msg = json.loads(frame.get("message") or "")
        cmd = msg.get("cmd")
    except (ValueError, AttributeError, TypeError):
        return None
    if cmd == "stop":
        ctl.stop()
        return "stop"
    if cmd == "music_stop":
        ctl.music_stop()
        return "music_stop"
    if cmd != "music":
        return None
    try:
        bpm, beat_at, energy = (skills.number(msg.get(k), k)
                                for k in ("bpm", "beat_at", "energy"))
    except ValueError:
        return None
    if not 40 <= bpm <= 220:
        return None
    # The page's beat on the controller's clock. Page and agent share a wall
    # clock (same machine, or NTP), so "how long ago" carries over.
    ago = max(0.0, now() - beat_at / 1000.0)
    ctl.music(bpm, ctl.clock() - ago, energy)
    return "music"


class RobotAgent(Agent):
    """The voice. Every tool is a thin call into the MotionController."""

    def __init__(self, ctl, infer=None, language: str = LANGUAGE) -> None:
        self.ctl = ctl                  # before super(): it registers the tools
        self.infer = infer
        self._language = language
        self._ticker = None
        pipeline = Pipeline(**speech(language), llm=GoogleLLM(model=LLM_MODEL),
                            vad=SileroVAD(), turn_detector=TurnDetector())
        # Observers only: they tell the page, they never change the turn.
        pipeline.on("user_turn_start", self._heard)
        pipeline.on("user_turn_end", self._thinking)
        pipeline.on("agent_turn_start", self._speaking)
        pipeline.on("agent_turn_end", self._listening)
        super().__init__(instructions=instructions(language), pipeline=pipeline,
                         tool_timeout_seconds=TOOL_TIMEOUT_S)

    # -- lifecycle -------------------------------------------------------------

    async def on_enter(self) -> None:
        await self.session.subscribe_to_pubsub(
            PubSubSubscribeConfig(topic=CTRL, cb=self._on_ctrl))
        self._ticker = asyncio.create_task(self._send_state())
        await self.session.say(GREETINGS[self._language])

    async def on_exit(self) -> None:
        if self._ticker is not None:
            self._ticker.cancel()

    # -- the page --------------------------------------------------------------

    async def _publish(self, payload: dict) -> None:
        """Tell the page. Never raises: a lost log line must not fail a tool."""
        if self.session is None:
            return
        try:
            await self.session.publish_to_pubsub(
                PubSubPublishConfig(topic=EVENTS, message=json.dumps(payload)))
        except Exception:
            _log.exception("could not publish %s", payload.get("t"))

    async def _on_ctrl(self, frame, backlog) -> None:
        done = handle_ctrl(frame, backlog, self.ctl)
        if done:
            events.log("ctrl", cmd=done)
        if done == "stop":
            await self._publish({"t": "tool", "name": "stop",
                                 "args": {"from": "page"}, "ok": True,
                                 "result": {"ok": True}})

    async def _send_state(self) -> None:
        while True:
            await asyncio.sleep(1.0 / STATE_HZ)
            try:
                state = await asyncio.to_thread(self.ctl.state)
            except Exception:
                _log.exception("reading the arm's state")
                continue
            await self._publish({"t": "state", **state})

    async def _heard(self, transcript: str = "") -> None:
        if transcript:
            events.log("heard", text=transcript)
            await self._publish({"t": "heard", "text": transcript})

    async def _thinking(self) -> None:
        await self._publish({"t": "agent", "state": "thinking"})

    async def _speaking(self) -> None:
        await self._publish({"t": "agent", "state": "speaking"})

    async def _listening(self) -> None:
        await self._publish({"t": "agent", "state": "listening"})

    # -- tools: the docstrings are what the model reads -----------------------

    @function_tool
    async def set_gripper(self, percent: float) -> dict:
        """Open or close the gripper.

        Args:
            percent: How open, 0 to 100. "Open" is 100, "close" is 0,
                "halfway" is 50.
        """
        return await run_tool("set_gripper", {"percent": percent},
                              checked(self.ctl, lambda: self.ctl.command(skills.gripper(percent))),
                              self._publish)

    @function_tool
    async def move_joint(self, joint: str, amount: float) -> dict:
        """Move one joint of the arm, relative to where it is now.

        What a positive amount does (negative goes the other way):
          shoulder_pan  -- turns the whole arm to the robot's right
          shoulder_lift -- swings the upper arm forward, out of its folded rest
          elbow_flex    -- folds the forearm in toward the upper arm
          wrist_flex    -- tips the gripper down
          wrist_roll    -- rolls the wrist clockwise, seen from behind

        So "turn left" is shoulder_pan with a negative amount, and "raise
        the gripper" is wrist_flex with a negative amount.

        Args:
            joint: One of shoulder_pan, shoulder_lift, elbow_flex, wrist_flex,
                wrist_roll.
            amount: Degrees. "A bit" is about 10, "a lot" about 30. Negative
                for the other direction.
        """
        return await run_tool("move_joint", {"joint": joint, "amount": amount},
                              checked(self.ctl, lambda: self.ctl.command(skills.nudge(joint, amount))),
                              self._publish)

    @function_tool
    async def perform(self, skill: str) -> dict:
        """Go to a named pose or perform a gesture.

        Poses: home, ready, rest, point_left, point_right, look_down.
        Gestures: wave, nod, shake_no, dance (a short fixed routine -- to
        really dance, to music or not, use the dance tool).

        Args:
            skill: One of the names above.
        """
        return await run_tool("perform", {"skill": skill},
                              checked(self.ctl, lambda: self.ctl.command(skills.named(skill))),
                              self._publish)

    @function_tool
    async def get_robot_state(self) -> dict:
        """The arm's current joint angles (degrees), gripper opening (0 closed,
        100 open), and whether it is idle, moving, or running a pick-up."""
        return await run_tool("get_robot_state", {}, self.ctl.state,
                              self._publish)

    @function_tool
    async def look(self, question: str) -> dict:
        """Look through the robot's camera and answer a question, out loud.
        Your answer is spoken by this tool -- don't repeat it afterwards.

        Args:
            question: What to look for, e.g. "what do you see?" or "is the
                gripper holding something?".
        """
        async def ask() -> dict:
            await self.session.reply(
                f"Answer from the robot camera image, in one sentence: {question}",
                frames=2)
            return {"answered_aloud": True}

        return await run_tool("look", {"question": question}, ask, self._publish)

    @function_tool
    async def pick_up(self, item: str) -> dict:
        """EXPERIMENTAL: grasp an object in front of me and lift it, with a
        learned policy. Waits until the attempt ends (up to about a minute)
        and says how it ended -- then check with look. Often misses.

        Args:
            item: What to pick up, e.g. "orange cube".
        """
        def start():
            if self.infer is None:
                raise RuntimeError(PICKUP_OFF)
            return self.ctl.start_policy(pick_task(item), self.infer, PICK_TIMEOUT_S)

        return await run_tool("pick_up", {"item": item}, checked(self.ctl, start),
                              self._publish)

    @function_tool
    async def place(self, into: str) -> dict:
        """EXPERIMENTAL: move what I'm holding over a target and let go, with
        a learned policy. Waits until the attempt ends. Check with look.

        Args:
            into: Where to put it, e.g. "box".
        """
        def start():
            if self.infer is None:
                raise RuntimeError(PICKUP_OFF)
            return self.ctl.start_policy(place_task(into), self.infer, PICK_TIMEOUT_S)

        return await run_tool("place", {"into": into}, checked(self.ctl, start),
                              self._publish)

    @function_tool
    async def wait_for_robot(self) -> dict:
        """Wait for whatever I'm still doing (a move, a pick-up) to finish and
        say how it ended. Use after being interrupted mid-step."""
        def start():
            fut = self.ctl.current()
            return fut if fut is not None else {"idle": True, **self.ctl.state()}

        return await run_tool("wait_for_robot", {}, start, self._publish)

    @function_tool
    async def dance(self, mood: str) -> dict:
        """Dance -- to the music playing near the user if there is any (I hear
        its beat), otherwise for about 20 seconds on my own beat.

        Args:
            mood: energetic, smooth, robotic or playful -- whatever fits the
                request or the music.
        """
        def start():
            self.ctl.start_dance(mood)          # runs until the music stops
            return {"dancing": dance_mod.mood_of(mood)}

        return await run_tool("dance", {"mood": mood}, checked(self.ctl, start),
                              self._publish)

    @function_tool
    async def stop(self) -> dict:
        """Stop the arm immediately. It holds where it is."""
        def start() -> dict:
            self.ctl.stop()
            return {"stopped": True}

        return await run_tool("stop", {}, start, self._publish)


# -- running it ---------------------------------------------------------------

def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    token = required("ZERORUNTIME_AUTH_TOKEN", "your access token")
    room = required("ZERORUNTIME_MEETING_ID", "the room the follower is in")
    # ZERORUNTIME_TARGET is optional: the SDK defaults to us2.zeroruntime.ai.
    stamp = time.strftime("%Y%m%d-%H%M%S")
    print(f"  events  {events.open_log(HERE / 'logs', stamp)}")
    print(f"  language {LANGUAGE}, pick-up {'on' if PICKUP else 'off'}")

    infer = None
    if PICKUP:
        # Before joining: a checkpoint that cannot load should fail here,
        # not after someone has started talking to the arm.
        from policy import load_policy
        infer = load_policy()

    leader = VoiceLeader(meeting_id=room, token=token, fps=FPS,
                         sync_buffer_ms=120.0)
    ctl = MotionController(leader, fps=FPS)
    leader.start()
    if not leader.claim_control(timeout_s=10):
        leader.stop()
        raise SystemExit(
            f"no control in {room}.\n"
            f"  Usually the follower isn't in the room: start ../so101/follower.py\n"
            f"  first, with the same ZERORUNTIME_MEETING_ID in so101/.env and\n"
            f"  voice/.env. Otherwise another leader holds control.")
    print(f"control granted, schema {leader.schema}")

    threading.Thread(target=_guarded, args=(_drive, leader, ctl),
                     name="leader", daemon=True).start()
    if infer is not None:
        threading.Thread(target=warm_policy, args=(leader, infer),
                         name="warm-policy", daemon=True).start()
    _serve_web(WEB_PORT)
    print(f"\n  open  http://localhost:{WEB_PORT}/?room={quote(room)}&token={quote(token)}\n"
          f"  (the link carries your token -- keep it off anything public)\n")

    try:
        zeroruntime.serve(
            lambda: RobotAgent(ctl, infer),
            room=Room(vision=True),
            on_ready=lambda: zeroruntime.invoke(
                room=voice_room(room)))
    finally:
        ctl.stop()
        time.sleep(3 / FPS)         # a few ticks for the leader thread to halt
        leader.stop()               # leaves the room; the follower holds


def voice_room(room_id: str) -> Room:
    """The room the voice agent joins. The SDK ends a session when the last
    person leaves; here a page reload must not end the agent -- ./demo.sh down
    (or ctrl-c) does."""
    return Room(room_id=room_id, name="voice-agent", vision=True,
                auto_end_session=False,
                session_timeout_seconds=SESSION_HOURS * 3600,
                no_participant_timeout_seconds=SESSION_HOURS * 3600)


def warm_policy(leader, infer, wait_s: float = 60.0) -> None:
    """One throwaway inference on the live cameras. MPS compiles for each new
    camera count and size -- 38 s on the first live call -- and that belongs
    here, not in the first "pick up the cube". Never raises."""
    end = time.monotonic() + wait_s
    while time.monotonic() < end:
        obs = leader.observation()
        # EVERY camera: a compile for one camera does not cover three.
        want = max(len(leader.cameras or []), 1)
        try:
            if len(obs.images) >= want and len(obs.joints) >= len(skills.JOINTS):
                t0 = time.perf_counter()
                infer(obs, "pick up the red cube")
                print(f"pick-up: warmed on {len(obs.images)} live cameras in "
                      f"{time.perf_counter() - t0:.0f}s")
                return
        except Exception as exc:
            print(f"pick-up: warm-up failed ({exc}); the first pick-up will be slow")
            return
        finally:
            for frame in obs.images.values():
                frame.release()
        time.sleep(0.2)
    print("pick-up: no camera frames to warm up on; the first pick-up will be slow")


def _drive(leader, ctl) -> None:
    for _ in leader.ticks(FPS):
        ctl.step()


def _guarded(fn, *args) -> None:
    """A thread that dies loudly. Otherwise the voice agent would keep taking
    orders for an arm nothing is driving any more."""
    try:
        fn(*args)
    except BaseException:
        traceback.print_exc()
        os._exit(1)


class _Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args) -> None:
        pass


def _serve_web(port: int) -> None:
    """web/ on localhost only. Static files; the token rides in the URL."""
    handler = functools.partial(_Quiet, directory=str(HERE / "web"))
    try:
        server = http.server.ThreadingHTTPServer(("127.0.0.1", port), handler)
    except OSError:
        raise SystemExit(f"port {port} is busy: set ZERORUNTIME_WEB_PORT in "
                         f"voice/.env") from None
    threading.Thread(target=server.serve_forever, name="web",
                     daemon=True).start()


if __name__ == "__main__":
    main()
