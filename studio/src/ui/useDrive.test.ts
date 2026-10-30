import { describe, expect, it } from "vitest";
import { jogFromHeld } from "./useDrive";

describe("jogFromHeld", () => {
  it("combines held keys, cancels opposites and ignores the rest", () => {
    expect(jogFromHeld(new Set())).toEqual({ x: 0, y: 0, z: 0, roll: 0, grip: 0 });
    expect(jogFromHeld(new Set(["KeyW", "KeyD", "KeyR", "KeyX"]))).toEqual({ x: 1, y: -1, z: 1, roll: 0, grip: 1 });
    expect(jogFromHeld(new Set(["KeyW", "KeyS", "KeyQ", "Space", "KeyP"]))).toEqual({ x: 0, y: 0, z: 0, roll: -1, grip: 0 });
  });
});
