"""
Turns tool calls into arm motion: smooth, bounded, one intent at a time.

`VoiceLeader` is the teleops side. It joins the room and sends whatever
setpoint it holds. `MotionController` is the only thing that sets it.

Every call that writes to the Leader happens in `step()`, on the leader
thread. The agent's tools only post requests under a lock, so nothing here
races the publish tick -- and a request is at most one tick (33 ms) away
from the arm.
"""

import logging
import threading
import time
import traceback
from concurrent.futures import Future, InvalidStateError
from dataclasses import dataclass

from zeroruntime.teleops import Leader, single_group_descriptor
from zeroruntime.teleops.protocol import Units

import dance
import events
import skills

_log = logging.getLogger(__name__)

# ── Settings ───────────────────────────────────────────────────────────────

#: Planned speed, units per second -- degrees on the body joints. Far below
#: the follower's slew, so the plan sets the pace, not the follower's clamp.
SPEED = 60.0

#: No segment is shorter than this, so even a tiny move eases in and out.
MIN_SEGMENT_S = 0.3

#: Keep sending the final target this long before letting go of the
#: deadman, so the follower finishes the move instead of holding a step short.
SETTLE_S = 0.3

#: Refuse a policy chunk whose first target is further than this from where
#: the arm is, on any joint. A policy that wants to teleport has misread the
#: arm -- usually a joint convention -- and its whole chunk is suspect.
MAX_JUMP = 25.0

#: Extra time allowed for a policy's FIRST chunk. MPS compiles for new input
#: shapes -- the first live MolmoAct2 call took 38 s -- and that wait is not
#: the attempt's motion time, which starts at the first chunk.
FIRST_CHUNK_GRACE_S = 60.0

#: No new joint state for this long reads as "the robot side is down".
STALE_S = 2.0

#: A commanded joint that ends further than this from its target is reported.
REACH_TOL = 8.0

#: ...but only if it is still that far this long after the move. The pose
#: the follower reports lags the command: live, "rest" read 52 degrees short
#: with nothing in the way.
REACH_WAIT_S = 1.5

#: Dancing with no music: this tempo, for at most DANCE_SOLO_S.
DEFAULT_BPM = 100.0
DANCE_SOLO_S = 20.0

#: Time to move from wherever the arm is into the dance's base pose.
DANCE_ENTRY_S = 1.0

#: No music frame for this long ends a music dance (the page normally says).
MUSIC_TIMEOUT_S = 5.0

# ───────────────────────────────────────────────────────────────────────────

# What the agent says when the arm can't do what it was asked.
NO_CONTROL = ("I'm not connected to my arm's controller -- the robot side may "
              "have restarted. Restart it, then me.")
ROBOT_FAULT = ("My servos report a fault (servo write or bus failure) -- check "
               "my power and USB cable.")
STALE = ("I'm not getting position updates from my arm -- the robot side may "
         "be down.")
MISSED = ("My {joint} didn't reach where I sent it ({off:.0f} degrees short) -- "
          "something may be blocking me, or my torque is off.")
POLICY_FAILED = "My pick-up model failed: {reason}."
NO_STATE = "no joint state from the robot yet -- is the follower running?"

# ───────────────────────────────────────────────────────────────────────────

Segment = tuple[float, float, dict, dict]       # t0, t1, from, to


class VoiceLeader(Leader):
    """The arm as the lerobot follower announces it: sorted joints, `norm`.

    `read_joints()` runs inside the publish tick and only hands back the
    setpoint. `{}` sends nothing that tick -- policy mode relies on it, so
    the tick stream never overrides a chunk.
    """

    def __init__(self, *, fps: int, **kw) -> None:
        self._fps = fps                             # before super(): descriptor() reads it
        self._lock = threading.Lock()
        self._setpoint: dict[str, float] = {}
        super().__init__(publish_hz=fps, **kw)      # LAST

    def descriptor(self):
        return single_group_descriptor("voice-agent", "voice", skills.JOINTS,
                                       control_hz=self._fps,
                                       units=Units.NORMALIZED)

    def read_joints(self) -> dict[str, float]:
        with self._lock:
            return dict(self._setpoint)

    def set_setpoint(self, joints) -> None:
        with self._lock:
            self._setpoint = dict(joints)


