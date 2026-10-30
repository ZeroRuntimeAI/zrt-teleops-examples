import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import loadMujoco, { type MainModule } from "@mujoco/mujoco";
import { beforeAll, describe, expect, it } from "vitest";
import { HOME, JOINTS, toCtrl } from "./jointMap";
import { Scene } from "./scene";

const SIM_DIR = join(import.meta.dirname, "../../public/sim");

/** Every model file under public/sim (NOTICE excluded), keyed by its posix path. */
function readSimFiles(dir = SIM_DIR): Record<string, Uint8Array> {
  const files: Record<string, Uint8Array> = {};
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      Object.assign(files, readSimFiles(path));
    } else if (entry.name !== "NOTICE") {
      files[relative(SIM_DIR, path).split(sep).join("/")] = new Uint8Array(readFileSync(path));
    }
  }
  return files;
}

let mj: MainModule;
let scene: Scene;

const bodyId = (name: string) => mj.mj_name2id(scene.model, mj.mjtObj.mjOBJ_BODY.value, name);

beforeAll(async () => {
  mj = await loadMujoco();
  scene = Scene.load(mj, readSimFiles());
});

describe("Scene", () => {
  it("loads the tabletop with four cubes", () => {
    expect(scene.observeScene().cubes).toHaveLength(4);
  });

  it("steps at 1/210 s", () => {
    expect(scene.model.opt.timestep).toBeCloseTo(1 / 210, 12);
  });

  it("clips toCtrl to the model's actuator ctrlrange", () => {
    const ctrlrange = scene.model.actuator_ctrlrange as Float64Array;
    for (const name of JOINTS) {
      const actuator = mj.mj_name2id(scene.model, mj.mjtObj.mjOBJ_ACTUATOR.value, name);
      expect(toCtrl({ ...HOME, [name]: -1e4 })[name], name).toBe(ctrlrange[2 * actuator]);
      expect(toCtrl({ ...HOME, [name]: 1e4 })[name], name).toBe(ctrlrange[2 * actuator + 1]);
    }
  });

  it("gives identical body poses for the same seed", () => {
    scene.reset(7);
    const first = scene.bodyPoses().slice();
    scene.step(0.1);
    scene.reset(7);
    expect(scene.bodyPoses()).toEqual(first);
    expect(first).toHaveLength(7 * scene.model.nbody);
  });

  it("gives different layouts for different seeds", () => {
    scene.reset(1);
    const one = scene.bodyPoses().slice();
    scene.reset(2);
    expect(scene.bodyPoses()).not.toEqual(one);
  });

  it("resets the joints to HOME within the 2 degree noise", () => {
    scene.reset(3);
    const joints = scene.joints();
    for (const name of JOINTS) {
      expect(Math.abs(joints[name] - HOME[name])).toBeLessThanOrEqual(2.0 + 1e-6);
    }
  });

  it("places the cubes apart for seeds 1..20", () => {
    for (let seed = 1; seed <= 20; seed += 1) {
      scene.reset(seed);
      const { cubes } = scene.observeScene();
      for (let i = 0; i < cubes.length; i += 1) {
        for (let j = i + 1; j < cubes.length; j += 1) {
          const [ax, ay] = cubes[i].pos;
          const [bx, by] = cubes[j].pos;
          expect(Math.hypot(ax - bx, ay - by), `seed ${seed}`).toBeGreaterThan(0.03);
        }
      }
    }
  });

  it("counts a cube dropped into the box", () => {
    scene.reset(4);
    expect(scene.cubesInBox()).not.toContain("red");
    const box = bodyId("box");
    const xpos = scene.data.xpos as Float64Array;
    const jnt = (scene.model.body_jntadr as Int32Array)[bodyId("red_cube")];
    const adr = (scene.model.jnt_qposadr as Int32Array)[jnt];
    const qpos = scene.data.qpos as Float64Array;
    qpos[adr] = xpos[3 * box];
    qpos[adr + 1] = xpos[3 * box + 1];
    qpos[adr + 2] = 0.015;
    mj.mj_forward(scene.model, scene.data);
    scene.step(0.2);
    expect(scene.cubesInBox()).toContain("red");
    expect(scene.observeScene().cubes.find((c) => c.color === "red")?.inBox).toBe(true);
  });

  it("tracks the joint targets", () => {
    scene.reset(5);
    scene.setTargets({ ...HOME, shoulder_pan: 20 });
    // step() covers at most 0.2 s per call, so ten calls make the 2 s of simulated time.
    for (let i = 0; i < 10; i += 1) scene.step(0.2);
    expect(Math.abs(scene.joints().shoulder_pan - 20)).toBeLessThan(1.0);
  });

  it("caps one step call at 42 substeps", () => {
    scene.reset(6);
    const t0 = scene.data.time;
    scene.step(2.0);
    expect(scene.data.time - t0).toBeCloseTo(42 / 210, 9);
  });
});
