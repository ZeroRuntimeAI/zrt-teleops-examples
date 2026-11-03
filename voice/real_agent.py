#!/usr/bin/env python3
"""
The voice agent on a REAL SO-101: agent.py's RobotAgent, with pick_up and
place planned by studio/agent/planner.py from what the table camera sees.

    python real_agent.py

Same setup as agent.py (follower first, voice/.env with the room), plus a
calibrated table (calibrate_table.py) and GOOGLE_API_KEY for pointing.

How a pick goes: one frame from the table camera, the vision model points at
the cube and the box top, the calibrated homography turns those pixels into
table positions, and the planner's IK solves the waypoints -- on the arm
model corrected by sysid.py from teleoperated grasps (arm_correction.json),
so the jaws close where a person's did. After the grasp the gripper's own
reading says whether the cube is between the jaws; a miss is tried once more
from a fresh look.
"""

import asyncio
import functools
import logging
import sys
import threading
import time
from pathlib import Path
from urllib.parse import quote

import numpy as np
import zeroruntime
from zeroruntime import Room, function_tool

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "studio" / "agent"))

import events  # noqa: E402
import planner as planner_mod  # noqa: E402
import sysid  # noqa: E402
import table  # noqa: E402
from agent import (LANGUAGE, RobotAgent, _drive, _guarded, _serve_web, checked,  # noqa: E402
                   run_tool, voice_room)
from config import FPS, HERE, WEB_PORT, required  # noqa: E402
from motion import MotionController, VoiceLeader  # noqa: E402
from planner import PlanError, Planner  # noqa: E402
from skills import Keyframe  # noqa: E402
from studio_agent import color_of  # noqa: E402

SCENE_XML = Path(__file__).resolve().parents[1] / "studio" / "public" / "sim" / "scene.xml"
EXECUTOR = "scripted planner · camera-pointed positions"

#: Which cube when none is named.
DEFAULT_COLOR = "orange"
#: Pick attempts per request: the first, then one more from a fresh look.
ATTEMPTS = 2
#: Closed on the cube the jaws stop near 10-12; closed on nothing they read ~2.
HELD_MIN = 5.0
#: Let the servos settle before reading where the arm really is.
SETTLE_S = 0.6
#: Let go with the cube's bottom this far above the box top.
DROP_M = 0.01
#: Small moves of the box are followed. A sighting further than this from the
#: last known box is the model pointing at something else (a laptop, once).
# ponytail: a box really moved further than this between places is ignored too.
BOX_JUMP_M = 0.08
#: Heights of the grasp point, metres above the table, for travel and the
#: slow-down: the planner's, now for the corrected grasp point.
SAFE_Z, PRE_Z = planner_mod.SAFE_Z, planner_mod.PRE_Z
OPEN, CLOSED, RELEASE = planner_mod.OPEN, planner_mod.CLOSED, planner_mod.RELEASE

_log = logging.getLogger("real-agent")


@functools.cache
def shared_planner() -> Planner:
    return Planner(SCENE_XML)


@functools.cache
def shared_correction() -> sysid.Correction:
    return sysid.Correction.load()


def held(ctl) -> bool:
    """Is something between the jaws? The jaws say: a cube stops them."""
    return ctl.measured().get("gripper", 0.0) > HELD_MIN


def solve(planner: Planner, corr: sysid.Correction, point, seed: dict, what: str) -> dict:
    """Arm joints that put the corrected grasp point on `point`. The grasp
    offset turns with the hand, so: solve, re-aim for the new hand, solve."""
    joints = dict(seed)
    for _ in range(2):
        site = corr.site_target(planner, point, joints)
        with planner._lock:
            model = planner._ik(site, corr.to_model(joints), what)
        joints = {**joints, **corr.to_arm(model)}
    return joints


#: Travel heights to try, highest first. Close to the base the arm cannot hold
#: the hand 12 cm straight up (14 cm out: 1 cm short), but can lower.
TRAVEL_Z = (SAFE_Z, 0.10, 0.08)


def solve_high(planner: Planner, corr: sysid.Correction, x: float, y: float, seed: dict,
               what: str) -> dict:
    """Over (x, y) at the highest travel height the arm can reach there."""
    for z in TRAVEL_Z[:-1]:
        try:
            return solve(planner, corr, (x, y, z), seed, what)
        except PlanError:
            continue
    return solve(planner, corr, (x, y, TRAVEL_Z[-1]), seed, what)


def plan_pick(planner: Planner, corr: sysid.Correction, cube, current: dict) -> tuple[dict, ...]:
    """Above the cube, the slow-down, the grasp and the lift, as arm joints."""
    x, y, z = cube
    try:
        with planner._lock:                 # jaws square to the table's axes
            roll = planner._square_roll(x, y, (1.0, 0.0, 0.0, 0.0), corr.to_model(current))
    except PlanError:                       # it solves at 12 cm, too high near the base
        roll = 0.0
    above = solve_high(planner, corr, x, y, {**current, "wrist_roll": roll}, "the cube")
    pre = solve(planner, corr, (x, y, PRE_Z), above, "the cube")
    grasp = solve(planner, corr, (x, y, z), pre, "the cube")
    lift = solve_high(planner, corr, x, y, grasp, "the cube")
    return above, pre, grasp, lift


