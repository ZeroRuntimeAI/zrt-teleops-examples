import type { DoubleBuffer, MjData } from "@mujoco/mujoco";
import { clip, fromQpos, JOINTS, LIMITS, toCtrl, type JointName, type Joints } from "./jointMap";
import type { Scene } from "./scene";

export type Vec3 = [number, number, number];

export type IkOptions = {
  /** Iteration cap (default 100). */
  iters?: number;
  /** Stop once the gripper site is this close to the target, in metres (default 2 mm). */
  tolM?: number;
};

/** Damping of the least-squares step, lambda. */
const DAMPING = 0.05;
const DEFAULT_ITERS = 100;
const DEFAULT_TOL_M = 0.002;
/**
 * No single step chases more than this per axis. It keeps the linearisation honest far from the
 * target, and the arithmetic finite for an absurd but finite one (1e308 would overflow into NaN).
 */
const MAX_STEP_M = 0.25;
/**
 * The joints IK moves. A 3-DoF position target needs no more, and `wrist_roll` and `gripper` keep
 * their seed values (the user owns those two).
 */
const SOLVED = ["shoulder_pan", "shoulder_lift", "elbow_flex", "wrist_flex"] as const satisfies readonly JointName[];

const bounds = (end: 0 | 1) => toCtrl(Object.fromEntries(JOINTS.map((n) => [n, LIMITS[n][end]])) as Joints);
/** LIMITS in actuator radians, the units of the scratch qpos. */
const LOWER = bounds(0);
const UPPER = bounds(1);

type Scratch = {
  data: MjData;
  site: number;
  /** qpos address per joint. */
  qadr: Record<JointName, number>;
  /** dof address (a column of the Jacobian) of each SOLVED joint. */
  dadr: number[];
  /** Out parameter of `mj_jacSite`: 3 x nv, row-major. A plain typed array is copied in and not written back. */
  jacp: DoubleBuffer;
};

/**
 * One scratch `MjData` (and Jacobian buffer) per scene, kept for the scene's lifetime and never
 * deleted. IK works here, so it never touches `scene.data`. The pose it holds between calls is
 * meaningless; every call starts by writing the whole arm.
 */
const scratches = new WeakMap<Scene, Scratch>();

function scratchFor(scene: Scene): Scratch {
  const cached = scratches.get(scene);
  if (cached) return cached;
  const { mj, model } = scene;
  const id = (type: { value: number }, name: string) => {
    const found = mj.mj_name2id(model, type.value, name);
    if (found < 0) throw new Error(`scene.xml does not define "${name}"`);
    return found;
  };
  // Allocate first: WASM memory growth detaches typed-array views, so read the model arrays after.
  const data = new mj.MjData(model);
  const jacp = new mj.DoubleBuffer(3 * model.nv);
  const joint = Object.fromEntries(JOINTS.map((n) => [n, id(mj.mjtObj.mjOBJ_JOINT, n)])) as Record<JointName, number>;
  const qposAdr = model.jnt_qposadr as Int32Array;
  const dofAdr = model.jnt_dofadr as Int32Array;
  const made: Scratch = {
    data,
    site: id(mj.mjtObj.mjOBJ_SITE, "gripperframe"),
    qadr: Object.fromEntries(JOINTS.map((n) => [n, qposAdr[joint[n]]])) as Record<JointName, number>,
    dadr: SOLVED.map((n) => dofAdr[joint[n]]),
    jacp,
  };
  scratches.set(scene, made);
  return made;
}

/** Positions only: the Jacobian needs `xpos`, `site_xpos` and `subtree_com`, nothing from dynamics. */
function kinematics(scene: Scene, s: Scratch): void {
  scene.mj.mj_kinematics(scene.model, s.data);
  scene.mj.mj_comPos(scene.model, s.data);
}

function sitePos(s: Scratch): Vec3 {
  const xpos = s.data.site_xpos as Float64Array;
  return [xpos[3 * s.site], xpos[3 * s.site + 1], xpos[3 * s.site + 2]];
}

/** Write all six joints (lerobot units) into the scratch qpos, and run kinematics. */
function pose(scene: Scene, s: Scratch, joints: Joints): void {
  const qpos = s.data.qpos as Float64Array;
  const radians = toCtrl(joints);
  for (const name of JOINTS) qpos[s.qadr[name]] = radians[name];
  kinematics(scene, s);
}

