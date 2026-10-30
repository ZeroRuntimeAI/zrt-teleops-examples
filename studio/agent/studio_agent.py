"""
Studio's voice agent: voice/'s RobotAgent, unchanged, except that pick_up and
place run the scripted planner on exact simulator positions. SIM ONLY -- a
real arm has no `observe_scene` to ask.
"""

import asyncio
import functools
import re
import sys
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "voice"))

from zeroruntime import function_tool  # noqa: E402

from agent import RobotAgent, checked, run_tool  # noqa: E402  (voice/agent.py)
from config import FPS  # noqa: E402  (voice/config.py)
from motion import NO_CONTROL, STALE, STALE_S, MotionController  # noqa: E402
from planner import PlanError, Planner  # noqa: E402

SCENE_XML = ROOT / "studio" / "public" / "sim" / "scene.xml"

#: Shown verbatim next to every pick_up and place in Studio's activity log.
EXECUTOR = "scripted planner · uses exact simulator positions"

COLORS = ("red", "green", "blue", "yellow")

#: Said when the scene can't be read. The core refuses a non-open RPC from a
#: peer without the lease -- usually because the visitor took the arm back.
NO_SCENE = ("I can't see the table right now -- I may not have control of my "
            "arm (the visitor may be driving): {}")


# What the agent says when it loses the arm. In Studio the robot is the
# visitor's own tab, so voice/'s "restart the robot side" never fits.
SESSION_OVER = ("This Studio session has ended, or the page was closed, so I "
                "can't move the arm any more. Reload the page to start a new "
                "session.")
VISITOR_DRIVING = ("You're driving the arm right now. Click Voice to hand it "
                   "back to me.")
NOT_HANDED_OVER = ("I haven't been handed the arm yet. Give it a moment, or "
                   "click Voice again.")


class StudioMotionController(MotionController):
    """voice/'s controller, with Studio's words for a lost arm."""

    def health(self) -> dict:
        h = super().health()
        if h["problem"] not in (NO_CONTROL, STALE):
            return h
        if h["problem"] == STALE or not self._fresh():
            return {**h, "problem": SESSION_OVER}
        holder = self._leader.robot_lease_holder
        driving = holder is not None and holder != self._leader.peer_id
        return {**h, "problem": VISITOR_DRIVING if driving else NOT_HANDED_OVER}

    def _fresh(self) -> bool:
        """The tab still sends joint state: what health() checks after control."""
        try:
            self.measured()
        except Exception:
            return False
        return self.clock() - self._fresh_at <= STALE_S


@functools.cache
def shared_planner() -> Planner:
    """One per worker: it locks its own scratch state."""
    return Planner(SCENE_XML)


def color_of(item: str) -> str | None:
    """The cube's color in "the red cube" -- or the word that stands where a
    color would ("purple"), so the agent can say there is none. None for a
    bare "cube"."""
    words = [w for w in re.findall(r"[a-z]+", str(item).lower())
             if w not in ("the", "a", "cube", "block", "one")]
    return next((w for w in words if w in COLORS), words[0] if words else None)


class StudioRobotAgent(RobotAgent):
    """RobotAgent with pick_up/place planned from the simulator's scene."""

    def __init__(self, ctl, leader, planner: Planner, language: str = "en") -> None:
        self.leader = leader
        self.planner = planner
        #: Set once teardown starts; the leader thread checks it after joining.
        self.stopped = threading.Event()
        super().__init__(ctl, None, language)    # no MolmoAct2: infer=None

    async def on_exit(self) -> None:
        await super().on_exit()
        await self._teardown()

    async def cleanup(self) -> None:
        """The SDK always calls this at teardown -- on_exit only on a normal
        end -- so a refused or broken session still leaves the room."""
        await super().cleanup()
        await self._teardown()

    async def _teardown(self) -> None:
        """Stop the arm, then leave the room. Once, whoever calls first."""
        if self.ctl is None or self.stopped.is_set():   # serve()'s template agent, or done
            return
        self.stopped.set()
        self.ctl.stop()
        await asyncio.sleep(3 / FPS)             # a few ticks for the leader thread to halt
        await asyncio.to_thread(self.leader.stop)    # leaves the room; the arm holds

    def _scene(self) -> dict:
        try:
            return self.leader.perform_rpc(self.leader.robot_peer, "observe_scene")
        except Exception as exc:
            raise RuntimeError(NO_SCENE.format(exc)) from exc

    async def _scripted(self, plan) -> dict:
        """Read the scene, plan from where the arm is, run it. The motion is
        shielded like voice/'s: talking over the tool must not cancel it."""
        scene = await asyncio.to_thread(self._scene)
        motion = await asyncio.to_thread(plan, scene, self.ctl.measured())
        out = await asyncio.shield(asyncio.wrap_future(self.ctl.command(motion)))
        return {**out, "executor": EXECUTOR}

    # -- tools: the docstrings are what the model reads -----------------------

    @function_tool
    async def pick_up(self, item: str) -> dict:
        """Pick up one of the cubes on the table by its color, and lift it.
        Waits until the arm is done.

        Args:
            item: Which cube, by color: "red cube", "green cube", "blue cube"
                or "yellow cube".
        """
        def plan(scene, current):
            color = color_of(item)
            if color is None:
                seen = ", ".join(c["color"] for c in scene["cubes"])
                raise PlanError(f"which cube? I see {seen}")
            return self.planner.pick(scene, color, current)

        return await run_tool("pick_up", {"item": item},
                              checked(self.ctl, lambda: self._scripted(plan)),
                              self._publish)

    @function_tool
    async def place(self, into: str) -> dict:
        """Put what I'm holding into the box, and let go. Waits until the arm
        is done.

        Args:
            into: Where to put it -- the box is the only place there is.
        """
        return await run_tool("place", {"into": into},
                              checked(self.ctl, lambda: self._scripted(self.planner.place)),
                              self._publish)
