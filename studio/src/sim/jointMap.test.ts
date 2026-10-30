import { describe, expect, it } from "vitest";
import { fromQpos, HOME, JOINTS, LIMITS, toCtrl } from "./jointMap";

describe("jointMap", () => {
  it("round-trips HOME through toCtrl and fromQpos", () => {
    const back = fromQpos(toCtrl(HOME));
    for (const name of JOINTS) {
      expect(back[name]).toBeCloseTo(HOME[name], 9);
    }
  });

  it("maps the gripper 0..100 range onto the actuator ctrlrange", () => {
    expect(toCtrl({ ...HOME, gripper: 0 }).gripper).toBe(-0.17453);
    expect(toCtrl({ ...HOME, gripper: 100 }).gripper).toBe(1.74533);
  });

  it("converts body joints from degrees to radians", () => {
    expect(toCtrl({ ...HOME, elbow_flex: 90 }).elbow_flex).toBeCloseTo(Math.PI / 2, 12);
  });

  it("clips to the actuator ctrlrange", () => {
    expect(toCtrl({ ...HOME, shoulder_pan: 500 }).shoulder_pan).toBe(1.91986);
    expect(toCtrl({ ...HOME, shoulder_pan: -500 }).shoulder_pan).toBe(-1.91986);
    expect(toCtrl({ ...HOME, gripper: 250 }).gripper).toBe(1.74533);
  });

  it("keeps HOME inside LIMITS", () => {
    for (const name of JOINTS) {
      const [lo, hi] = LIMITS[name];
      expect(HOME[name]).toBeGreaterThanOrEqual(lo);
      expect(HOME[name]).toBeLessThanOrEqual(hi);
    }
  });
});
