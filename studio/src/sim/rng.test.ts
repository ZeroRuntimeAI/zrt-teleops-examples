import { describe, expect, it } from "vitest";
import { mulberry32 } from "./rng";

const take = (seed: number, n: number) => {
  const next = mulberry32(seed);
  return Array.from({ length: n }, next);
};

describe("mulberry32", () => {
  it("repeats the sequence for the same seed", () => {
    expect(take(42, 8)).toEqual(take(42, 8));
  });

  it("differs between seeds", () => {
    expect(take(1, 4)).not.toEqual(take(2, 4));
  });

  it("stays inside [0, 1) and spreads out", () => {
    const xs = take(7, 5000);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...xs)).toBeLessThan(1);
    expect(xs.reduce((a, b) => a + b, 0) / xs.length).toBeCloseTo(0.5, 1);
  });
});
