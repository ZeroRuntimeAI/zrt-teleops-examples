/**
 * Messages between the main thread and the robot worker (`worker.ts`).
 *
 * Joint values are lerobot units throughout: body joints in degrees, the gripper 0-100.
 */
import type { HostStatus, Msg } from "@zeroruntime/teleops-wasm";
import type { Joints } from "../sim/jointMap";
import type { JogInput } from "../sim/jog";
import type { CubeColor } from "../sim/scene";

/**
 * One thing for the main thread to put on the room, in order:
 * `{kind:"data", reliable, bytes}` on a data lane, or `{kind:"pubsub", topic, message, sendOnly?, persist}`.
 */
export type OutboundMsg = Msg;

export type ToWorker =
  /** Boot: `files` are `public/sim` keyed by path relative to `scene.xml`; `seed` lays out the scene. */
  | { t: "init"; files: Record<string, Uint8Array>; selfId: string; seed: number }
  | { t: "data"; from: string; bytes: Uint8Array }
  | { t: "pubsub"; topic: string; from: string; message: string }
  | { t: "left"; id: string }
  | { t: "connection"; connected: boolean; why: string }
  /**
   * The held jog keys, sent on every change. A zero jog releases the deadman, so send one on
   * blur and when the tab is hidden too: a worker that keeps running would otherwise keep driving.
   */
  | { t: "jog"; jog: JogInput }
  /** Developer-drawer sliders: `held` while dragging, false on release. Same control rules as a jog. */
  | { t: "setJoints"; joints: Partial<Joints>; held: boolean }
  | { t: "stop" }
  | { t: "reset"; seed: number }
  | { t: "handBack" }
  /** Camera `label -> producer id`, announced from the next DESC on. */
  | { t: "producers"; map: Record<string, string> };

export type FromWorker =
  /** The scene is loaded and the follower has started; messages sent before this are queued. */
  | { t: "ready" }
  /** Boot download progress of a `.wasm` module, in bytes; `total` is 0 when the server didn't say. */
  | { t: "progress"; module: WasmModule; loaded: number; total: number }
  | { t: "send"; msg: OutboundMsg }
  /**
   * World pose of every body in model body order, at most every 16 ms: 7 numbers per body,
   * `x y z qw qx qy qz` (MuJoCo's quaternion order; three.js wants x y z w). Transferred, not copied.
   */
  | {
      t: "poses";
      poses: Float64Array;
      /** The measured joints, in `JOINTS` order and lerobot units: what the servo sound follows. Transferred too. */
      joints: Float64Array;
    }
  /** At 5 Hz, and at once after a stop or reset. */
  | { t: "status"; status: RobotStatus }
  /**
   * A log entry: a `rec` event (`{op:"ev", kind, ...}`) or a note (`{type, ...}`), including
   * `{type:"invalid_input", why}` for a dropped message.
   */
  | { t: "event"; event: object }
  /** Boot failed, or a timer's body threw and that timer stopped. */
  | { t: "error"; message: string };

export type WasmModule = "physics" | "core";

export type RobotStatus = HostStatus & {
  cubesInBox: CubeColor[];
  /** Measured, from the sim. */
  joints: Joints;
  /**
   * The loop was suspended past the watchdog (a hidden or frozen tab): the arm is holding and the
   * held keys were dropped. Clears on the next press.
   */
  hidden: boolean;
  /** World position of the `gripperframe` site, in metres. */
  gripperPos: [number, number, number];
};
