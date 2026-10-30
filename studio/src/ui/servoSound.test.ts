import { describe, expect, it } from "vitest";
import { jointSpeeds, servoVoice } from "./servoSound";

describe("servoVoice", () => {
  it("is silent below the deadband, so a holding arm makes no sound", () => {
    expect(servoVoice("elbow_flex", 0).gain).toBe(0);
    expect(servoVoice("elbow_flex", 1).gain).toBe(0);
  });

  it("gets louder and higher as the joint turns faster", () => {
    const slow = servoVoice("shoulder_pan", 10);
    const fast = servoVoice("shoulder_pan", 60);
    expect(fast.gain).toBeGreaterThan(slow.gain);
    expect(fast.humHz).toBeGreaterThan(slow.humHz);
    expect(fast.whineHz).toBeGreaterThan(slow.whineHz);
  });

  it("stays within its caps however fast the joint moves", () => {
    const v = servoVoice("wrist_roll", 10_000);
    expect(v.gain).toBeLessThanOrEqual(1);
    expect(v.humHz).toBeLessThanOrEqual(800);
    expect(v.whineHz).toBeLessThanOrEqual(5000);
  });

  it("pitches the big shoulder motors below the small wrist ones", () => {
    expect(servoVoice("shoulder_lift", 30).humHz).toBeLessThan(servoVoice("wrist_flex", 30).humHz);
  });
});

describe("jointSpeeds", () => {
  it("is the absolute change per second, joint by joint", () => {
    const a = Float64Array.from([0, 50, 0, 0, 0, 0]);
    const b = Float64Array.from([10, 40, 0, 0, -5, 0]);
    expect(Array.from(jointSpeeds(a, b, 0.5))).toEqual([20, 20, 0, 0, 10, 0]);
  });

  it("reads a missing previous frame or a zero step as standing still", () => {
    const b = Float64Array.from([10, 0, 0, 0, 0, 0]);
    expect(Array.from(jointSpeeds(null, b, 0.016))).toEqual([0, 0, 0, 0, 0, 0]);
    expect(Array.from(jointSpeeds(b, b, 0))).toEqual([0, 0, 0, 0, 0, 0]);
  });
});
