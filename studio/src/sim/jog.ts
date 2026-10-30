import { forwardKinematics, solveIk } from "./ik";
import { clip, JOINTS, LIMITS, type Joints } from "./jointMap";
import type { Scene } from "./scene";

export type JogInput = { x: -1 | 0 | 1; y: -1 | 0 | 1; z: -1 | 0 | 1; roll: -1 | 0 | 1; grip: -1 | 0 | 1 };

/** Gripper site speed per active axis, in the world frame (m/s). */
const LINEAR_SPEED = 0.1;
/** wrist_roll speed (deg/s) and gripper speed (percent/s, +1 opens toward 100). */
const ROLL_SPEED = 90;
const GRIP_SPEED = 100;
/**
 * A 10 ms tick moves the site 1 mm, inside IK's default 2 mm tolerance, which would never move.
 * Solve to 0.01 mm instead, so the tick's motion is not rounded away.
 */
const JOG_TOL_M = 1e-5;

/**
 * Held keys, by `KeyboardEvent.code`: the physical key, so the WASD cluster survives other layouts,
 * Shift and Caps Lock. Space is reserved for Stop and deliberately absent.
 */
export const KEYMAP: Record<string, Partial<JogInput>> = {
  KeyW: { x: 1 },
  KeyS: { x: -1 },
  KeyA: { y: 1 },
  KeyD: { y: -1 },
  KeyR: { z: 1 },
  KeyF: { z: -1 },
  KeyQ: { roll: -1 },
  KeyE: { roll: 1 },
  KeyX: { grip: 1 },
  KeyZ: { grip: -1 },
};

/**
 * One jog tick: the joint setpoint after holding `jog` for `dtS` seconds from `current`.
 *
 * The gripper site moves 0.10 m/s per active axis in the world frame (IK from the site position
 * `current` has on the scratch data, not the live sim), `wrist_roll` 90 deg/s and the gripper
 * 100 %/s, all clamped to `LIMITS`. Out of reach, the arm goes as near as it can.
 *
 * Non-finite joints, inputs or a negative `dtS` return `current` unchanged.
 */
export function applyJog(scene: Scene, current: Joints, jog: JogInput, dtS: number): Joints {
  const inputs = [jog.x, jog.y, jog.z, jog.roll, jog.grip, dtS];
  if (!inputs.every(Number.isFinite) || dtS < 0 || !JOINTS.every((n) => Number.isFinite(current[n]))) {
    return { ...current };
  }
  const [x, y, z] = forwardKinematics(scene, current);
  const reach = LINEAR_SPEED * dtS;
  // The site sits off the roll axis, so IK starts from the rolled wrist and holds the site's target.
  const seed: Joints = {
    ...current,
    wrist_roll: clip(current.wrist_roll + jog.roll * ROLL_SPEED * dtS, LIMITS.wrist_roll),
    gripper: clip(current.gripper + jog.grip * GRIP_SPEED * dtS, LIMITS.gripper),
  };
  return solveIk(scene, [x + jog.x * reach, y + jog.y * reach, z + jog.z * reach], seed, { tolM: JOG_TOL_M }).joints;
}