/** World position of the `gripperframe` site for these joints, on the scratch data (the live sim is untouched). */
export function forwardKinematics(scene: Scene, joints: Joints): Vec3 {
  const s = scratchFor(scene);
  pose(scene, s, joints);
  return sitePos(s);
}

/** Solve the symmetric 3x3 system `a y = e` (row-major) with the adjugate. `a` is positive definite. */
function solve3(a: readonly number[], e: readonly number[]): Vec3 {
  const [a0, a1, a2, a3, a4, a5, a6, a7, a8] = a;
  const c0 = a4 * a8 - a5 * a7;
  const c1 = a5 * a6 - a3 * a8;
  const c2 = a3 * a7 - a4 * a6;
  const det = a0 * c0 + a1 * c1 + a2 * c2;
  return [
    (c0 * e[0] + (a2 * a7 - a1 * a8) * e[1] + (a1 * a5 - a2 * a4) * e[2]) / det,
    (c1 * e[0] + (a0 * a8 - a2 * a6) * e[1] + (a2 * a3 - a0 * a5) * e[2]) / det,
    (c2 * e[0] + (a1 * a6 - a0 * a7) * e[1] + (a0 * a4 - a1 * a3) * e[2]) / det,
  ];
}

/**
 * Damped-least-squares IK on the `gripperframe` site: move the arm from `seed` so the site reaches
 * `target` (world frame, metres), by `dq = Jt (J Jt + lambda^2 I)^-1 e` with lambda = 0.05, up to
 * `opts.iters` (100) iterations, stopping once the error is below `opts.tolM` (2 mm).
 *
 * Only the first four joints move and each stays inside `LIMITS`; `wrist_roll` and `gripper` come
 * back as the seed had them. The solve runs on a private scratch `MjData`, so the live sim is
 * untouched. If the target is out of reach the result is the closest the iteration got, and
 * `errorM` says how far off it is.
 *
 * A non-finite target or seed joint is rejected: the seed comes back unchanged with
 * `errorM = Infinity`, so a NaN cannot be introduced into a setpoint.
 */
export function solveIk(
  scene: Scene,
  target: Vec3,
  seed: Joints,
  { iters = DEFAULT_ITERS, tolM = DEFAULT_TOL_M }: IkOptions = {},
): { joints: Joints; errorM: number } {
  if (!target.every(Number.isFinite) || !JOINTS.every((n) => Number.isFinite(seed[n]))) {
    return { joints: { ...seed }, errorM: Number.POSITIVE_INFINITY };
  }
  const s = scratchFor(scene);
  const nv = scene.model.nv;
  pose(scene, s, seed);

  let stepped = false;
  let errorM: number;
  for (let i = 0; ; i += 1) {
    const site = sitePos(s);
    const e = [target[0] - site[0], target[1] - site[1], target[2] - site[2]];
    errorM = Math.hypot(e[0], e[1], e[2]);
    if (errorM < tolM || i >= iters) break;

    scene.mj.mj_jacSite(scene.model, s.data, s.jacp, null, s.site);
    const jacp = s.jacp.GetView() as Float64Array;
    const jac = s.dadr.map((col) => [0, 1, 2].map((row) => jacp[row * nv + col]));
    const a = [0, 1, 2].flatMap((r) =>
      [0, 1, 2].map((c) => jac.reduce((sum, column) => sum + column[r] * column[c], 0) + (r === c ? DAMPING ** 2 : 0)),
    );
    const shrink = Math.min(1, MAX_STEP_M / Math.max(Math.abs(e[0]), Math.abs(e[1]), Math.abs(e[2])));
    const y = solve3(a, e.map((v) => v * shrink));
    const qpos = s.data.qpos as Float64Array;
    SOLVED.forEach((name, k) => {
      const dq = jac[k][0] * y[0] + jac[k][1] * y[1] + jac[k][2] * y[2];
      qpos[s.qadr[name]] = clip(qpos[s.qadr[name]] + dq, [LOWER[name], UPPER[name]]);
    });
    kinematics(scene, s);
    stepped = true;
  }

  // Without a step the seed's own numbers are the answer; a radian round trip would only add rounding.
  const qpos = s.data.qpos as Float64Array;
  const solved = stepped ? fromQpos(Object.fromEntries(JOINTS.map((n) => [n, qpos[s.qadr[n]]])) as Joints) : seed;
  const joints = { ...seed };
  for (const name of SOLVED) joints[name] = clip(solved[name], LIMITS[name]);
  return { joints, errorM };
}
