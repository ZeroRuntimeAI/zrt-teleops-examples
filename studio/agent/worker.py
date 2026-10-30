#!/usr/bin/env python3
"""
Studio's voice worker: one voice agent per visitor room.

    ZERORUNTIME_AUTH_TOKEN=... ZERORUNTIME_AGENT_ID=... python studio/agent/worker.py

Registers with Zero Runtime under ZERORUNTIME_AGENT_ID (Studio's
STUDIO_VOICE_AGENT_ID must name the same id) and waits. The Studio server
dispatches it into a visitor's room with POST /v2/agent/dispatch, metadata
{"language": "en" | "hi"}. Each dispatch gets its own teleops leader for that
room's browser follower ("studio-so101") and its own MotionController.
"""

import logging
import os
import threading
import time

import zeroruntime
from zeroruntime import Room

from studio_agent import StudioMotionController, StudioRobotAgent, shared_planner

from config import FPS  # noqa: E402  (voice/, on the path via studio_agent)
from motion import VoiceLeader  # noqa: E402

_log = logging.getLogger("studio-voice")

LANGUAGES = ("en", "hi")
#: Claim control again this often until the first grant, for at most
#: CLAIM_WINDOW_S. The visitor's tab hands the arm back only after the mic
#: prompt is answered, and a hand-back returns it to the LAST remote holder --
#: never us, if our only claim came first and was denied.
CLAIM_EVERY_S = 1.5
CLAIM_WINDOW_S = 60.0
#: A voice session lasts at most this long; Studio's own session is 5 min.
SESSION_TIMEOUT_S = 300


class StudioVoiceLeader(VoiceLeader):
    """VoiceLeader, pinned to Studio's browser follower."""

    target_robot_id = "studio-so101"


def make_agent(ctx) -> StudioRobotAgent:
    """The agent for one dispatched room."""
    language = (ctx.metadata or {}).get("language", "en")
    if language not in LANGUAGES:
        language = "en"
    if not ctx.room_id:
        # serve() builds one agent from an empty AgentContext to check the
        # factory: no room to join.
        return StudioRobotAgent(None, None, shared_planner(), language)
    token = ctx.token or os.environ.get("ZERORUNTIME_AUTH_TOKEN", "")
    leader = StudioVoiceLeader(meeting_id=ctx.room_id, token=token, fps=FPS,
                               sync_buffer_ms=120.0)
    ctl = StudioMotionController(leader, fps=FPS)
    agent = StudioRobotAgent(ctl, leader, shared_planner(), language)
    # Joining and claiming block for seconds: off the event loop, which every
    # other session on this worker shares.
    agent.link = threading.Thread(target=_link,
                                  args=(leader, ctl, ctx.room_id, agent.stopped),
                                  name=f"leader-{ctx.room_id}", daemon=True)
    agent.link.start()
    return agent


def _link(leader, ctl, room: str, stopped: threading.Event,
          clock=time.monotonic) -> None:
    """Join, then drive -- claiming control every CLAIM_EVERY_S until the
    first grant or CLAIM_WINDOW_S, without holding up the ticks. Never raises
    and never exits the process: other rooms share it. Without control,
    every arm tool says so (ctl.health)."""
    try:
        leader.start()
        if stopped.is_set():            # torn down while joining: start() undid that stop
            leader.stop()
            return
        give_up = clock() + CLAIM_WINDOW_S
        next_claim = clock()            # None once settled
        for _ in leader.ticks(FPS):
            now = clock()
            if next_claim is not None and now >= next_claim:
                # timeout 0: one claim and one tick, never a blocking wait.
                if leader.has_control or leader.claim_control(timeout_s=0):
                    _log.info("%s: control granted", room)
                    next_claim = None
                elif now >= give_up:
                    _log.warning("%s: no control after %.0f s of claims; the "
                                 "tools will say so", room, CLAIM_WINDOW_S)
                    next_claim = None
                else:
                    next_claim = now + CLAIM_EVERY_S
            ctl.step()
    except Exception:
        _log.exception("%s: the leader stopped; the arm tools will report it", room)


def main() -> None:
    logging.basicConfig(level=logging.INFO,
                        format="%(levelname)s %(name)s: %(message)s")
    zeroruntime.serve(make_agent, room=Room(vision=True, auto_end_session=True,
                                            session_timeout_seconds=SESSION_TIMEOUT_S))


if __name__ == "__main__":
    main()
