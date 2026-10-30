import type { MainModule, MjData, MjModel } from "@mujoco/mujoco";
import { fromQpos, HOME, JOINTS, toCtrl, type JointName, type Joints } from "./jointMap";
import { mulberry32 } from "./rng";

export type CubeColor = "red" | "green" | "blue" | "yellow";
type Vec3 = [number, number, number];
type Quat = [number, number, number, number];

export type SceneObservation = {
  /** `quat` is MuJoCo's order: w, x, y, z. */
  cubes: { color: CubeColor; pos: Vec3; quat: Quat; inBox: boolean }[];
  box: { pos: Vec3; innerHalf: 0.045 };
  gripper: { pos: Vec3 };
};

/** One 30 fps control step is 7 substeps; a call may cover 0.2 s at most (42 substeps). */
const MAX_SUBSTEPS = 42;
/** A cube is in the box when its center is inside this footprint (box frame) and below 6 cm. */
const BOX_INNER_HALF = 0.045;
const IN_BOX_MAX_HEIGHT = 0.06;
const MAX_PLACE_TRIES = 100;

const CUBES: readonly { color: CubeColor; body: string }[] = (
  ["red", "green", "blue", "yellow"] as const
).map((color) => ({ color, body: `${color}_cube` }));

/** EnvHub `DEFAULTS["randomize"]`: half-ranges around the XML pose, in placement order. */
const JOINT_NOISE_DEG = 2.0;
const CUBE_NOISE = { pos: [0.06, 0.14, 0], yaw: 3.1416 } as const;
const BODY_NOISE: readonly { body: string; pos: Vec3; yaw: number }[] = [
  { body: "box", pos: [0.03, 0.015, 0], yaw: 0 },
  ...CUBES.map(({ body }) => ({ body, pos: [...CUBE_NOISE.pos] as Vec3, yaw: CUBE_NOISE.yaw })),
];
const FRONT_CAMERA = { name: "front", pos: [0.01, 0.01, 0.01] as Vec3 };

type BodyNoise = {
  body: number;
  /** qpos address of the freejoint, or null for a static body. */
  qadr: number | null;
  pos: Vec3;
  yaw: number;
  /** Radius of the body's footprint on the table. */
  footprint: number;
};

const vec3 = (a: Float64Array, i: number): Vec3 => [a[3 * i], a[3 * i + 1], a[3 * i + 2]];
const quat = (a: Float64Array, i: number): Quat => [a[4 * i], a[4 * i + 1], a[4 * i + 2], a[4 * i + 3]];

const mulQuat = (a: Quat, b: Quat): Quat => [
  a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
  a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
  a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
  a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
];

export class Scene {
  private readonly qadr: Record<JointName, number>;
  private readonly actuator: Record<JointName, number>;
  private readonly cubeBodies: number[];
  private readonly boxBody: number;
  private readonly gripperSite: number;
  private readonly frontCamera: number;
  private readonly bodies: BodyNoise[];
  private readonly bodyPos0: Float64Array;
  private readonly bodyQuat0: Float64Array;
  private readonly camPos0: Float64Array;

  private constructor(
    readonly mj: MainModule,
    readonly model: MjModel,
    readonly data: MjData,
  ) {
    const id = (type: { value: number }, name: string) => {
      const found = mj.mj_name2id(model, type.value, name);
      if (found < 0) throw new Error(`scene.xml does not define "${name}"`);
      return found;
    };
    const { mjOBJ_JOINT, mjOBJ_ACTUATOR, mjOBJ_BODY, mjOBJ_SITE, mjOBJ_CAMERA } = mj.mjtObj;
    const jointIndex = (name: JointName) => id(mjOBJ_JOINT, name);
    this.qadr = this.byJoint((name) => (model.jnt_qposadr as Int32Array)[jointIndex(name)]);
    this.actuator = this.byJoint((name) => id(mjOBJ_ACTUATOR, name));
    this.cubeBodies = CUBES.map(({ body }) => id(mjOBJ_BODY, body));
    this.boxBody = id(mjOBJ_BODY, "box");
    this.gripperSite = id(mjOBJ_SITE, "gripperframe");
    this.frontCamera = id(mjOBJ_CAMERA, FRONT_CAMERA.name);
    this.bodies = BODY_NOISE.map((n) => this.bodyNoise(id(mjOBJ_BODY, n.body), n.pos, n.yaw));
    this.bodyPos0 = Float64Array.from(model.body_pos as Float64Array);
    this.bodyQuat0 = Float64Array.from(model.body_quat as Float64Array);
    this.camPos0 = Float64Array.from(model.cam_pos as Float64Array);
  }

