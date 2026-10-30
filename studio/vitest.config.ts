import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // MuJoCo WASM start-up and mesh compilation are slow on a cold run.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
