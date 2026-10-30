/** No horizontal overflow at any supported width; a screenshot of each for review. */
import { expect, test } from "@playwright/test";
import { openReady } from "./helpers";

const WIDTHS = [320, 375, 768, 1024, 1440, 1920] as const;
const HEIGHT = 900;

for (const width of WIDTHS) {
  test(`no horizontal overflow at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: HEIGHT });

    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`${width}-home.png`), fullPage: true });

    await openReady(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`${width}-tabletop.png`) });
  });
}
