"""Jev watches -- and in `control` mode drives -- a SmolVLA run.

    smolvla_leader.py --jev shadow    watch and log only: the bare-policy baseline
    smolvla_leader.py --jev control   after a failed grasp Jev takes the arm from
                                      the policy (back off / go home), then hands it back
    smolvla_leader.py --jev gate      as shadow, plus option 2: grasping chunks Jev
                                      says would miss are resampled (jev_gate.py)

A failed grasp = the policy closed the gripper and Jev never saw the cube
lifted within FAIL_AFTER_S. Jev's own per-frame "is this attempt going well?"
(`action`) was tried as the trigger first and rejected: on logged frames it
said back_off for good approaches (0.72-0.78) as well as for drags, while
`lifted` separated carrying (0.91-0.94) from dragging (<= 0.47). `action` is
still asked and logged, so the logs show what it would have done.

Every mode ends an episode the same way -- cube in the bowl (success), a hand
in view, or --max-s -- and writes summary.json next to the tick log, so the
modes compare like for like (jev_report.py).

Needs TYPESAFE_API_KEY (from the --env-file). Logs: inference/logs/jev-<stamp>/.
"""

import json
import os
import statistics
import threading
import time
import traceback
from pathlib import Path

import cv2

MODEL = "jev-1.14.0"
IMG_HDR = {"TypeSafe-Danger-Zone-Images": "true"}
PRICE_PER_TOK = 0.042 / 1e6

#: Episode end, all modes. Tune on the logs.
DONE_P, DONE_TICKS = 0.8, 3        # cube in bowl, not lifted, 3 ticks running
HAND_P, HAND_TICKS = 0.7, 2        # a hand, 2 ticks running (the dashboard e-stop is the fast path)

#: Control mode.
LIFT_P = 0.7                       # "lifted" above this = the grasp worked
FAIL_AFTER_S = 4.0                 # a grasp with no lift this long after it has failed
ESCALATE = ("back_off", "back_off", "go_home", "go_home")   # 1st failure, 2nd, ...
COOLDOWN_S = 3.0                   # after a recovery, before failures are judged again
ACT_P = 0.6                        # for logging what `action` would have done
OPEN_GRIP = 35.0                   # gripper reading for "open" (dataset 1..53)

ARM = ("shoulder_pan", "shoulder_lift", "elbow_flex", "wrist_flex", "wrist_roll")
JOINTS = ARM + ("gripper",)


def questions():
    from typesafe_sdk import Choice, Noul
    return {
        "cube_visible": Noul(instructions="An orange cube is visible in `top` or `side`."),
        "lifted": Noul(instructions="In `side`, the orange cube is up in the air, held by the "
                                    "gripper -- not resting on the table and not in the bowl."),
        "in_bowl": Noul(instructions="The orange cube is inside the white bowl, in `top` or `side`."),
        "hand": Noul(instructions="A human hand or arm is in the workspace, in `top` or `side`."),
        "phase": Choice(
            instructions="Which best describes the scene?",
            criteria={
                "approaching": "cube on the table, gripper not holding it, cube not in the bowl",
                "grasped": "cube between the gripper jaws, lifted or about to be",
                "placed": "cube inside the bowl, gripper empty",
                "no_cube": "no orange cube anywhere in view",
            },
        ),
        "action": Choice(
            instructions="The robot arm is trying to pick up the orange cube and put it in the "
                         "white bowl. Is its current attempt going well? Pick what it should do now.",
            criteria={
                "continue": "Nothing is wrong: the gripper is moving toward the cube, lowering "
                            "around it, holding it, carrying it, or releasing it into the bowl.",
                "back_off": "The attempt is failing but the cube is easy to reach: a jaw is "
                            "pressing on, pushing or dragging the cube, the cube sits beside a jaw "
                            "instead of between the open jaws, or the gripper closed on nothing.",
                "go_home": "The arm is stuck: pressing into the bowl or the table, twisted into "
                           "an odd pose, or the cube is pinned against the bowl or the robot base.",
            },
        ),
    }


# ── Recovery moves (joint space, at the policy rate) ───────────────────────

def ease(a: dict, b: dict, n: int) -> list:
    out = []
    for k in range(1, max(1, n) + 1):
        t = k / max(1, n)
        w = t * t * (3 - 2 * t)
        out.append({j: a[j] + w * (b[j] - a[j]) for j in JOINTS})
    return out


