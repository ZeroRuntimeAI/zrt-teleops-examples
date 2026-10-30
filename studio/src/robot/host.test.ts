import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { FollowerHost, initSync, LeaderPeer, type LeaderPeerOut } from "@zeroruntime/teleops-wasm";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { forwardKinematics } from "../sim/ik";
import { HOME, JOINTS, type Joints } from "../sim/jointMap";
import type { JogInput } from "../sim/jog";
import { loadTestScene } from "../sim/loadTestScene";
import type { Scene } from "../sim/scene";
import { followerConfig, ROBOT_ID, RobotHost } from "./host";
import type { FromWorker, OutboundMsg, RobotStatus } from "./protocol";

const SELF = "studio-tab";
const WALL0 = 1_787_000_000_000;
const TICK_S = 0.01;
const ZERO: JogInput = { x: 0, y: 0, z: 0, roll: 0, grip: 0 };
const UP: JogInput = { ...ZERO, z: 1 };

let scene: Scene;

beforeAll(async () => {
  const wasm = createRequire(import.meta.url).resolve("@zeroruntime/teleops-wasm/teleops_wasm_bg.wasm");
  initSync({ module: readFileSync(wasm) });
  ({ scene } = await loadTestScene());
});

const gripperZ = () => scene.observeScene().gripper.pos[2];
const BODY = JOINTS.filter((name) => name !== "gripper");

/** Test-only: put the red cube 1 cm behind the gripper's TCP, between open jaws, at rest. */
function cubeBetweenTheJaws(): void {
  const { mj, model, data } = scene;
  const body = mj.mj_name2id(model, mj.mjtObj.mjOBJ_BODY.value, "red_cube");
  const site = mj.mj_name2id(model, mj.mjtObj.mjOBJ_SITE.value, "gripperframe");
  const wrist = mj.mj_name2id(model, mj.mjtObj.mjOBJ_BODY.value, "gripper");
  const jnt = (model.body_jntadr as Int32Array)[body];
  const tcp = Array.from((data.site_xpos as Float64Array).subarray(3 * site, 3 * site + 3));
  const back = tcp.map((v, i) => v - (data.xpos as Float64Array)[3 * wrist + i]);
  const len = Math.hypot(...back);
  const pos = tcp.map((v, i) => v - (0.01 * back[i]) / len);
  (data.qpos as Float64Array).set([...pos, 1, 0, 0, 0], (model.jnt_qposadr as Int32Array)[jnt]);
  const dof = (model.jnt_dofadr as Int32Array)[jnt];
  (data.qvel as Float64Array).fill(0, dof, dof + 6);
  mj.mj_forward(model, data);
}

/** A host over the shared scene, a hand-advanced clock, and every post it makes. */
function rig() {
  const clock = { mono: 0, monoS: () => clock.mono, wallMs: () => WALL0 + clock.mono * 1000 };
  const posts: FromWorker[] = [];
  const follower = new FollowerHost(followerConfig(SELF));
  const host = new RobotHost(scene, follower, (m) => posts.push(m), clock);
  const tick = (n = 1) => {
    for (let i = 0; i < n; i += 1) {
      clock.mono += TICK_S;
      host.tickOnce();
    }
  };
  const status = (): RobotStatus => {
    const last = posts.findLast((m) => m.t === "status");
    if (last?.t !== "status") throw new Error("no status posted yet");
    return last.status;
  };
  return { clock, posts, follower, host, tick, status };
}
type Rig = ReturnType<typeof rig>;

const isCtl = (m: OutboundMsg): m is Extract<OutboundMsg, { kind: "pubsub" }> =>
  m.kind === "pubsub" && m.topic === "teleop-v2-ctl";

/** A remote leader wired to the host through nothing but these functions. */
function remote(r: Rig, id: string) {
  const peer = new LeaderPeer(id, ROBOT_ID);
  const events: Record<string, unknown>[] = [];
  let delivered = 0;
  const toHost = (out: LeaderPeerOut) => {
    events.push(...(out.events as Record<string, unknown>[]));
    for (const m of out.outbound) {
      if (m.kind === "data") r.host.handle({ t: "data", from: id, bytes: m.bytes });
      else r.host.handle({ t: "pubsub", topic: m.topic, from: id, message: m.message });
    }
  };
  /** Carry the host's sends to the peer, and the peer's answers back, until both go quiet. */
  const settle = () => {
    while (delivered < r.posts.length) {
      const p = r.posts[delivered];
      delivered += 1;
      if (p.t !== "send") continue;
      const m = p.msg;
      if (m.kind === "data") toHost(peer.ingest(SELF, m.bytes, r.clock.monoS(), r.clock.wallMs()));
      else if (!m.sendOnly || m.sendOnly.includes(id)) toHost(peer.onPubsub(m.topic, SELF, m.message));
    }
  };
  const step = () => {
    r.clock.mono += TICK_S;
    toHost(peer.tick(r.clock.monoS(), r.clock.wallMs()));
    r.host.tickOnce();
    settle();
  };
  const rpc = (method: string, payload: unknown) => {
    const { id: callId, out } = peer.performRpc(SELF, method, payload);
    toHost(out);
    settle();
    return events.find((e) => e.type === "rpc_reply" && e.id === callId);
  };
  return { peer, events, toHost, settle, step, rpc };
}

