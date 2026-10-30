/** Shared by the Task 12 suites. Offline mode with `window.__studio` (see playwright.config.ts). */
import { expect, type Page } from "@playwright/test";

export const pill = (page: Page) => page.getByTestId("safe-state");

export const safeState = (page: Page) => page.evaluate(() => window.__studio.status()?.safeState);

export async function openReady(page: Page): Promise<void> {
  await page.goto("/tabletop");
  await expect(page.locator("[data-phase]")).toHaveAttribute("data-phase", "ready", { timeout: 90_000 });
  await expect.poll(() => page.evaluate(() => window.__studio.status() !== null)).toBe(true);
}

/** Pretend the tab went to the background (or came back): the property plus the event the page listens to. */
export async function setVisibility(page: Page, state: "hidden" | "visible"): Promise<void> {
  await page.evaluate((s) => {
    Object.defineProperty(document, "visibilityState", { value: s, configurable: true });
    Object.defineProperty(document, "hidden", { value: s === "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  }, state);
}