def plan(start: dict, motion: skills.Motion, *, now: float,
         speed: float = SPEED) -> list[Segment]:
    """Absolute segments for `motion`, beginning at the measured pose `start`.

    Relative keyframes resolve against where the arm IS, and every target
    is clamped, so no keyframe can ask for a jump or a pose outside LIMITS.
    """
    segments: list[Segment] = []
    pose, t = dict(start), now
    for kf in motion:
        target = dict(pose)
        for joint, value in kf.joints.items():
            target[joint] = skills.clamp(
                joint, pose[joint] + value if kf.relative else value)
        span = max(abs(target[j] - pose[j]) for j in target) / speed
        duration = max(span, MIN_SEGMENT_S)
        segments.append((t, t + duration, pose, target))
        t += duration
        if kf.hold_s > 0:
            segments.append((t, t + kf.hold_s, target, target))
            t += kf.hold_s
        pose = target
    return segments


def setpoint_at(segments: list[Segment], now: float) -> dict:
    """Where the arm should be at `now`: smoothstep inside the current
    segment, the final target once past the end."""
    for t0, t1, a, b in segments:
        if now < t1:
            s = min(max((now - t0) / (t1 - t0), 0.0), 1.0)
            e = s * s * (3.0 - 2.0 * s)
            return {j: a[j] + (b[j] - a[j]) * e for j in b}
    return dict(segments[-1][3])


def guard_chunk(rows: list[dict], current: dict) -> list[dict]:
    """A policy's chunk, every target clamped to LIMITS -- or a ValueError if
    its first row is more than MAX_JUMP from the arm on any ARM joint. The
    gripper may snap open or shut: that can't throw the arm anywhere."""
    clamped = [{j: skills.clamp(j, v) for j, v in row.items()} for row in rows]
    jump = {j: abs(v - current[j]) for j, v in clamped[0].items()
            if j in current and j in skills.BODY}
    worst = max(jump, key=jump.get)
    if jump[worst] > MAX_JUMP:
        raise ValueError(f"policy wanted {worst} to jump {jump[worst]:.0f} "
                         f"degrees from where the arm is -- refusing the chunk")
    return clamped


def _resolve(fut: Future, result: dict) -> None:
    """Settle `fut` unless something already did. The agent cancels its
    side of a future when the speaker talks over a running tool."""
    try:
        fut.set_result(result)
    except InvalidStateError:
        pass


def _rounded(joints: dict) -> dict:
    return {j: round(v, 1) for j, v in joints.items()}


@dataclass
class _Chunk:
    rows: list
    oid: int | None


