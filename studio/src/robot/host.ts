import type { FollowerHost, FollowerHostConfig, HostOut, RpcRequest } from "@zeroruntime/teleops-wasm";
import { HOME, JOINTS, LIMITS, type Joints } from "../sim/jointMap";
import { applyJog, type JogInput } from "../sim/jog";
import type { Scene } from "../sim/scene";
import type { Clock } from "./clock";
import type { FromWorker, ToWorker } from "./protocol";

export const ROBOT_ID = "studio-so101";
const CONTROL_HZ = 100;
const TICK_MS = 1000 / CONTROL_HZ;
const STALL_CHECK_MS = 50;
const POSES_EVERY_S = 0.016;
const STATUS_EVERY_S = 0.2;
/** The most jog one tick integrates, so a late tick cannot fling the setpoint. */
const MAX_JOG_DT_S = 0.05;
/** A gap past the core's 0.5 s watchdog means the loop was suspended: a hidden or frozen tab. */
const SUSPENDED_S = 0.5;
const ZERO_JOG: JogInput = { x: 0, y: 0, z: 0, roll: 0, grip: 0 };
/** `home` hands the arm back once every body joint is this close to HOME, or after the timeout. */
const HOME_TOLERANCE_DEG = 1;
const HOME_TIMEOUT_S = 5;
const BODY = JOINTS.filter((name) => name !== "gripper");

const axis = (v: number): -1 | 0 | 1 => (v > 0 ? 1 : v < 0 ? -1 : 0);
const isJoint = (name: string) => (JOINTS as readonly string[]).includes(name);
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** This tab's Follower. The lease seed is 64 bits of real entropy: it gates the data lane. */
export function followerConfig(selfId: string): FollowerHostConfig {
  return {
    robotId: ROBOT_ID,
    controlHz: CONTROL_HZ,
    limits: LIMITS as Record<string, [number, number]>,
    leaseSeed: crypto.getRandomValues(new BigUint64Array(1))[0].toString(),
    selfId,
    localOperatorId: `${selfId}:keyboard`,
    videoTracks: [{ label: "front", width: 640, height: 480, fps: 30 }],
  };
}

/**
 * The simulated SO-101 as a teleop Follower. Paces the 100 Hz loop and the watchdog timer, turns the
 * visitor's keys and sliders into the in-tab operator's setpoint, and answers the scene RPCs.
 * Uses no DOM or Worker globals, so it runs under Node.
 */
export class RobotHost {
  private timers: ReturnType<typeof setInterval>[] = [];
  private lastMono = 0;
  private lastPosesMono = -Infinity;
  private lastStatusMono = -Infinity;
  private jog: JogInput = ZERO_JOG;
  private slidersHeld = false;
  /** The local operator's deadman is squeezed: a jog, a slider drag or `home` is in progress. */
  private engaged = false;
  /** The local operator's latest setpoint. Jogs integrate from it, not from the sim readback. */
  private setpoint: Joints;
  /** The last target the core applied: where a fresh press starts, so a squeeze is not lost. */
  private lastTarget: Joints | null = null;
  /** While `home` runs: when it gives up and hands the arm back anyway. */
  private homeDeadline: number | null = null;
  private hidden = false;

  constructor(
    private readonly scene: Scene,
    private readonly follower: FollowerHost,
    private readonly post: (m: FromWorker) => void,
    private readonly clock: Clock,
  ) {
    this.setpoint = scene.joints();
  }

  /** Seed the follower from the arm's pose, announce, and start the loop and the watchdog timer. */
  start(): void {
    this.lastMono = this.clock.monoS();
    this.apply(this.follower.start(this.scene.joints(), this.lastMono, this.clock.wallMs()));
    this.timers = [
      this.every(TICK_MS, () => this.tickOnce()),
      // Its own timer, so a dead tick loop still trips the core into a safe state.
      this.every(STALL_CHECK_MS, () => this.apply(this.follower.stallCheck(this.clock.monoS()))),
    ];
  }

  stop(): void {
    this.timers.forEach(clearInterval);
    this.timers = [];
  }

