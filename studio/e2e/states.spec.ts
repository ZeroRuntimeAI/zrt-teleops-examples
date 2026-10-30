/** Edge states of `/tabletop`: background tab, session end, load failure, lost room, and the joint sliders. */
import { expect, test } from "@playwright/test";
import { openReady, pill, safeState, setVisibility } from "./helpers";

test("a background tab holds the robot and says so on return (Review Focus 1)", async ({ page }) => {
  await openReady(page);
  await page.keyboard.down("w");
  await expect.poll(() => safeState(page)).toBe("active");

  await setVisibility(page, "hidden");
  await page.waitForTimeout(2000); // the 2 s in the background, not a wait for state
  await setVisibility(page, "visible");

  await expect(page.getByText("Paused while this tab was in the background — the robot held its position.")).toBeVisible();
  await expect.poll(() => safeState(page)).toBe("holding");
  await page.keyboard.up("w");
});

test("the session ends at expiresAt (Review Focus 4)", async ({ page }) => {
  await openReady(page);
  await page.evaluate(() => window.__studio.expireIn(1000));
  await expect(page.getByText("Session ended", { exact: true })).toBeVisible({ timeout: 1500 });
  await expect(page.getByRole("button", { name: "Start another" })).toBeVisible();
  await expect(page.locator("[data-phase]")).toHaveAttribute("data-phase", "ended");
  expect(await page.evaluate(() => window.__studio.transport()?.left)).toBe(true);
});

test("a failed scene load shows the error with Retry, and Retry recovers (Review Focus 5)", async ({ page }) => {
  await page.route("**/sim/scene.xml", (route) => route.fulfill({ status: 500, body: "" }));
  await page.goto("/tabletop");
  await expect(page.getByText("Couldn't load the robot")).toBeVisible({ timeout: 90_000 });
  const retry = page.getByRole("button", { name: "Retry" });
  await expect(retry).toBeVisible();
  // Not blank: the stage backdrop and the chrome are still there.
  await expect(page.locator("[data-stage]")).toBeVisible();
  await expect(page.getByText("SIMULATION", { exact: true })).toBeVisible();

  await page.unroute("**/sim/scene.xml");
  await retry.click();
  await expect(page.locator("[data-phase]")).toHaveAttribute("data-phase", "ready", { timeout: 90_000 });
});

test("a lost room reads DISCONNECTED and offers a new session (Review Focus 3)", async ({ page }) => {
  await openReady(page);
  await page.evaluate(() => window.__studio.simulateDisconnect());
  await expect(pill(page)).toHaveText(/DISCONNECTED/);
  const again = page.getByRole("button", { name: "Start a new session" });
  await expect(again).toBeVisible();

  await again.click();
  await expect(page.locator("[data-phase]")).toHaveAttribute("data-phase", "ready", { timeout: 90_000 });
  await expect(pill(page)).not.toHaveText(/DISCONNECTED/);
});

test("dragging the shoulder_pan slider drives the joint", async ({ page }) => {
  await openReady(page);
  await page.getByRole("button", { name: "Developer" }).click();
  const slider = page.getByRole("slider", { name: "shoulder_pan target" });
  await expect(slider).toBeVisible();

  const box = (await slider.boundingBox())!;
  const value = async () => Number(await slider.inputValue());
  const pxPerUnit = box.width / 220; // LIMITS.shoulder_pan is -110 … 110
  let x = box.x + box.width / 2 + ((await value()) * pxPerUnit);
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  // Walk the thumb onto 30: the thumb's inset makes one jump land a little off.
  for (let i = 0; i < 12 && Math.abs((await value()) - 30) > 0.5; i += 1) {
    x += (30 - (await value())) * pxPerUnit;
    await page.mouse.move(x, y, { steps: 4 });
  }
  expect(Math.abs((await value()) - 30)).toBeLessThanOrEqual(1);

  const pan = () => page.evaluate(() => window.__studio.status()!.joints.shoulder_pan);
  await expect.poll(async () => Math.abs((await pan()) - 30), { timeout: 2000 }).toBeLessThan(2);
  await page.mouse.up();
});

test("the token field is plain text with autocomplete off, outside any form (never offered to a password manager)", async ({ page }) => {
  await openReady(page);
  await page.getByRole("button", { name: "Developer" }).click();
  const field = page.getByLabel("2 · Paste your Zero Runtime token");
  await expect(field).toHaveAttribute("type", "text");
  await expect(field).toHaveAttribute("autocomplete", "off");
  expect(await field.evaluate((el) => (el as HTMLInputElement).form)).toBeNull();
});

test("without WebGL2 the home page still renders, with the preview's fallback line", async ({ page }) => {
  await page.addInitScript(() => {
    const get = HTMLCanvasElement.prototype.getContext;
    // @ts-expect-error test-only override of an overloaded method
    HTMLCanvasElement.prototype.getContext = function (type: string, ...rest: unknown[]) {
      return type === "webgl2" ? null : get.call(this, type, ...(rest as []));
    };
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/Put the cubes/);
  await expect(page.getByRole("link", { name: "Open the tabletop" })).toBeVisible();
  await expect(page.getByText("The preview couldn't load the scene.")).toBeVisible();
});