class MotionController:
    """One intent at a time: a motion, a policy, or nothing (the arm holds)."""

    def __init__(self, leader, *, fps: int, speed: float = SPEED,
                 clock=time.monotonic) -> None:
        self._leader = leader
        self._dt = 1.0 / fps
        self._speed = speed
        self._clock = clock
        self._lock = threading.Lock()
        self._pending = None            # (motion, future) for the next tick
        self._run = None                # {"segments", "future", "end"} in flight
        self._halt = False              # stop here, on the next tick
        self._policy_stop = None        # Event of the running policy
        self._arm_policy = False        # take the deadman for it, next tick
        self._chunk = None              # newest policy chunk, sent next tick
        self._policy_future = None      # how the running policy ends
        self._last_oid = None           # newest observation id seen ...
        self._fresh_at = clock()        # ... and when it changed
        self._faults_seen = None        # robot's joint read fault count
        self._dance_req = None          # (Dancer, future) for the next tick
        self._dance = None              # the dance in flight
        self.policy_error: str | None = None
        self.policy_thread: threading.Thread | None = None

    # -- any thread ------------------------------------------------------------

    def clock(self) -> float:
        return self._clock()

    def measured(self) -> dict[str, float]:
        """The arm's joints as the follower last reported them."""
        obs = self._leader.observation()
        for frame in obs.images.values():
            frame.release()             # or decoder buffers stay pinned
        if obs.observation_id != self._last_oid:
            self._last_oid, self._fresh_at = obs.observation_id, self._clock()
        return dict(obs.joints)

    def health(self) -> dict:
        """Can the arm move right now -- and if not, why, in words the agent
        can say out loud."""
        if not self._leader.has_control:
            return {"ok": False, "problem": NO_CONTROL}
        # The robot's safe state carries no reason ("holding"), but its stats
        # count joint read faults: any new since the last check is a fault.
        faults = sum(b.get("jointReadFaults", 0) for b in (self._leader.remote_stats or [])
                     if isinstance(b, dict))
        rising = self._faults_seen is not None and faults > self._faults_seen
        self._faults_seen = faults
        if rising or "fault" in str(self._leader.robot_safe_state or "").lower():
            return {"ok": False, "problem": ROBOT_FAULT}
        self.measured()
        if self._clock() - self._fresh_at > STALE_S:
            return {"ok": False, "problem": STALE}
        return {"ok": True, "problem": None}

    def current(self) -> Future | None:
        """The running intent's future, for wait_for_robot."""
        with self._lock:
            for fut in (self._pending and self._pending[1],
                        self._run and self._run["future"],
                        self._policy_future if self._policy_stop else None,
                        (self._dance or {}).get("future"),
                        self._dance_req and self._dance_req[1]):
                if fut is not None and not fut.done():
                    return fut
        return None

    def command(self, motion: skills.Motion) -> Future:
        """Run `motion` from wherever the arm is. Replaces any intent."""
        fut: Future = Future()
        with self._lock:
            self._cancel_locked()
            self._pending = (motion, fut)
        return fut

    def stop(self) -> None:
        """Cancel everything; the arm holds where it is."""
        with self._lock:
            self._cancel_locked()
            self._halt = True

    def start_policy(self, task: str, infer, timeout_s: float) -> Future:
        """Hand the arm to `infer(observation, task) -> rows` for at most
        `timeout_s` of motion. Any command or stop() takes it back. The
        future says how it ended."""
        stop, fut = threading.Event(), Future()
        with self._lock:
            self._cancel_locked()
            self._policy_stop = stop
            self._policy_future = fut
            self._arm_policy = True
            self.policy_error = None
        events.log("policy_start", task=task)
        self.policy_thread = threading.Thread(
            target=self._policy_loop, args=(task, infer, stop, timeout_s, fut),
            name="policy", daemon=True)
        self.policy_thread.start()
        return fut

    def start_dance(self, mood: str, rng=None) -> Future:
        """Dance in `mood` until the music stops, stop(), or any new intent.
        Without music, DEFAULT_BPM for DANCE_SOLO_S."""
        fut: Future = Future()
        with self._lock:
            self._cancel_locked()
            self._dance_req = (dance.Dancer(mood, rng), fut)
        return fut

    def music(self, bpm: float, beat_at: float, energy: float) -> None:
        """A tempo, a recent beat on the controller clock, loudness 0-1."""
        with self._lock:
            d = self._dance
            if d is None:
                return
            period = 60.0 / min(max(float(bpm), 40.0), 220.0)
            d["period"] = period
            d["energy"] = min(max(float(energy), 0.0), 1.0)
            d["anchor"] = dance.nudge(d["anchor"], float(beat_at), period)
            d["music"], d["heard_at"] = True, self._clock()

    def music_stop(self) -> None:
        with self._lock:
            if self._dance is not None:
                self._end_dance_locked("music_stopped")

    def state(self) -> dict:
        with self._lock:
            mode = ("dancing" if self._dance or self._dance_req else
                    "policy" if self._policy_stop is not None else
                    "moving" if self._run or self._pending else "idle")
        return {"mode": mode, "control": bool(self._leader.has_control),
                "joints": _rounded(self.measured())}

    # -- leader thread ---------------------------------------------------------

    def step(self) -> None:
        """One leader tick. The only place that writes to the Leader."""
        with self._lock:
            halt, self._halt = self._halt, False
            pending, self._pending = self._pending, None
            arm, self._arm_policy = self._arm_policy, False
            chunk, self._chunk = self._chunk, None
            dance_req, self._dance_req = self._dance_req, None
        if halt:
            self._stop_here()
        if pending is not None:
            self._start(*pending)
        if arm:
            self._take_for_policy()
        if dance_req is not None:
            self._begin_dance(*dance_req)
        if chunk is not None and self._leader.has_control:
            self._leader.send_action_chunk(chunk.rows, self._dt,
                                           in_reply_to=chunk.oid)
            events.log("chunk", rows=len(chunk.rows))
        self._advance()
        self._advance_dance()

    # -- internals -------------------------------------------------------------

    def _cancel_locked(self) -> None:
        for fut in (self._pending and self._pending[1],
                    self._run and self._run["future"]):
            if fut is not None:
                _resolve(fut, {"cancelled": True})
        self._pending = self._run = None
        if self._policy_stop is not None:
            self._policy_stop.set()
            self._policy_stop = None
        self._arm_policy = False
        self._chunk = None
        if self._dance_req is not None:
            _resolve(self._dance_req[1], {"ended": "stopped"})
            self._dance_req = None
        if self._dance is not None:
            _resolve(self._dance["future"], {"ended": "stopped"})
            self._dance = None

    def _stop_here(self) -> None:
        """A one-row chunk at the measured pose overrides any chunk still
        running on the follower; then the deadman goes."""
        pose = self.measured()
        if self._leader.has_control and all(j in pose for j in skills.JOINTS):
            self._leader.send_action_chunk([pose], self._dt)
            self._leader.set_setpoint(pose)
        self._leader.hold_deadman(False)

    def _start(self, motion, fut: Future) -> None:
        start = self.measured()
        if not motion or any(j not in start for j in skills.JOINTS):
            _resolve(fut, {"error": NO_STATE})
            return
        segments = plan(start, motion, now=self._clock(), speed=self._speed)
        with self._lock:
            # A newer intent posted while we measured wins.
            superseded = (fut.done() or self._pending is not None
                          or self._halt or self._arm_policy
                          or self._dance_req is not None)
            if not superseded:
                self._run = {"segments": segments, "future": fut,
                             "end": segments[-1][1],
                             "moved": {j for kf in motion for j in kf.joints
                                       if j in skills.BODY}}
        if superseded:
            _resolve(fut, {"cancelled": True})
            return
        self._leader.set_setpoint(start)        # first command = where it is
        self._leader.hold_deadman(True)

    def _take_for_policy(self) -> None:
        self._leader.set_setpoint(self.measured())
        self._leader.hold_deadman(True)
        self._leader.set_setpoint({})           # chunks drive; the tick is quiet

    def _advance(self) -> None:
        with self._lock:
            run = self._run
        if run is None:
            return
        now = self._clock()
        self._leader.set_setpoint(setpoint_at(run["segments"], now))
        if now < run["end"] + SETTLE_S:
            return
        target = run["segments"][-1][3]
        miss = self._missed(run["moved"], target)
        if miss and now < run["end"] + SETTLE_S + REACH_WAIT_S:
            return                              # still arriving
        with self._lock:
            if self._run is not run:
                return
            self._run = None
            idle = self._pending is None and self._policy_stop is None
        if idle:
            self._leader.hold_deadman(False)
        result = {"joints": _rounded(target)}
        if miss:
            result["warning"] = miss
        _resolve(run["future"], result)

    def _begin_dance(self, dancer, fut: Future) -> None:
        start = self.measured()
        if any(j not in start for j in skills.JOINTS):
            _resolve(fut, {"error": NO_STATE})
            return
        now = self._clock()
        with self._lock:
            if fut.done() or self._pending or self._halt or self._arm_policy or self._dance_req:
                _resolve(fut, {"ended": "stopped"})
                return
            self._dance = {"dancer": dancer, "future": fut, "from": start,
                           "to": {j: skills.clamp(j, v) for j, v in dance.DANCE_BASE.items()},
                           "t0": now, "t1": now + DANCE_ENTRY_S, "queue": [],
                           "period": 60.0 / DEFAULT_BPM, "energy": 0.5,
                           "anchor": now + DANCE_ENTRY_S, "music": False,
                           "heard_at": now, "started": now}
        self._leader.set_setpoint(start)
        self._leader.hold_deadman(True)
        events.log("dance", event="start", mood=dancer.mood)

    def _advance_dance(self) -> None:
        with self._lock:
            d = self._dance
        if d is None:
            return
        now = self._clock()
        if not d["music"] and now - d["started"] > DANCE_SOLO_S:
            reason = "done"
        elif d["music"] and now - d["heard_at"] > MUSIC_TIMEOUT_S:
            reason = "music_stopped"
        else:
            reason = None
        if reason:
            with self._lock:
                if self._dance is d:
                    self._end_dance_locked(reason)
            return
        while now >= d["t1"]:
            if not d["queue"]:
                d["queue"] = d["dancer"].next_phrase(d["energy"])
                events.log("dance", event="phrase", moves=d["dancer"].last_moves,
                           bpm=round(60.0 / d["period"]), energy=round(d["energy"], 2))
            d["from"], d["to"] = d["to"], d["queue"].pop(0)
            d["t0"], d["t1"] = d["t1"], dance.next_beat(d["anchor"], d["period"], d["t1"])
        s = min(max((now - d["t0"]) / (d["t1"] - d["t0"]), 0.0), 1.0)
        e = s * s * (3.0 - 2.0 * s)
        self._leader.set_setpoint({j: d["from"][j] + (d["to"][j] - d["from"][j]) * e
                                   for j in d["to"]})

    def _end_dance_locked(self, reason: str) -> None:
        d, self._dance = self._dance, None
        self._halt = True
        events.log("dance", event="end", reason=reason)
        _resolve(d["future"], {"ended": reason})

    def _missed(self, moved: set, target: dict) -> str | None:
        """Words for the commanded joint that ended furthest from its target,
        if it is further than REACH_TOL."""
        pose = self.measured()
        off = {j: abs(pose[j] - target[j]) for j in moved if j in pose}
        worst = max(off, key=off.get, default=None)
        if worst is None or off[worst] <= REACH_TOL:
            return None
        return MISSED.format(joint=worst.replace("_", " "), off=off[worst])

    def _policy_loop(self, task: str, infer, stop: threading.Event,
                     timeout_s: float, fut: Future) -> None:
        deadline = self._clock() + timeout_s + FIRST_CHUNK_GRACE_S
        first_at, ended, error = None, "done", None
        try:
            while not stop.is_set() and self._clock() < deadline:
                obs = self._leader.observation()
                try:
                    if not obs.images:
                        rows = None
                    else:
                        t0 = time.perf_counter()
                        raw = infer(obs, task)
                        events.log("infer",
                                   ms=round((time.perf_counter() - t0) * 1e3),
                                   now=_rounded(obs.joints),
                                   row0=_rounded(raw[0]), last=_rounded(raw[-1]))
                        rows = guard_chunk(raw, obs.joints)
                finally:
                    for frame in obs.images.values():
                        frame.release()
                if rows is None:
                    time.sleep(0.05)            # no video yet
                    continue
                with self._lock:
                    if stop.is_set():
                        break
                    self._chunk = _Chunk(rows, obs.observation_id)
                if first_at is None:            # the motion budget starts now
                    first_at = self._clock()
                    deadline = first_at + timeout_s
        except Exception as exc:
            _log.error("policy stopped: %s\n%s", exc, traceback.format_exc())
            self.policy_error = str(exc)
            ended, error = "error", str(exc)
        if ended == "done" and stop.is_set():
            ended = "stopped"
        ran = 0.0 if first_at is None else self._clock() - first_at
        events.log("policy_end", task=task, ended=ended, ran_s=round(ran, 1),
                   error=error)
        with self._lock:
            if self._policy_stop is stop:       # ended by itself, not replaced
                self._policy_stop = None
                self._arm_policy = False        # it may end before it ever armed
                self._chunk = None
                self._halt = True
        out = {"ended": ended, "ran_s": round(ran, 1)}
        if error:
            out["error"] = POLICY_FAILED.format(reason=error)
        _resolve(fut, out)
