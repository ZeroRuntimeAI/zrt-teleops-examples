/** axe on both pages, and the safety controls reachable by Tab with a visible focus ring. */
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { openReady } from "./helpers";

async function seriousViolations(page: Page) {
  const { violations } = await new AxeBuilder({ page }).analyze();
  return violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
}

test("home has no serious or critical axe violations", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  expect(await seriousViolations(page)).toEqual([]);
});

test("tabletop has no serious or critical axe violations, with the drawer open", async ({ page }) => {
  await openReady(page);
  expect(await seriousViolations(page)).toEqual([]);
  await page.getByRole("button", { name: "Developer" }).click();
  await expect(page.getByRole("slider", { name: "shoulder_pan target" })).toBeVisible();
  expect(await seriousViolations(page)).toEqual([]);
});

/** Tab until `target` has focus; fails if it never does. */
async function tabTo(page: Page, target: Locator): Promise<void> {
  for (let i = 0; i < 60; i += 1) {
    await page.keyboard.press("Tab");
    if (await target.evaluate((el) => el === document.activeElement)) return;
  }
  throw new Error("never reached by Tab");
}

const outline = (target: Locator) =>
  target.evaluate((el) => {
    const s = getComputedStyle(el);
    return s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0;
  });

test("Stop, Reset and the mode switch are reachable with Tab and show a focus ring", async ({ page }) => {
  await openReady(page);
  for (const target of [
    page.getByRole("group", { name: "Control mode" }).getByRole("button", { name: "Keyboard" }),
    page.getByRole("button", { name: "Reset" }),
    page.getByRole("button", { name: "Stop", exact: false }),
  ]) {
    await page.locator("body").focus();
    await tabTo(page, target);
    expect(await outline(target)).toBe(true);
  }
});

test("the error and lost-room plates have no serious or critical axe violations", async ({ page }) => {
  await page.route("**/sim/scene.xml", (route) => route.fulfill({ status: 500, body: "" }));
  await page.goto("/tabletop");
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible({ timeout: 90_000 });
  expect(await seriousViolations(page)).toEqual([]);

  await page.unroute("**/sim/scene.xml");
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.locator("[data-phase]")).toHaveAttribute("data-phase", "ready", { timeout: 90_000 });
  await page.evaluate(() => window.__studio.simulateDisconnect());
  await expect(page.getByRole("button", { name: "Start a new session" })).toBeVisible();
  expect(await seriousViolations(page)).toEqual([]);
});