  /** Compile `scene.xml` from in-memory files, keyed by path relative to it (`assets/x.stl`, ...). */
  static load(mj: MainModule, files: Record<string, Uint8Array>): Scene {
    const vfs = new mj.MjVFS();
    try {
      for (const [path, bytes] of Object.entries(files)) vfs.addBuffer(path, bytes);
      const model = mj.MjModel.from_xml_path("scene.xml", vfs);
      const scene = new Scene(mj, model, new mj.MjData(model));
      scene.reset(0);
      return scene;
    } finally {
      vfs.delete();
    }
  }

  /**
   * Port of EnvHub `reset`: restore the XML state, then apply seeded offsets to the joints, the
   * box, the cubes (placed without overlapping by footprint) and the front camera.
   */
  reset(seed: number): void {
    const { mj, model, data } = this;
    const rng = mulberry32(seed);
    const uniform = (half: number) => -half + 2 * half * rng();
    (model.body_pos as Float64Array).set(this.bodyPos0);
    (model.body_quat as Float64Array).set(this.bodyQuat0);
    (model.cam_pos as Float64Array).set(this.camPos0);
    mj.mj_resetData(model, data);

    const noisy = this.byJoint((name) => HOME[name] + uniform(JOINT_NOISE_DEG));
    this.writeJoints(toCtrl(noisy), true);

    const placed: { xy: [number, number]; radius: number }[] = [];
    for (const noise of this.bodies) {
      let xy: [number, number] | null = null;
      for (let attempt = 0; attempt < MAX_PLACE_TRIES && xy === null; attempt += 1) {
        this.place(noise, uniform);
        const candidate = this.xy(noise);
        const clear = placed.every(
          (p) => Math.hypot(candidate[0] - p.xy[0], candidate[1] - p.xy[1]) > noise.footprint + p.radius,
        );
        if (clear) xy = candidate;
      }
      if (xy === null) {
        const name = mj.mj_id2name(model, mj.mjtObj.mjOBJ_BODY.value, noise.body);
        throw new Error(`could not place ${name} without overlap`);
      }
      placed.push({ xy, radius: noise.footprint });
    }

    const camPos = model.cam_pos as Float64Array;
    FRONT_CAMERA.pos.forEach((half, axis) => {
      camPos[3 * this.frontCamera + axis] = this.camPos0[3 * this.frontCamera + axis] + uniform(half);
    });
    mj.mj_forward(model, data);
  }

  /** Hold these joint targets (lerobot units) until the next call. */
  setTargets(j: Joints): void {
    this.writeJoints(toCtrl(j), false);
  }

  /** Advance the physics by `dtS`: whole substeps, at most 42 (0.2 s) per call. */
  step(dtS: number): void {
    const n = Math.min(MAX_SUBSTEPS, Math.round(dtS / this.model.opt.timestep));
    for (let i = 0; i < n; i += 1) this.mj.mj_step(this.model, this.data);
    this.mj.mj_forward(this.model, this.data);
  }

  joints(): Joints {
    const qpos = this.data.qpos as Float64Array;
    return fromQpos(this.byJoint((name) => qpos[this.qadr[name]]));
  }

  cubesInBox(): CubeColor[] {
    return CUBES.filter((_, i) => this.cubeInBox(this.cubeBodies[i])).map(({ color }) => color);
  }

  observeScene(): SceneObservation {
    return {
      cubes: CUBES.map(({ color }, i) => ({
        color,
        pos: this.bodyPos(this.cubeBodies[i]),
        quat: this.bodyQuat(this.cubeBodies[i]),
        inBox: this.cubeInBox(this.cubeBodies[i]),
      })),
      box: { pos: this.bodyPos(this.boxBody), innerHalf: BOX_INNER_HALF },
      gripper: { pos: vec3(this.data.site_xpos as Float64Array, this.gripperSite) },
    };
  }

  /** World pose of every body in model body order: 7 numbers each, `x y z qw qx qy qz`. */
  bodyPoses(): Float64Array {
    const xpos = this.data.xpos as Float64Array;
    const xquat = this.data.xquat as Float64Array;
    const poses = new Float64Array(7 * this.model.nbody);
    for (let b = 0; b < this.model.nbody; b += 1) {
      poses.set(xpos.subarray(3 * b, 3 * b + 3), 7 * b);
      poses.set(xquat.subarray(4 * b, 4 * b + 4), 7 * b + 3);
    }
    return poses;
  }

  private byJoint<T>(f: (name: JointName) => T): Record<JointName, T> {
    return Object.fromEntries(JOINTS.map((name) => [name, f(name)])) as Record<JointName, T>;
  }

