/**
 * Joint units shared by the whole app: the lerobot `so101_follower` convention. Body joints are
 * degrees, the gripper is 0-100 (0 closed). The MJCF actuators take radians, with the gripper
 * mapped linearly onto its ctrlrange (as LeRobot EnvHub does).
 */

/** Alphabetical, the order of the robot descriptor. */
export const JOINTS = [
  "elbow_flex",
  "gripper",
  "shoulder_lift",
  "shoulder_pan",
  "wrist_flex",
  "wrist_roll",
] as const;

export type JointName = (typeof JOINTS)[number];
export type Joints = Record<JointName, number>;

/** Arm folded above the table, gripper half open. */
export const HOME: Joints = {
  shoulder_pan: 0,
  shoulder_lift: -60,
  elbow_flex: 60,
  wrist_flex: 35,
  wrist_roll: 0,
  gripper: 30,
};

/** The actuator ctrlrange in lerobot units. */
export const LIMITS: Record<JointName, readonly [number, number]> = {
  shoulder_pan: [-110.0, 110.0],
  shoulder_lift: [-100.0, 100.0],
  elbow_flex: [-96.83, 96.83],
  wrist_flex: [-95.0, 95.0],
  wrist_roll: [-157.21, 162.79],
  gripper: [0, 100],
};

/** The actuator ctrlrange in radians, copied from public/sim/so101.xml (scene.test.ts checks it). */
const CTRL_RANGE: Record<JointName, readonly [number, number]> = {
  shoulder_pan: [-1.91986, 1.91986],
  shoulder_lift: [-1.74533, 1.74533],
  elbow_flex: [-1.69, 1.69],
  wrist_flex: [-1.65806, 1.65806],
  wrist_roll: [-2.74385, 2.84121],
  gripper: [-0.17453, 1.74533],
};

const DEG = Math.PI / 180;

export const clip = (x: number, [lo, hi]: readonly [number, number]) => Math.min(hi, Math.max(lo, x));

const mapJoints = (f: (name: JointName) => number): Joints =>
  Object.fromEntries(JOINTS.map((name) => [name, f(name)])) as Joints;

/** Lerobot units to actuator radians, clipped to the ctrlrange. */
export function toCtrl(j: Joints): Joints {
  return mapJoints((name) => {
    const range = CTRL_RANGE[name];
    if (name !== "gripper") return clip(j[name] * DEG, range);
    const t = j.gripper / 100;
    // Written as a blend so both ends map exactly onto the ctrlrange.
    return clip(range[0] * (1 - t) + range[1] * t, range);
  });
}

/** Joint positions in radians (the gripper within its ctrlrange) back to lerobot units. */
export function fromQpos(q: Joints): Joints {
  return mapJoints((name) => {
    if (name !== "gripper") return q[name] / DEG;
    const [lo, hi] = CTRL_RANGE.gripper;
    return ((q.gripper - lo) / (hi - lo)) * 100;
  });
}
