import { defineConfig, devices } from "@playwright/test";

const PORT = 3111;

/** Offline mode (no room, no /api/session) with `window.__studio` installed: see src/ui/useRobot.ts. */
export default defineConfig({
  testDir: "e2e",
  // The first visit compiles the page and boots two WebAssembly modules.
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    ...devices["Desktop Chrome"],
    viewport: { width: 1440, height: 900 },
    // The real browser in new headless mode, so the stage renders on the GPU as it does for visitors.
    // Elsewhere WebGL falls back to SwiftShader, about 6x slower here, which stretches the 300 ms Stop budget.
    channel: "chromium",
    launchOptions: { args: process.platform === "darwin" ? ["--use-angle=metal"] : ["--enable-unsafe-swiftshader"] },
  },
  webServer: {
    command: `npx next dev --port ${PORT}`,
    url: `http://localhost:${PORT}/`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: { NEXT_PUBLIC_STUDIO_OFFLINE: "1", NEXT_PUBLIC_STUDIO_TEST_HOOKS: "1" },
  },
});