  /** One control period: physics, the jog setpoint, the follower, then poses and status. */
  tickOnce(): void {
    const mono = this.clock.monoS();
    const elapsed = mono - this.lastMono;
    this.lastMono = mono;
    if (elapsed > SUSPENDED_S) {
      // Keys may have come up while nobody listened: hold, and wait for a fresh press.
      this.release();
      this.hidden = true;
    }
    // Scene.step catches up at most 0.2 s per call, so a long gap cannot jump the arm.
    this.scene.step(elapsed);
    if (this.jogging()) this.stepJog(Math.min(elapsed, MAX_JOG_DT_S));
    this.apply(this.follower.tick(mono, this.clock.wallMs(), this.scene.joints()));
    if (this.homeDeadline !== null && (this.atHome() || mono >= this.homeDeadline)) this.finishHome();
    if (mono - this.lastPosesMono >= POSES_EVERY_S) {
      this.lastPosesMono = mono;
      const joints = this.scene.joints();
      this.post({ t: "poses", poses: this.scene.bodyPoses(), joints: Float64Array.from(JOINTS, (n) => joints[n]) });
    }
    if (mono - this.lastStatusMono >= STATUS_EVERY_S) this.postStatus();
  }

  handle(m: ToWorker): void {
    const mono = this.clock.monoS();
    switch (m.t) {
      case "data":
        return this.apply(this.follower.onData(m.from, m.bytes, mono));
      case "pubsub":
        return this.apply(this.follower.onPubsub(m.topic, m.from, m.message, mono));
      case "left":
        return this.apply(this.follower.onParticipantLeft(m.id));
      case "connection":
        return this.apply(this.follower.onConnection(m.connected, m.why));
      case "jog":
        return this.onJog(m.jog);
      case "setJoints":
        return this.onSetJoints(m.joints, m.held);
      case "stop":
        // A human Stop ends a remote `home`: it must not later re-grant the lease to its caller.
        this.homeDeadline = null;
        this.apply(this.follower.estop("studio-ui"));
        return this.postStatus();
      case "reset":
        if (!Number.isFinite(m.seed)) return this.invalid("reset with a non-finite seed");
        this.homeDeadline = null;
        // Stopped first: resync refuses an active arm, and nobody drives through a teleport.
        // Its own source, so the activity log can tell this from the visitor's Stop.
        this.apply(this.follower.estop("studio-reset"));
        this.relayout(m.seed);
        // The only place an e-stop is cleared: the visitor's own Reset.
        this.apply(this.follower.clearEstop());
        // Then hand control back (to the last remote holder, or free for the next claim): the
        // visitor's earlier key press made them the active operator, and only this tab clears it.
        this.release();
        this.apply(this.follower.handBack(this.clock.wallMs()));
        return this.postStatus();
      case "handBack":
        this.homeDeadline = null;
        // release() drops the deadman first: it can stay latched across hand_back's free-control path.
        this.release();
        return this.apply(this.follower.handBack(this.clock.wallMs()));
      case "producers":
        return this.follower.setVideoProducers(m.map);
      case "init":
        return; // The worker entry boots the host.
    }
  }

  private onJog(jog: JogInput): void {
    const wasJogging = this.jogging();
    this.jog = { x: axis(jog.x), y: axis(jog.y), z: axis(jog.z), roll: axis(jog.roll), grip: axis(jog.grip) };
    if (!this.jogging()) this.releaseIfIdle();
    else if (!wasJogging) this.press();
  }

  private onSetJoints(joints: Partial<Joints>, held: boolean): void {
    if (!Object.entries(joints).every(([name, v]) => isJoint(name) && Number.isFinite(v))) {
      return this.invalid("setJoints with an unknown joint or a non-finite value");
    }
    if (held && !this.slidersHeld) {
      this.slidersHeld = true;
      this.press();
    }
    this.setSetpoint({ ...this.setpoint, ...joints });
    if (!held) {
      this.slidersHeld = false;
      this.releaseIfIdle();
    }
  }

  private jogging(): boolean {
    return Object.values(this.jog).some((v) => v !== 0);
  }

  private stepJog(dtS: number): void {
    this.setSetpoint(applyJog(this.scene, this.setpoint, this.jog, dtS));
  }

  /** The only way a setpoint reaches the follower: all six joints finite, or it is dropped. */
  private setSetpoint(joints: Joints): void {
    if (!JOINTS.every((name) => Number.isFinite(joints[name]))) return this.invalid("a non-finite setpoint");
    this.setpoint = joints;
    this.follower.localSetJoints(joints);
  }

