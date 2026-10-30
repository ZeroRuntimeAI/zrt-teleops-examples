import { beforeAll, describe, expect, it } from "vitest";
import { forwardKinematics } from "./ik";
import { HOME, JOINTS, LIMITS, type Joints } from "./jointMap";
import { applyJog, KEYMAP, type JogInput } from "./jog";
import { loadTestScene } from "./loadTestScene";
import type { Scene } from "./scene";

const IDLE: JogInput = { x: 0, y: 0, z: 0, roll: 0, grip: 0 };
const DT = 0.01;

let scene: Scene;

beforeAll(async () => {
  ({ scene } = await loadTestScene());
});

/** Hold one jog input for `seconds` in 10 ms ticks, as the robot worker does. */
function hold(start: Joints, jog: JogInput, seconds: number): Joints {
  let joints = start;
  for (let t = 0; t < Math.round(seconds / DT); t += 1) joints = applyJog(scene, joints, jog, DT);
  return joints;
}

describe("applyJog", () => {
  it("moves the gripper site +x by 0.10 m in 1 s and keeps y and z", () => {
    const before = forwardKinematics(scene, HOME);
    const after = forwardKinematics(scene, hold(HOME, { ...IDLE, x: 1 }, 1));
    expect(after[0] - before[0]).toBeGreaterThan(0.09);
    expect(after[0] - before[0]).toBeLessThan(0.11);
    expect(Math.abs(after[1] - before[1])).toBeLessThan(0.002);
    expect(Math.abs(after[2] - before[2])).toBeLessThan(0.002);
  });

  it.each([
    ["y", { ...IDLE, y: 1 }, 1, 1],
    ["y", { ...IDLE, y: -1 }, 1, -1],
    ["z", { ...IDLE, z: 1 }, 2, 1],
    ["z", { ...IDLE, z: -1 }, 2, -1],
    ["x", { ...IDLE, x: -1 }, 0, -1],
  ] as const)("moves the site along %s at 0.10 m/s (%j)", (_axis, jog, index, sign) => {
    const before = forwardKinematics(scene, HOME);
    const after = forwardKinematics(scene, hold(HOME, jog, 0.5));
    expect((after[index] - before[index]) * sign).toBeGreaterThan(0.045);
    expect((after[index] - before[index]) * sign).toBeLessThan(0.055);
  });

  it("opens the gripper from 30 to 100 in 1 s and stays there", () => {
    const open = hold(HOME, { ...IDLE, grip: 1 }, 1);
    expect(open.gripper).toBeCloseTo(100, 6);
    expect(hold(open, { ...IDLE, grip: 1 }, 0.5).gripper).toBe(100);
    expect(hold(open, { ...IDLE, grip: -1 }, 0.5).gripper).toBeCloseTo(50, 6);
  });

  it("rolls the wrist at 90 deg/s and clamps to LIMITS", () => {
    expect(hold(HOME, { ...IDLE, roll: 1 }, 0.5).wrist_roll).toBeCloseTo(45, 6);
    expect(hold(HOME, { ...IDLE, roll: -1 }, 0.5).wrist_roll).toBeCloseTo(-45, 6);
    expect(hold(HOME, { ...IDLE, roll: 1 }, 5).wrist_roll).toBe(LIMITS.wrist_roll[1]);
  });

  it("holds still with no input", () => {
    expect(applyJog(scene, HOME, IDLE, DT)).toEqual(HOME);
  });

  it("stays inside LIMITS when pushed out of reach", () => {
    const joints = hold(HOME, { ...IDLE, x: 1, z: 1 }, 6);
    for (const name of JOINTS) {
      expect(joints[name], name).toBeGreaterThanOrEqual(LIMITS[name][0]);
      expect(joints[name], name).toBeLessThanOrEqual(LIMITS[name][1]);
    }
  });

  it("returns the current joints for non-finite input", () => {
    expect(applyJog(scene, HOME, { ...IDLE, x: Number.NaN as 1 }, DT)).toEqual(HOME);
    expect(applyJog(scene, HOME, { ...IDLE, x: 1 }, Number.NaN)).toEqual(HOME);
    expect(applyJog(scene, HOME, { ...IDLE, x: 1 }, -DT)).toEqual(HOME);
  });

  it("does not touch the live sim", () => {
    const joints = scene.joints();
    hold(HOME, { ...IDLE, x: 1 }, 0.2);
    expect(scene.joints()).toEqual(joints);
  });
});

describe("KEYMAP", () => {
  it("maps KeyboardEvent.code values to jog axes", () => {
    expect(KEYMAP).toEqual({
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
    });
  });

  it("leaves Space for Stop", () => {
    expect(KEYMAP).not.toHaveProperty("Space");
  });
});