def plan_place(planner: Planner, corr: sysid.Correction, box, current: dict) -> tuple[Keyframe, ...]:
    """Over the box top, down until the cube is just above it, let go, back up."""
    bx, by, top = box
    over = solve(planner, corr, (bx, by, max(SAFE_Z, top + 0.07)), current, f"the {table.TARGET}")
    down = solve(planner, corr, (bx, by, top + table.CUBE_Z + DROP_M), over, f"the {table.TARGET}")
    return (Keyframe({**over, "gripper": CLOSED}),
            Keyframe({**down, "gripper": CLOSED}),
            Keyframe({**down, "gripper": RELEASE}, hold_s=planner_mod.RELEASE_HOLD_S),
            Keyframe({**over, "gripper": RELEASE}))


#: Looks at the box before letting go. One sighting scatters 1-2 cm, and the
#: box does get bumped (2.7 cm once), so: several fresh looks, the median.
BOX_LOOKS = 3


def steady_box(seen, ref):
    """The box to place on, and the reference to keep: `seen` unless it jumped
    from `ref` (the model pointed at something else), in which case `ref`.
    Small moves are followed: the box does get bumped. Either may be None."""
    if seen is None:
        return ref, ref
    if ref is None or np.hypot(seen[0] - ref[0], seen[1] - ref[1]) <= BOX_JUMP_M:
        return seen, seen
    _log.warning("box seen at %s, %.0f cm from %s: keeping the known one", seen,
                 np.hypot(seen[0] - ref[0], seen[1] - ref[1]) * 100, ref)
    return ref, ref


def look_box(leader, tbl: table.Table, looks: int = BOX_LOOKS):
    """The box top's centre, the median of `looks` fresh sightings, or None."""
    seen = []
    for _ in range(looks):
        try:
            px = table.point_at(table.snapshot(leader, tbl.camera), {"box": table.TARGET_POINT})["box"]
        except table.TableError as exc:     # a garbled answer or a dropped frame: one look lost
            _log.warning("box look failed: %s", exc)
            continue
        if px is not None:
            seen.append(tbl.to_xy(*px, table.TARGET_Z))
    if not seen:
        return None
    x, y = np.median(np.array(seen), axis=0)
    table.in_reach(x, y, f"the {table.TARGET}")
    return (float(x), float(y), table.TARGET_Z)


def run_pick(ctl, planner: Planner, corr: sysid.Correction, scene: dict, color: str,
             grasp_only: bool = False) -> dict:
    """The pick in two legs. The first ends just over the cube; the arm's
    measured pose there says how far the servos fell short of the command
    (they sag at full stretch), and the grasp is re-aimed by that much.
    `grasp_only` stops at the grasp pose, jaws open, to look. Blocks on the
    arm: call off the event loop."""
    cube = next(c for c in scene["cubes"] if c["color"] == color)
    x, y, z = cube["pos"]
    above, pre, _, _ = plan_pick(planner, corr, (x, y, z), ctl.measured())
    out = ctl.command((Keyframe({**above, "gripper": OPEN}),
                       Keyframe({**pre, "gripper": OPEN}))).result()
    if out.get("cancelled") or "error" in out:
        return out
    time.sleep(SETTLE_S)
    short = np.array([x, y, PRE_Z]) - corr.grasp_point(planner, ctl.measured())
    if np.linalg.norm(short) > 0.03:        # a bad reading, not a 3 cm sag
        short = np.zeros(3)
    aim = (x + short[0], y + short[1], z + short[2])
    pre2 = solve(planner, corr, (aim[0], aim[1], PRE_Z + short[2]), ctl.measured(), "the cube")
    grasp = solve(planner, corr, aim, pre2, "the cube")
    lift = solve_high(planner, corr, x, y, grasp, "the cube")
    motion = [Keyframe({**pre2, "gripper": OPEN}), Keyframe({**grasp, "gripper": OPEN})]
    if not grasp_only:
        motion += [Keyframe({**grasp, "gripper": CLOSED}, hold_s=planner_mod.GRIP_HOLD_S),
                   Keyframe({**lift, "gripper": CLOSED})]
    out = ctl.command(tuple(motion)).result()
    return {**out, "re_aimed_cm": [round(float(v) * 100, 1) for v in short]}