  /**
   * A fresh press: the local operator takes the arm (preempting any remote holder, and ending a
   * `home`) and squeezes the deadman. It starts from the last applied target, not the measured
   * pose, so a gripper closed on a cube keeps squeezing.
   */
  private press(): void {
    this.homeDeadline = null;
    this.setSetpoint(this.engaged ? this.setpoint : (this.lastTarget ?? this.scene.joints()));
    this.engaged = true;
    this.apply(this.follower.localTakeControl(this.clock.wallMs()));
    // A reassignment clears the local leader's deadman, so squeeze it after taking control.
    this.apply(this.follower.localDeadman(true));
  }

  private releaseIfIdle(): void {
    if (this.engaged && !this.jogging() && !this.slidersHeld) this.release();
  }

  /** Drop every held input and the deadman: the next motion needs a fresh press. */
  private release(): void {
    this.jog = ZERO_JOG;
    this.slidersHeld = false;
    this.engaged = false;
    this.apply(this.follower.localDeadman(false));
  }

  /**
   * Lay the scene out again. The arm teleports, so held inputs are dropped and the follower's slew
   * base is re-seeded from the new pose: otherwise the next activation snaps the arm back.
   */
  private relayout(seed: number): void {
    this.release();
    this.scene.reset(seed);
    this.lastTarget = null;
    this.follower.resync(this.scene.joints());
  }

  /** Drive to HOME as the local operator; tickOnce hands the arm back on arrival or timeout. */
  private home(): void {
    this.press();
    this.setSetpoint({ ...HOME });
    this.homeDeadline = this.clock.monoS() + HOME_TIMEOUT_S;
  }

  private atHome(): boolean {
    const joints = this.scene.joints();
    return BODY.every((name) => Math.abs(joints[name] - HOME[name]) <= HOME_TOLERANCE_DEG);
  }

  /** Release the deadman, then hand the arm back to the caller (the last remote holder, if still here). */
  private finishHome(): void {
    this.homeDeadline = null;
    this.release();
    this.apply(this.follower.handBack(this.clock.wallMs()));
  }

  private apply(out: HostOut): void {
    if (out.target) {
      this.lastTarget = out.target as Joints;
      this.scene.setTargets(this.lastTarget);
    }
    for (const msg of out.outbound) this.post({ t: "send", msg });
    for (const event of out.events) this.post({ t: "event", event });
    for (const rpc of out.rpc) this.answer(rpc);
  }

  /** The core only passes on RPCs from the lease holder (or the open methods), so no check here. */
  private answer({ id, from, method, payload }: RpcRequest): void {
    let ok = true;
    let result: unknown;
    try {
      result = this.runRpc(method, payload);
    } catch (e) {
      ok = false;
      // A failure must be a string: an Error object would cross as "{}".
      result = errorText(e);
    }
    this.apply(this.follower.answerRpc(id, from, ok, result));
  }

  private runRpc(method: string, payload: unknown): unknown {
    switch (method) {
      case "observe_scene":
        return this.scene.observeScene();
      case "reset_scene": {
        const seed = (payload as { seed?: unknown } | null)?.seed ?? Math.floor(Math.random() * 2 ** 32);
        if (typeof seed !== "number" || !Number.isFinite(seed)) throw new Error("seed must be a finite number");
        // Never clears an e-stop (that is the visitor's Reset), and never teleports a driven arm.
        const state = this.follower.status().safeState;
        if (state === "active") throw new Error("release the deadman first");
        if (state !== "holding") throw new Error(state);
        this.relayout(seed);
        return { ok: true };
      }
      case "task_status":
        return { inBox: this.scene.cubesInBox() };
      case "home":
        this.home();
        return { ok: true };
      default:
        throw new Error("unknown method");
    }
  }

  private postStatus(): void {
    this.lastStatusMono = this.clock.monoS();
    const status = this.follower.status();
    if (status.safeState === "active") this.hidden = false;
    const scene = this.scene.observeScene();
    this.post({
      t: "status",
      status: {
        ...status,
        cubesInBox: scene.cubes.filter((c) => c.inBox).map((c) => c.color),
        joints: this.scene.joints(),
        hidden: this.hidden,
        gripperPos: scene.gripper.pos,
      },
    });
  }

  /** Dropped input is a log entry, not an error: the loop carries on. */
  private invalid(why: string): void {
    this.post({ t: "event", event: { type: "invalid_input", why } });
  }

  /** An interval that stops itself, and reports, if its body throws. */
  private every(ms: number, body: () => void): ReturnType<typeof setInterval> {
    const id = setInterval(() => {
      try {
        body();
      } catch (e) {
        clearInterval(id);
        this.post({ t: "error", message: errorText(e) });
      }
    }, ms);
    return id;
  }
}
