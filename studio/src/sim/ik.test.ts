import type { MainModule, MjData } from "@mujoco/mujoco";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { solveIk } from "./ik";
import { HOME, JOINTS, LIMITS, toCtrl, type Joints } from "./jointMap";
import { loadTestScene } from "./loadTestScene";
import type { Scene } from "./scene";

const TARGETS: [number, number, number][] = [
  [0.22, 0, 0.1],
  [0.25, 0.1, 0.06],
  [0.18, -0.08, 0.12],
];

let mj: MainModule;
let scene: Scene;
let probe: MjData;

/** Independent FK: its own MjData, qpos set straight from the joints, `gripperframe` read back. */
function siteAt(joints: Joints): [number, number, number] {
  const { model } = scene;
  const qpos = probe.qpos as Float64Array;
  const radians = toCtrl(joints);
  for (const name of JOINTS) {
    const jnt = mj.mj_name2id(model, mj.mjtObj.mjOBJ_JOINT.value, name);
    qpos[(model.jnt_qposadr as Int32Array)[jnt]] = radians[name];
  }
  mj.mj_forward(model, probe);
  const site = mj.mj_name2id(model, mj.mjtObj.mjOBJ_SITE.value, "gripperframe");
  const xpos = probe.site_xpos as Float64Array;
  return [xpos[3 * site], xpos[3 * site + 1], xpos[3 * site + 2]];
}

const distance = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

beforeAll(async () => {
  ({ mj, scene } = await loadTestScene());
  probe = new mj.MjData(scene.model);
});

afterAll(() => probe.delete());

describe("solveIk", () => {
  it.each(TARGETS)("reaches [%f, %f, %f] from HOME within 5 mm", (...target) => {
    const { joints, errorM } = solveIk(scene, target, HOME);
    expect(errorM).toBeLessThan(0.005);
    expect(distance(siteAt(joints), target)).toBeLessThan(0.005);
  });

  it("leaves the live sim untouched", () => {
    scene.reset(4);
    const joints = scene.joints();
    const qpos = (scene.data.qpos as Float64Array).slice();
    const site = (scene.data.site_xpos as Float64Array).slice();
    solveIk(scene, TARGETS[1], HOME);
    expect(scene.joints()).toEqual(joints);
    expect(scene.data.qpos).toEqual(qpos);
    expect(scene.data.site_xpos).toEqual(site);
  });

  it("keeps the seed's wrist_roll and gripper", () => {
    const seed = { ...HOME, wrist_roll: 40, gripper: 77 };
    const { joints } = solveIk(scene, TARGETS[0], seed);
    expect(joints.wrist_roll).toBe(40);
    expect(joints.gripper).toBe(77);
  });

  it("stays inside LIMITS for a target out of reach", () => {
    const target: [number, number, number] = [2, 0, 1];
    const { joints, errorM } = solveIk(scene, target, HOME);
    expect(errorM).toBeGreaterThan(0.5);
    // errorM is the error of the joints returned, not of an unclamped solution.
    expect(distance(siteAt(joints), target)).toBeCloseTo(errorM, 6);
    for (const name of JOINTS) {
      expect(joints[name], name).toBeGreaterThanOrEqual(LIMITS[name][0]);
      expect(joints[name], name).toBeLessThanOrEqual(LIMITS[name][1]);
    }
  });

  it("never produces NaN for an absurdly large finite target", () => {
    for (const far of [1e6, 1e300, 1.7e308]) {
      const { joints } = solveIk(scene, [far, -far, far], HOME);
      for (const name of JOINTS) expect(Number.isFinite(joints[name]), `${far} ${name}`).toBe(true);
    }
  });

  it("returns the seed unchanged with an infinite error for non-finite input", () => {
    const bad: [number, number, number][] = [
      [Number.NaN, 0, 0.1],
      [0.2, Number.POSITIVE_INFINITY, 0.1],
    ];
    for (const target of bad) {
      expect(solveIk(scene, target, HOME)).toEqual({ joints: HOME, errorM: Number.POSITIVE_INFINITY });
    }
    const seed = { ...HOME, shoulder_pan: Number.NaN };
    const result = solveIk(scene, TARGETS[0], seed);
    expect(result.errorM).toBe(Number.POSITIVE_INFINITY);
    expect(result.joints.shoulder_pan).toBeNaN();
  });

  it("stops early at the tolerance and honours iters", () => {
    const start = siteAt(HOME);
    const target: [number, number, number] = [start[0] + 0.001, start[1], start[2]];
    expect(solveIk(scene, target, HOME).joints).toEqual(HOME);
    expect(solveIk(scene, target, HOME, { tolM: 1e-6 }).errorM).toBeLessThan(1e-6);
    const one = solveIk(scene, TARGETS[1], HOME, { iters: 1 });
    expect(one.errorM).toBeGreaterThan(solveIk(scene, TARGETS[1], HOME).errorM);
  });
});
