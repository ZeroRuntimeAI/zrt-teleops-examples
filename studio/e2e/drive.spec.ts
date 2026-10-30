/** The workspace core, offline with test hooks (see playwright.config.ts): drive, Stop and Reset. */
import { expect, test, type Page } from "@playwright/test";

type Probe = { latency?: Promise<number>; pillTexts: string[]; states: (string | undefined)[] };
// Functions passed to page.evaluate run in the page and cannot close over this file: they reach the probe as a global.
type TrackedWorker = { worker: Worker; terminated: boolean };
declare global {
  interface Window {
    __probe: Probe;
    __workers: TrackedWorker[];
  }
}

const pill = (page: Page) => page.getByTestId("safe-state");

async function openReady(page: Page): Promise<void> {
  await page.goto("/tabletop");
  await expect(page.getByText("SIMULATION", { exact: true })).toBeVisible();
  await expect(page.locator("[data-phase]")).toHaveAttribute("data-phase", "ready", { timeout: 90_000 });
  await expect.poll(() => page.evaluate(() => window.__studio.status() !== null)).toBe(true);
}

/** Test-side only: record every Worker the page creates, and whether it was terminated. */
async function trackWorkers(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const tracked: TrackedWorker[] = [];
    window.__workers = tracked;
    const Base = window.Worker;
    window.Worker = class extends Base {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        const entry = { worker: this as Worker, terminated: false };
        tracked.push(entry);
        const terminate = this.terminate.bind(this);
        this.terminate = () => {
          entry.terminated = true;
          terminate();
        };
      }
    };
  });
}

/** Record every pill text and every distinct status the page receives, from now on. */
async function watch(page: Page): Promise<void> {
  await page.evaluate(() => {
    const p: Probe = { pillTexts: [], states: [] };
    window.__probe = p;
    const el = document.querySelector('[data-testid="safe-state"]')!;
    new MutationObserver(() => p.pillTexts.push(el.textContent ?? "")).observe(el, {
      subtree: true,
      childList: true,
      characterData: true,
    });
    let last: unknown = null;
    setInterval(() => {
      const s = window.__studio.status();
      if (s !== last) p.states.push(s?.safeState);
      last = s;
    }, 1);
  });
}

test("drives with the keyboard, stops on Space and resets", async ({ page }) => {
  await openReady(page);

  const z0 = await page.evaluate(() => window.__studio.gripperZ());
  await page.keyboard.down("r");
  await page.waitForTimeout(1000); // the hold itself, not a wait for state
  await page.keyboard.up("r");
  await expect.poll(() => page.evaluate(() => window.__studio.gripperZ()), { timeout: 5_000 }).toBeGreaterThan(z0 + 0.05);

  // Space → E-STOPPED, timed in the page from the keydown to the pill reading it.
  await watch(page);
  await page.evaluate(() => {
    window.__probe.latency = new Promise<number>((resolve) => {
      let t0 = 0;
      addEventListener("keydown", (e) => e.code === "Space" && (t0 = performance.now()), { capture: true });
      const el = document.querySelector('[data-testid="safe-state"]')!;
      const check = () => {
        const stopped = window.__studio.status()?.safeState === "estopped" && el.textContent?.includes("E-STOPPED");
        if (t0 && stopped) resolve(performance.now() - t0);
        else setTimeout(check, 1);
      };
      check();
    });
  });
  await page.keyboard.press("Space");
  const latency = await page.evaluate(() => window.__probe.latency!);
  console.log(`Space → E-STOPPED pill: ${latency.toFixed(1)} ms`);
  expect(latency).toBeLessThan(300);
  await expect(pill(page)).toHaveText(/E-STOPPED/);

  await page.getByRole("button", { name: "Reset" }).click();
  await expect(pill(page)).not.toHaveText(/E-STOPPED/);
  await expect.poll(() => page.evaluate(() => window.__studio.status()?.safeState)).not.toBe("estopped");
  await expect.poll(() => page.evaluate(() => window.__studio.status()?.cubesInBox.length)).toBe(0);
});

test("Reset never shows E-STOPPED on the way", async ({ page }) => {
  await openReady(page);
  await expect(pill(page)).not.toHaveText(/E-STOPPED/);
  await watch(page);

  await page.getByRole("button", { name: "Reset" }).click();
  // The status at install, the reset's own, then two more 5 Hz ones.
  await expect.poll(() => page.evaluate(() => window.__probe.states.length)).toBeGreaterThanOrEqual(4);

  const { pillTexts, states } = await page.evaluate(() => window.__probe);
  expect(states).not.toContain("estopped");
  expect(pillTexts.filter((t) => t.includes("E-STOPPED"))).toEqual([]);
});

test("a robot error after ready is a notice, and Stop and Space still latch", async ({ page }) => {
  await trackWorkers(page);
  await openReady(page);
  // The host throws on a null `joints` (Object.entries(null)); the worker reports it as an `error`.
  await page.evaluate(() => window.__workers.at(-1)!.worker.postMessage({ t: "setJoints", joints: null, held: true }));
  await expect(page.getByText(/The robot reported an error/)).toBeVisible();
  await expect(page.locator("[data-phase]")).toHaveAttribute("data-phase", "ready");

  await page.keyboard.press("Space");
  await expect(pill(page)).toHaveText(/E-STOPPED/);
  await page.getByRole("button", { name: "Reset" }).click();
  await expect(pill(page)).not.toHaveText(/E-STOPPED/);
  await page.getByRole("button", { name: "Stop", exact: false }).click();
  await expect(pill(page)).toHaveText(/E-STOPPED/);
});

test("a fatal robot error leaves the room and ends the worker", async ({ page }) => {
  await trackWorkers(page);
  // A broken model fails the worker's boot: an error before `ready`.
  await page.route("**/sim/scene.xml", (route) => route.fulfill({ status: 200, body: "<mujoco><broken" }));
  await page.goto("/tabletop");
  await expect(page.locator("[data-phase]")).toHaveAttribute("data-phase", "error", { timeout: 90_000 });
  await expect(page.getByText("Couldn't load the robot")).toBeVisible();
  expect(await page.evaluate(() => window.__studio.transport()?.left)).toBe(true);
  expect(await page.evaluate(() => window.__workers.length > 0 && window.__workers.every((w) => w.terminated))).toBe(true);
});

test("the touch pad rolls the wrist while held", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await openReady(page);
  const roll = () => page.evaluate(() => window.__studio.status()!.joints.wrist_roll);
  const before = await roll();
  await page.getByRole("button", { name: "Roll right (hold)" }).hover();
  await page.mouse.down();
  await page.waitForTimeout(500); // the hold itself
  await page.mouse.up();
  await expect.poll(roll, { timeout: 5_000 }).toBeGreaterThan(before + 10);
});