def back_off(cur: dict, home: dict, hz: float) -> list:
    """Open, then go halfway home (up and back), hold: the policy re-plans from a clear view."""
    opened = {**cur, "gripper": OPEN_GRIP}
    mid = {j: cur[j] + 0.5 * (home[j] - cur[j]) for j in ARM}
    mid["gripper"] = OPEN_GRIP
    return ease(cur, opened, int(0.5 * hz)) + ease(opened, mid, int(1.5 * hz)) + [mid] * int(0.5 * hz)


def go_home(cur: dict, home: dict, hz: float) -> list:
    """Open, then the whole way to the training start pose, hold: a fresh episode start."""
    opened = {**cur, "gripper": OPEN_GRIP}
    dist = max(abs(home[j] - cur[j]) for j in ARM)
    dur = max(1.5, dist / 30.0)                      # same pace as the leader's homing
    return ease(cur, opened, int(0.5 * hz)) + ease(opened, home, int(dur * hz)) + [dict(home)] * int(0.5 * hz)


# ── Supervisor ─────────────────────────────────────────────────────────────

class JevSupervisor(threading.Thread):
    """`views` maps the names the questions use (top/wrist/side) to follower labels."""

    def __init__(self, leader, stop, ready, ctl, *, views: dict, home: dict, policy_hz: float,
                 mode: str, max_s: float, log_dir: Path, hz: float = 1.0):
        super().__init__(name="jev", daemon=True)
        self.leader, self.stop, self.ready, self.ctl = leader, stop, ready, ctl
        self.views, self.home, self.policy_hz = views, home, policy_hz
        self.mode, self.max_s, self.log_dir, self.period = mode, max_s, log_dir, 1.0 / hz
        self.reason = None
        self.rows, self.recoveries = [], []
        self.t_ready = None
        self._done = self._hand = 0
        self._last_lift = 0.0
        self._judged_until = 0.0
        self._cooldown_until = 0.0
        self._summary = None

    def run(self):
        try:
            self._run()
        except Exception:
            traceback.print_exc()
            print("  jev: supervisor died -- the policy keeps running, ctrl-c to stop", flush=True)

    def _run(self):
        from typesafe_sdk import Image, TypeSafeClient
        if not os.getenv("TYPESAFE_API_KEY"):
            print("  jev: TYPESAFE_API_KEY not set -- supervisor off", flush=True)
            return
        self.log_dir.mkdir(parents=True, exist_ok=True)
        log = open(self.log_dir / "ticks.jsonl", "a")
        qs = questions()
        client = TypeSafeClient(headers=IMG_HDR, timeout=5.0)
        print(f"  jev: {self.mode.upper()} at {1 / self.period:g} Hz, log {self.log_dir}", flush=True)
        tick = 0
        while not self.stop.is_set():
            t0 = time.monotonic()
            obs = self.leader.observation()
            try:
                jpegs = {name: _jpeg(obs.images[lbl]) for name, lbl in self.views.items()
                         if lbl in obs.images}
                joints = dict(obs.joints)
            finally:
                for f in obs.images.values():
                    f.release()
            if len(jpegs) < len(self.views):
                time.sleep(0.2)
                continue
            try:
                r = client.system_one(
                    state={**{k: Image(v) for k, v in jpegs.items()},
                           "gripper_reading": f"{joints.get('gripper', 0.0):.1f} (0 = closed)"},
                    questions=qs, model=MODEL)
            except Exception as exc:         # the API is not allowed to end a run
                print(f"  jev: {exc.__class__.__name__}: {str(exc)[:80]}", flush=True)
                time.sleep(1.0)
                continue
            a = r.answers
            now = time.monotonic()
            if self.ready.is_set() and self.t_ready is None:
                self.t_ready = now
            t_ep = None if self.t_ready is None else now - self.t_ready
            act = a["action"]
            row = {"t": time.time(), "t_ep": t_ep, "tick": tick,
                   "ms": round((now - t0) * 1e3), "tokens": r.usage.input_tokens,
                   "joints": joints, "jev_driving": self.ctl.driving,
                   "cube_visible": a["cube_visible"].noul, "lifted": a["lifted"].noul,
                   "in_bowl": a["in_bowl"].noul, "hand": a["hand"].noul,
                   "phase": a["phase"].choice, "phase_conf": a["phase"].confidence,
                   "action": act.choice, "action_p": dict(act.probabilities)}
            self.rows.append(row)
            log.write(json.dumps(row) + "\n"); log.flush()
            for k, v in jpegs.items():
                (self.log_dir / f"{tick:05d}-{k}.jpg").write_bytes(v)
            cost = sum(x["tokens"] for x in self.rows) * PRICE_PER_TOK
            print(f"  jev {row['ms']:4d}ms  lifted={row['lifted']:.2f} bowl={row['in_bowl']:.2f} "
                  f"hand={row['hand']:.2f} grip={joints.get('gripper', 0):4.1f}  {row['phase']:<11} "
                  f"-> {act.choice}({row['action_p'][act.choice]:.2f})"
                  f"{'  [JEV DRIVING]' if row['jev_driving'] else ''}  ${cost:.4f}", flush=True)
            tick += 1

            if t_ep is not None:
                self._rules(row, now, t_ep)
            time.sleep(max(0.0, self.period - (time.monotonic() - t0)))

    def _rules(self, row, now, t_ep):
        self._done = self._done + 1 if row["in_bowl"] > DONE_P and row["lifted"] < 0.5 else 0
        self._hand = self._hand + 1 if row["hand"] > HAND_P else 0
        if row["lifted"] > LIFT_P:
            self._last_lift = now
        if self._done >= DONE_TICKS:
            return self._end("success")
        if self._hand >= HAND_TICKS:
            return self._end("hand")
        if t_ep > self.max_s:
            return self._end("timeout")
        if self.mode == "control":
            self._control(now, t_ep)

    def _control(self, now, t_ep):
        """After a failed grasp, take the arm: back off twice, then go home twice, then give up."""
        if self.ctl.driving or now < self._cooldown_until:
            return
        pending = [t for t in self.ctl.close_times if t > self._judged_until]
        if not pending or now - pending[0] < FAIL_AFTER_S:
            return
        self._judged_until = now                 # one verdict covers every grasp up to here
        if self._last_lift >= pending[0]:
            return                               # it lifted the cube: that grasp worked
        if len(self.recoveries) >= len(ESCALATE):
            return self._end("gave_up")
        kind = ESCALATE[len(self.recoveries)]
        steps = (back_off if kind == "back_off" else go_home)(
            self.leader.read_joints(), self.home, self.policy_hz)
        self.ctl.take_over(steps)
        self.recoveries.append({"t_ep": round(t_ep, 1), "kind": kind,
                                "grasp_at": round(pending[0] - self.t_ready, 1)})
        self._cooldown_until = now + len(steps) / self.policy_hz + COOLDOWN_S
        print(f"  jev: FAILED GRASP (closed {now - pending[0]:.0f}s ago, cube never lifted) "
              f"-> TAKING OVER: {kind}, {len(steps) / self.policy_hz:.1f}s, then the policy "
              f"re-plans ({len(self.recoveries)}/{len(ESCALATE)})", flush=True)

    def _end(self, why: str) -> None:
        if self.reason is None:
            self.reason = why
            self.stop.set()

    def finish(self) -> dict | None:
        """Write summary.json once. Called by the leader on the way out."""
        if self._summary is not None or not self.rows:
            return self._summary
        ep = [r for r in self.rows if r["t_ep"] is not None]
        chunks = [c["ms"] for c in self.ctl.chunks]
        gate = getattr(self.ctl.gate, "rows", None)
        s = {
            "mode": self.mode, "started": self.rows[0]["t"],
            "outcome": self.reason or "aborted",
            "success": self.reason == "success",
            "t_end": round(ep[-1]["t_ep"], 1) if ep else 0.0,
            "grasp_attempts": len(self.ctl.close_times),
            "recoveries": self.recoveries,
            "would_act": sum(1 for r in ep if r["action"] != "continue"
                             and r["action_p"][r["action"]] >= ACT_P),
            "chunk_ms": _stats(chunks), "chunks": len(chunks),
            "jev_ms": _stats([r["ms"] for r in self.rows]),
            "jev_ticks": len(self.rows),
            "jev_cost": round(sum(r["tokens"] for r in self.rows) * PRICE_PER_TOK, 5),
        }
        if gate is not None:
            s["gate"] = {"judged": len(gate), "rejected": sum(1 for g in gate if not g["ok"]),
                         "errors": sum(1 for g in gate if g.get("error")),
                         "ms": _stats([g["ms"] for g in gate])}
        steer = getattr(self.ctl.steer, "rows", None)
        if steer is not None:
            s["steer"] = {"judged": len(steer), "edited": sum(1 for r in steer if r["edited"]),
                          "miss_cm": _stats([r["miss_cm"] for r in steer if "miss_cm" in r]),
                          "after_cm": _stats([r["after_cm"] for r in steer if "after_cm" in r]),
                          "ms": _stats([r["ms"] for r in steer])}
        (self.log_dir / "summary.json").write_text(json.dumps(s, indent=1))
        print(f"episode: {s['outcome']} at {s['t_end']}s  grasp attempts {s['grasp_attempts']}  "
              f"recoveries {len(self.recoveries)}  chunk {s['chunk_ms']['p50']} ms  "
              f"jev ${s['jev_cost']}  -> {self.log_dir / 'summary.json'}", flush=True)
        self._summary = s
        return s