class RealRobotAgent(RobotAgent):
    """RobotAgent whose pick_up and place see the real table."""

    def __init__(self, ctl, leader, planner: Planner, tbl: table.Table,
                 corr: sysid.Correction, language: str = LANGUAGE) -> None:
        self.leader = leader
        self.planner = planner
        self.table = tbl
        self.corr = corr
        # Where the box is: where the teleoperated demos let go, until seen.
        rel = getattr(corr, "release_xy", None)
        self.box = (*rel, table.TARGET_Z) if rel else None
        super().__init__(ctl, None, language)        # no learned policy

    def _observe(self, color: str) -> dict:
        scene = table.observe(self.leader, self.table, color)
        seen = scene["box"] and scene["box"]["pos"]
        place, self.box = steady_box(seen, self.box)
        scene["box"] = place and {"pos": place}
        events.log("observe", color=color, pixels=scene["pixels"],
                   cubes=scene["cubes"], box=scene["box"])
        return scene

    async def _run(self, motion) -> dict:
        """Shielded like agent.py's: talking over the tool must not cancel it."""
        return await asyncio.shield(asyncio.wrap_future(self.ctl.command(motion)))

    async def _pick(self, color: str) -> dict:
        for attempt in range(1, ATTEMPTS + 1):
            scene = await asyncio.to_thread(self._observe, color)
            if not scene["cubes"]:
                raise PlanError(f"I can't see the {color} cube")
            # Not shielded like a plain motion: the thread runs the arm to the
            # end whatever happens to this coroutine.
            out = await asyncio.to_thread(run_pick, self.ctl, self.planner, self.corr,
                                          scene, color)
            if out.get("cancelled") or "error" in out:
                return out
            got = held(self.ctl)
            events.log("grasp_check", attempt=attempt, held=got,
                       re_aimed_cm=out.get("re_aimed_cm"))
            if got:
                return {**out, "attempt": attempt, "seen_at": scene["pixels"]}
        return {**out, "error": f"I tried {ATTEMPTS} times but the cube isn't in my "
                                f"gripper. Is it where I can reach?"}

    async def _place(self) -> dict:
        seen = await asyncio.to_thread(look_box, self.leader, self.table)
        box, self.box = steady_box(seen, self.box)
        events.log("box", seen=seen, used=box)
        if box is None:
            raise PlanError(f"I can't see the {table.TARGET}")
        motion = plan_place(self.planner, self.corr, box, self.ctl.measured())
        return {**(await self._run(motion)), "box": box}

    # -- tools: the docstrings are what the model reads -----------------------

    @function_tool
    async def pick_up(self, item: str) -> dict:
        """Pick up the cube on the table and lift it. Looks for it with the
        camera, so it can be anywhere on the table. Waits until the arm is
        done, then checks the grasp and retries once if it missed.

        Args:
            item: What to pick up, e.g. "the orange cube" or just "the cube".
        """
        color = color_of(item) or DEFAULT_COLOR

        async def start():
            return {**(await self._pick(color)), "executor": EXECUTOR}

        return await run_tool("pick_up", {"item": item}, checked(self.ctl, start),
                              self._publish)

    @function_tool
    async def place(self, into: str) -> dict:
        """Put what I'm holding on top of the brown box and let go. Waits
        until the arm is done.

        Args:
            into: Where to put it -- the top of the box is the only place there is.
        """
        async def start():
            return {**(await self._place()), "executor": EXECUTOR}

        return await run_tool("place", {"into": into}, checked(self.ctl, start),
                              self._publish)


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    token = required("ZERORUNTIME_AUTH_TOKEN", "your access token")
    room = required("ZERORUNTIME_MEETING_ID", "the room the follower is in")
    required("GOOGLE_API_KEY", "a Gemini key: pick_up points at the cube with it")
    tbl = table.Table.load()                   # before joining: a missing file fails here
    planner = shared_planner()
    corr = shared_correction()
    if not any(corr.offsets.values()):
        print("  WARNING no arm_correction.json: run sysid.py on teleoperated grasps, "
              "or grasps will miss")
    stamp = time.strftime("%Y%m%d-%H%M%S")
    print(f"  events  {events.open_log(HERE / 'logs', stamp)}")
    print(f"  table   camera {tbl.camera}, pointing with {table.MODEL}")

    leader = VoiceLeader(meeting_id=room, token=token, fps=FPS, sync_buffer_ms=120.0)
    ctl = MotionController(leader, fps=FPS)
    leader.start()
    if not leader.claim_control(timeout_s=10):
        leader.stop()
        raise SystemExit(f"no control in {room}: start ../so101/follower.py first, "
                         f"with the same ZERORUNTIME_MEETING_ID")
    print(f"control granted, schema {leader.schema}")
    threading.Thread(target=_guarded, args=(_drive, leader, ctl), name="leader",
                     daemon=True).start()
    _serve_web(WEB_PORT)
    print(f"\n  open  http://localhost:{WEB_PORT}/?room={quote(room)}&token={quote(token)}\n"
          f"  (the link carries your token -- keep it off anything public)\n")
    try:
        zeroruntime.serve(lambda: RealRobotAgent(ctl, leader, planner, tbl, corr),
                          room=Room(vision=True), 
                          on_ready=lambda: zeroruntime.invoke(room=voice_room(room)))
    finally:
        ctl.stop()
        time.sleep(3 / FPS)
        leader.stop()


if __name__ == "__main__":
    main()