/** A remote leader that has claimed and been granted the lease. */
function holder(r: Rig, id: string) {
  const net = remote(r, id);
  net.settle();
  net.toHost(net.peer.claim());
  for (let i = 0; i < 50 && !net.peer.hasControl(); i += 1) net.step();
  expect(net.peer.hasControl()).toBe(true);
  return net;
}

describe("RobotHost", () => {
  let r: Rig;

  beforeEach(() => {
    // start() arms real intervals; frozen fake timers keep them out of the hand-driven loop.
    vi.useFakeTimers();
    scene.reset(0);
    r = rig();
  });

  afterEach(() => {
    r.host.stop();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("announces DESC on the reliable lane at start", () => {
    r.host.start();
    expect(r.posts.some((m) => m.t === "send" && m.msg.kind === "data" && m.msg.reliable)).toBe(true);
  });

  it("drives the arm through the core while a jog key is held", () => {
    r.host.start();
    const z0 = gripperZ();
    r.host.handle({ t: "jog", jog: UP });
    r.tick(100);
    expect(gripperZ() - z0).toBeGreaterThan(0.05);
    expect(r.status().accepted).toBeGreaterThan(0);
    expect(r.status().safeState).toBe("active");
    expect(r.posts.some((m) => m.t === "poses" && m.poses.length === 7 * scene.model.nbody)).toBe(true);
    // The joints ride along, in JOINTS order, so the page can hear the servos move.
    const posed = r.posts.find((m) => m.t === "poses");
    const joints = posed?.t === "poses" ? Array.from(posed.joints) : [];
    expect(joints).toHaveLength(JOINTS.length);
    expect(joints.every(Number.isFinite)).toBe(true);
  });

  it("integrates the jog from its own setpoint, at most 50 ms per tick", () => {
    r.host.start();
    const setpoints = vi.spyOn(r.follower, "localSetJoints");
    const setpointZ = () => forwardKinematics(scene, setpoints.mock.lastCall?.[0] as Joints)[2];
    r.host.handle({ t: "jog", jog: UP });
    const z0 = setpointZ();
    r.tick(100);
    // 0.10 m/s for 1 s exactly: the sim readback lags, the setpoint does not.
    expect(setpointZ() - z0).toBeCloseTo(0.1, 3);

    const z1 = setpointZ();
    r.clock.mono += 0.3; // a late tick, short of the suspension threshold
    r.tick();
    expect(setpointZ() - z1).toBeLessThan(0.1 * 0.05 + 1e-4);
  });

  it("latches the e-stop within 300 ms and ignores further jogging", () => {
    r.host.start();
    r.host.handle({ t: "jog", jog: UP });
    r.tick(20);
    r.host.handle({ t: "stop" });
    let ticks = 0;
    while (r.status().safeState !== "estopped" && ticks < 30) {
      r.tick();
      ticks += 1;
    }
    expect(r.status().safeState).toBe("estopped");

    r.host.handle({ t: "jog", jog: ZERO });
    r.tick(30);
    const z = gripperZ();
    r.host.handle({ t: "jog", jog: UP });
    r.tick(50);
    expect(Math.abs(gripperZ() - z)).toBeLessThan(0.002);
    expect(r.status().safeState).toBe("estopped");
  });

  it("clears the e-stop and reseeds the scene on reset", async () => {
    r.host.start();
    r.host.handle({ t: "stop" });
    r.host.handle({ t: "reset", seed: 7 });
    const { scene: fresh } = await loadTestScene();
    fresh.reset(7);
    expect(Array.from(scene.bodyPoses())).toEqual(Array.from(fresh.bodyPoses()));
    r.tick(20);
    expect(r.status().safeState).not.toBe("estopped");
  });

  it("resets mid-drive: stops, lays out again, and holds", () => {
    r.host.start();
    r.host.handle({ t: "jog", jog: UP });
    r.tick(20);
    expect(r.status().safeState).toBe("active");
    r.host.handle({ t: "reset", seed: 2 });
    r.tick(20);
    expect(r.status().safeState).toBe("holding");
  });

  it("re-seeds the follower on reset, so the first press does not snap back", () => {
    r.host.start();
    r.host.handle({ t: "jog", jog: UP });
    r.tick(100); // drive well away from where the reset will put the arm
    r.host.handle({ t: "jog", jog: ZERO });
    r.host.handle({ t: "stop" });
    r.tick(10);
    r.host.handle({ t: "reset", seed: 5 });
    const pose = scene.joints();

    const targets = vi.spyOn(scene, "setTargets");
    r.host.handle({ t: "setJoints", joints: { shoulder_pan: pose.shoulder_pan }, held: true });
    r.tick(50);
    expect(targets).toHaveBeenCalled();
    for (const [target] of targets.mock.calls) {
      for (const name of JOINTS) expect(Math.abs(target[name] - pose[name])).toBeLessThanOrEqual(0.75);
    }
  });

  it("anchors a fresh press on the last applied target, so a squeeze survives", () => {
    const gravity = scene.model.opt.gravity as Float64Array;
    const g = gravity[2];
    gravity[2] = 0; // the cube stays put while the jaws close on it
    try {
      r.host.start();
      const targets = vi.spyOn(scene, "setTargets");
      const setpoints = vi.spyOn(r.follower, "localSetJoints");
      r.host.handle({ t: "jog", jog: { ...ZERO, grip: 1 } });
      r.tick(120);
      r.host.handle({ t: "jog", jog: ZERO });
      r.tick(10);
      cubeBetweenTheJaws();
      r.host.handle({ t: "jog", jog: { ...ZERO, grip: -1 } });
      r.tick(200);
      r.host.handle({ t: "jog", jog: ZERO });
      r.tick(20);
      const last = targets.mock.lastCall?.[0] as Joints;
      expect(last.gripper).toBe(0);
      expect(scene.joints().gripper).toBeGreaterThan(5); // the jaw stalls on the cube

      r.host.handle({ t: "jog", jog: UP });
      const anchor = setpoints.mock.lastCall?.[0] as Joints;
      expect(anchor.gripper).toBe(last.gripper);
    } finally {
      gravity[2] = g;
    }
  });

  it("holds without a jump when the tab was hidden mid-jog", () => {
    r.host.start();
    r.host.handle({ t: "jog", jog: UP });
    r.tick(50);
    expect(r.status().safeState).toBe("active");
    const before = scene.joints();

    r.clock.mono += 2.0;
    r.tick();

    expect(r.status().safeState).toBe("holding");
    expect(r.status().hidden).toBe(true);
    const after = scene.joints();
    for (const name of JOINTS) expect(Math.abs(after[name] - before[name])).toBeLessThanOrEqual(0.75);

    // A fresh press resumes.
    r.host.handle({ t: "jog", jog: ZERO });
    r.host.handle({ t: "jog", jog: UP });
    r.tick(30); // past the next 5 Hz status
    expect(r.status().safeState).toBe("active");
    expect(r.status().hidden).toBe(false);
  });

  it("moves a joint from the drawer sliders and refuses non-finite values", () => {
    r.host.start();
    r.host.handle({ t: "setJoints", joints: { shoulder_pan: Number.NaN }, held: true });
    expect(r.posts.some((m) => m.t === "event" && "type" in m.event && m.event.type === "invalid_input")).toBe(true);

    r.host.handle({ t: "setJoints", joints: { shoulder_pan: 30 }, held: true });
    r.tick(200);
    expect(Math.abs(scene.joints().shoulder_pan - 30)).toBeLessThan(2);
    r.host.handle({ t: "setJoints", joints: { shoulder_pan: 30 }, held: false });
    r.tick(20);
    expect(r.status().deadman).toBe(false);
  });

  it("answers observe_scene for the lease holder", () => {
    r.host.start();
    const net = holder(r, "py-leader");
    const mark = r.posts.length;
    const reply = net.rpc("observe_scene", null);
    const answer = r.posts
      .slice(mark)
      .find((m) => m.t === "send" && isCtl(m.msg) && m.msg.message.includes('"cubes"'));
    expect(answer).toBeDefined();
    expect(reply).toMatchObject({ ok: true, result: { cubes: expect.any(Array) } });
  });

  it("answers the other scene RPCs and refuses unknown ones", () => {
    r.host.start();
    const net = holder(r, "py-leader");
    expect(net.rpc("task_status", null)).toMatchObject({ ok: true, result: { inBox: [] } });
    expect(net.rpc("reset_scene", { seed: 3 })).toMatchObject({ ok: true, result: { ok: true } }); // holding
    expect(net.rpc("reset_scene", { seed: "x" })).toMatchObject({ ok: false, error: expect.any(String) });
    expect(net.rpc("dance", null)).toMatchObject({ ok: false, error: "unknown method" });

    // Drive away from HOME as the remote holder; a reset needs the arm held first.
    net.peer.holdDeadman(true);
    net.peer.setJoints({ ...HOME, shoulder_pan: 25 });
    for (let i = 0; i < 150; i += 1) net.step();
    expect(scene.joints().shoulder_pan).toBeGreaterThan(15);
    expect(net.rpc("reset_scene", { seed: 3 })).toMatchObject({ ok: false, error: "release the deadman first" });
  });

  it("homes for the caller, then hands the arm back", () => {
    r.host.start();
    const net = holder(r, "py-leader");
    net.peer.holdDeadman(true);
    net.peer.setJoints({ ...HOME, shoulder_pan: 25 });
    for (let i = 0; i < 150; i += 1) net.step();
    net.peer.holdDeadman(false);
    const deadman = vi.spyOn(r.follower, "localDeadman");
    const handBack = vi.spyOn(r.follower, "handBack");

    expect(net.rpc("home", null)).toMatchObject({ ok: true });
    expect(r.follower.status().leaseHolder).toBe(`${SELF}:keyboard`);
    let ticks = 0;
    while (r.follower.status().leaseHolder !== "py-leader" && ticks < 600) {
      net.step();
      ticks += 1;
    }
    expect(ticks).toBeLessThan(500); // on arrival, not on the 5 s timeout
    for (const name of BODY) expect(Math.abs(scene.joints()[name] - HOME[name])).toBeLessThanOrEqual(1);
    // The local deadman is released before the hand-back, so nothing stays latched.
    expect(handBack).toHaveBeenCalledOnce();
    expect(deadman.mock.lastCall?.[0]).toBe(false);
    expect(deadman.mock.invocationCallOrder.at(-1)).toBeLessThan(handBack.mock.invocationCallOrder[0]);
    expect(net.peer.hasControl()).toBe(true);
    expect(net.rpc("observe_scene", null)).toMatchObject({ ok: true });
  });

  it("hands control back on reset, so a remote leader can claim after a key press", () => {
    r.host.start();
    r.host.handle({ t: "jog", jog: UP });
    r.tick(10);
    r.host.handle({ t: "jog", jog: ZERO });
    expect(r.follower.status().activeOperator).toBe(`${SELF}:keyboard`);

    r.host.handle({ t: "reset", seed: 3 });
    expect(r.follower.status().activeOperator).toBeNull();
    const net = holder(r, "py-leader");
    expect(r.follower.status().leaseHolder).toBe("py-leader");
    expect(net.peer.hasControl()).toBe(true);
  });

  it("a Stop ends a remote home: the lease is never re-granted to its caller", () => {
    r.host.start();
    const net = holder(r, "py-leader");
    expect(net.rpc("home", null)).toMatchObject({ ok: true });
    const handBack = vi.spyOn(r.follower, "handBack");
    r.host.handle({ t: "stop" });
    for (let i = 0; i < 600; i += 1) net.step(); // past the 5 s home timeout
    expect(handBack).not.toHaveBeenCalled();
    expect(r.follower.status().leaseHolder).not.toBe("py-leader");
    expect(net.peer.hasControl()).toBe(false);
  });

  it("a Reset ends a remote home: it hands back once, not again on the timeout", () => {
    r.host.start();
    const net = holder(r, "py-leader");
    expect(net.rpc("home", null)).toMatchObject({ ok: true });
    const handBack = vi.spyOn(r.follower, "handBack");
    r.host.handle({ t: "reset", seed: 3 });
    for (let i = 0; i < 600; i += 1) net.step();
    expect(handBack).toHaveBeenCalledOnce();
  });

  it("refuses a remote reset_scene while e-stopped: only the UI clears a stop", () => {
    r.host.start();
    r.host.handle({ t: "stop" });
    const net = holder(r, "py-leader"); // the core lets a claim through while stopped
    expect(net.rpc("reset_scene", { seed: 3 })).toMatchObject({ ok: false, error: "estopped" });
    r.tick(30);
    expect(r.status().safeState).toBe("estopped");
  });

  it("refuses an RPC from a peer without the lease", () => {
    r.host.start();
    const net = remote(r, "py-leader");
    net.settle();
    const mark = r.posts.length;
    const reply = net.rpc("observe_scene", null);
    expect(reply).toMatchObject({ ok: false });
    expect(r.posts.slice(mark).some((m) => m.t === "send" && isCtl(m.msg) && m.msg.message.includes('"cubes"'))).toBe(
      false,
    );
  });
});