def _stats(xs):
    xs = sorted(xs)
    if not xs:
        return {"n": 0, "p50": None, "p90": None}
    return {"n": len(xs), "p50": round(statistics.median(xs)), "p90": round(xs[int(0.9 * (len(xs) - 1))])}


def _jpeg(frame) -> bytes:
    """I420 wire frame -> JPEG bytes (BGR for cv2's encoder)."""
    bgr = cv2.cvtColor(frame.array, cv2.COLOR_YUV2BGR_I420)
    ok, buf = cv2.imencode(".jpg", bgr, [cv2.IMWRITE_JPEG_QUALITY, 85])
    assert ok
    return buf.tobytes()


if __name__ == "__main__":
    # Self-check: recovery moves start where the arm is, end where they should,
    # and never step further than the leader's speed clamp would allow anyway.
    cur = {"shoulder_pan": 20.0, "shoulder_lift": 10.0, "elbow_flex": 30.0,
           "wrist_flex": 70.0, "wrist_roll": 0.0, "gripper": 12.0}
    home = {"shoulder_pan": -9.0, "shoulder_lift": -106.3, "elbow_flex": 94.7,
            "wrist_flex": 77.7, "wrist_roll": 9.9, "gripper": 2.5}
    b = back_off(cur, home, 10.0)
    assert b[0]["shoulder_pan"] == cur["shoulder_pan"] and b[4]["gripper"] == OPEN_GRIP
    assert abs(b[-1]["shoulder_lift"] - (10.0 - 0.5 * 116.3)) < 1e-9 and b[-1]["gripper"] == OPEN_GRIP
    h = go_home(cur, home, 10.0)
    assert h[-1] == home and len(h) == 5 + int(116.3 / 30 * 10) + 5
    for seq in (b, h):
        steps = [cur] + seq
        worst = max(abs(y[j] - x[j]) for x, y in zip(steps, steps[1:]) for j in ARM)
        assert worst < 8.0, worst          # leader clamps arm joints at 80 u/s = 8 per step
    assert set(questions()) == {"cube_visible", "lifted", "in_bowl", "hand", "phase", "action"}

    # Failed-grasp trigger: a grasp followed by a lift is left alone; one with
    # no lift takes the arm (back_off first); a 5th failure gives up.
    import types
    taken = []
    ctl = types.SimpleNamespace(close_times=[], driving=False, take_over=taken.append)
    sup = JevSupervisor(types.SimpleNamespace(read_joints=lambda: dict(cur)), threading.Event(),
                        threading.Event(), ctl, views={}, home=home, policy_hz=10.0,
                        mode="control", max_s=999, log_dir=Path("."))
    sup.t_ready = 0.0
    tick = lambda t, lifted: sup._rules({"in_bowl": 0.0, "hand": 0.0, "lifted": lifted}, t, t)
    ctl.close_times.append(10.0)
    for t in range(10, 16):
        tick(t, 0.9 if t == 12 else 0.1)          # lifted at 12 s
    assert not taken, "a grasp that lifted was treated as failed"
    ctl.close_times.append(20.0)
    for t in range(20, 25):
        tick(t, 0.1)
    assert len(taken) == 1 and sup.recoveries[0]["kind"] == "back_off", sup.recoveries
    for n, t0 in enumerate((40, 60, 80, 100)):
        ctl.close_times.append(t0)
        for t in range(t0, t0 + 6):
            tick(t, 0.1)
    assert [r["kind"] for r in sup.recoveries] == list(ESCALATE) and sup.reason == "gave_up"
    print("ok")