  /** Write actuator-unit joint values to ctrl, and to qpos too when `teleport` is set. */
  private writeJoints(ctrl: Joints, teleport: boolean): void {
    const qpos = this.data.qpos as Float64Array;
    const dataCtrl = this.data.ctrl as Float64Array;
    for (const name of JOINTS) {
      dataCtrl[this.actuator[name]] = ctrl[name];
      if (teleport) qpos[this.qadr[name]] = ctrl[name];
    }
  }

  private bodyPos(body: number): Vec3 {
    return vec3(this.data.xpos as Float64Array, body);
  }

  private bodyQuat(body: number): Quat {
    return quat(this.data.xquat as Float64Array, body);
  }

  /** The cube center in the box frame is inside the inner footprint and below 6 cm. */
  private cubeInBox(cube: number): boolean {
    const xmat = this.data.xmat as Float64Array;
    const [bx, by, bz] = this.bodyPos(this.boxBody);
    const [cx, cy, cz] = this.bodyPos(cube);
    const d = [cx - bx, cy - by, cz - bz];
    // local = R^T d, with R the box body's rotation matrix (row-major).
    const m = 9 * this.boxBody;
    const local = [0, 1, 2].map((k) => xmat[m + k] * d[0] + xmat[m + 3 + k] * d[1] + xmat[m + 6 + k] * d[2]);
    const inFootprint = Math.abs(local[0]) < BOX_INNER_HALF && Math.abs(local[1]) < BOX_INNER_HALF;
    return inFootprint && local[2] < IN_BOX_MAX_HEIGHT;
  }

  private bodyNoise(body: number, pos: Vec3, yaw: number): BodyNoise {
    const { model } = this;
    const jnt = (model.body_jntadr as Int32Array)[body];
    const jntnum = (model.body_jntnum as Int32Array)[body];
    const free = jntnum === 1 && (model.jnt_type as Int32Array)[jnt] === this.mj.mjtJoint.mjJNT_FREE.value;
    if (!free && (jntnum !== 0 || (model.body_parentid as Int32Array)[body] !== 0)) {
      throw new Error("randomized bodies need a freejoint or must be static children of the world");
    }
    const qadr = free ? (model.jnt_qposadr as Int32Array)[jnt] : null;
    return { body, qadr, pos, yaw, footprint: this.footprint(body) };
  }

  /** Radius of the body's footprint on the table, from its geoms' bounding boxes. */
  private footprint(body: number): number {
    const { model } = this;
    const bodyId = model.geom_bodyid as Int32Array;
    const aabb = model.geom_aabb as Float64Array;
    const geomPos = model.geom_pos as Float64Array;
    let radius = 0;
    for (let g = 0; g < model.ngeom; g += 1) {
      if (bodyId[g] !== body) continue;
      const cornerX = Math.abs(geomPos[3 * g] + aabb[6 * g]) + aabb[6 * g + 3];
      const cornerY = Math.abs(geomPos[3 * g + 1] + aabb[6 * g + 1]) + aabb[6 * g + 4];
      radius = Math.max(radius, Math.hypot(cornerX, cornerY));
    }
    return radius;
  }

  private xy(noise: BodyNoise): [number, number] {
    if (noise.qadr !== null) {
      const qpos = this.data.qpos as Float64Array;
      return [qpos[noise.qadr], qpos[noise.qadr + 1]];
    }
    const bodyPos = this.model.body_pos as Float64Array;
    return [bodyPos[3 * noise.body], bodyPos[3 * noise.body + 1]];
  }

  /** Offset a body from its XML pose by a seeded position and yaw (EnvHub `_place`). */
  private place(noise: BodyNoise, uniform: (half: number) => number): void {
    const offset = noise.pos.map(uniform);
    const yaw = uniform(noise.yaw);
    const turn: Quat = [Math.cos(yaw / 2), 0, 0, Math.sin(yaw / 2)];
    if (noise.qadr !== null) {
      const qpos = this.data.qpos as Float64Array;
      const qpos0 = this.model.qpos0 as Float64Array;
      const a = noise.qadr;
      offset.forEach((o, k) => {
        qpos[a + k] = qpos0[a + k] + o;
      });
      qpos.set(mulQuat(turn, quat(qpos0.subarray(a + 3), 0)), a + 3);
      return;
    }
    const bodyPos = this.model.body_pos as Float64Array;
    const bodyQuat = this.model.body_quat as Float64Array;
    const b = noise.body;
    offset.forEach((o, k) => {
      bodyPos[3 * b + k] = this.bodyPos0[3 * b + k] + o;
    });
    bodyQuat.set(mulQuat(turn, quat(this.bodyQuat0, b)), 4 * b);
  }
}
