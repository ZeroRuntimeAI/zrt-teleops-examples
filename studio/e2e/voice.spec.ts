/** Voice in the workspace, offline: /api/voice is routed by the test, agent events are injected through the transport. */
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { openReady as openOffline, pill } from "./helpers";

const EXECUTOR = "scripted planner · uses exact simulator positions";
const toolEvent = JSON.stringify({ t: "tool", name: "pick_up", args: { item: "yellow" }, ok: true, result: { executor: EXECUTOR } });

/** `/api/voice` answers each call from `replies`, the last one repeating; resolves with the bodies posted. */
async function routeVoice(page: Page, replies: { status: number; body: object }[]): Promise<{ posted: unknown[] }> {
  const seen = { posted: [] as unknown[] };
  await page.route("**/api/voice", (route) => {
    seen.posted.push(route.request().postDataJSON());
    const reply = replies[Math.min(seen.posted.length - 1, replies.length - 1)];
    return route.fulfill({ status: reply.status, contentType: "application/json", body: JSON.stringify(reply.body) });
  });
  return seen;
}

/** Offline sessions have no server to say Voice exists, so Voice starts disabled: these tests switch it on (see StudioTestHooks.setVoiceAvailable). */
async function openReady(page: Page): Promise<void> {
  await openOffline(page);
  await page.evaluate(() => window.__studio.setVoiceAvailable(true));
}

const voiceButton = (page: Page) => page.locator(":visible").getByRole("button", { name: "Voice", exact: true }).first();
/** The agent participant, as the room would announce it: ROBOT_EVENTS are believed only from its id. */
const joinAgent = (page: Page) => page.evaluate(() => window.__studio.transport()!.emitAgent({ t: "joined", id: "agent" }));
const emit = (page: Page, topic: string, message: string, from = "agent") =>
  page.evaluate(([t, m, f]) => window.__studio.transport()!.emit(t, m, f), [topic, message, from]);
/** Poll the voice queue every 100 ms instead of every 5 s. */
const fastPoll = (page: Page) => page.evaluate(() => void (window.__studio.voicePollMs = 100));

test("without a voice agent the Voice toggle is disabled with a reason, and nothing is requested", async ({ page }) => {
  const seen = await routeVoice(page, [{ status: 200, body: { status: "dispatched" } }]);
  await openOffline(page);
  const toggle = page.locator(":visible").getByRole("button", { name: "Voice is not available yet" }).first();
  await expect(toggle).toBeDisabled();
  await expect(toggle).toHaveAttribute("title", "Voice is not available yet");
  await expect(page.locator(":visible").getByRole("button", { name: "Keyboard", exact: true }).first()).toHaveAttribute("aria-pressed", "true");
  await toggle.click({ force: true });
  expect(seen.posted).toEqual([]);
  // The test hook is the only way offline: switching it on restores the working toggle.
  await page.evaluate(() => window.__studio.setVoiceAvailable(true));
  await expect(voiceButton(page)).toBeEnabled();
});

test("a 503 voice_unavailable from the server disables the toggle quietly, with no error and no mic", async ({ page }) => {
  await routeVoice(page, [{ status: 503, body: { error: "voice_unavailable" } }]);
  await openReady(page);
  await voiceButton(page).click();
  await expect(page.locator(":visible").getByRole("button", { name: "Voice is not available yet" }).first()).toBeDisabled();
  await expect(page.getByText(/Voice isn't available/)).toHaveCount(0);
  await expect(page.locator("[data-phase]")).toHaveAttribute("data-phase", "ready");
});

test("a queued visitor sees their place, the scripted-planner label, and Stop reaches the agent", async ({ page }) => {
  const seen = await routeVoice(page, [{ status: 202, body: { status: "queued", position: 1 } }]);
  await openReady(page);

  await voiceButton(page).click();
  await expect(page.getByText("you're #1")).toBeVisible();
  expect(seen.posted[0]).toEqual({ roomId: "offline", language: "en" });

  await joinAgent(page);
  await emit(page, "ROBOT_EVENTS", toolEvent);
  await expect(page.getByText(EXECUTOR)).toBeVisible();

  await page.getByRole("button", { name: "Stop", exact: false }).filter({ visible: true }).click();
  await expect(pill(page)).toHaveText(/E-STOPPED/, { timeout: 300 });
  const published = await page.evaluate(() => window.__studio.transport()!.published);
  expect(published).toContainEqual({ topic: "ROBOT_CTRL", message: '{"cmd":"stop"}' });
});

test("a dispatched agent: the mic opens, the transcript and state follow, Keyboard mutes again", async ({ page }) => {
  const seen = await routeVoice(page, [{ status: 200, body: { status: "dispatched" } }]);
  await openReady(page);
  // The offline transport has no mic: record what the page asks of it.
  await page.evaluate(() => {
    const t = window.__studio.transport()!;
    const mic: boolean[] = [];
    (window as unknown as { __mic: boolean[] }).__mic = mic;
    t.enableMic = async (on) => void mic.push(on);
  });
  const mic = () => page.evaluate(() => (window as unknown as { __mic: boolean[] }).__mic);

  await page.getByRole("button", { name: "HI (Hindi)" }).click();
  await voiceButton(page).click();
  await expect(page.getByText("Agent ready").filter({ visible: true })).toBeVisible();
  expect(seen.posted).toEqual([{ roomId: "offline", language: "hi" }]);
  expect(await mic()).toEqual([true]);

  await joinAgent(page);
  await emit(page, "ROBOT_EVENTS", '{"t":"agent","state":"listening"}');
  await expect(page.getByText("Listening").filter({ visible: true })).toBeVisible();
  await emit(page, "ROBOT_EVENTS", '{"t":"heard","text":"Pick up the yellow cube"}');
  await emit(page, "ROBOT_EVENTS", '{"t":"agent","state":"speaking"}');
  await expect(page.getByText("Pick up the yellow cube").filter({ visible: true })).toBeVisible();
  await expect(page.getByText("Speaking").filter({ visible: true })).toBeVisible();
  // The SDK reports the same line too: still one row.
  await page.evaluate(() => window.__studio.transport()!.emitAgent({ t: "said", who: "you", text: "Pick up the yellow cube" }));
  await page.evaluate(() => window.__studio.transport()!.emitAgent({ t: "said", who: "agent", text: "On it." }));
  await expect(page.getByText("On it.").filter({ visible: true })).toBeVisible();
  await expect(page.getByText("Pick up the yellow cube")).toHaveCount(1);
  // No agent audio track in offline mode: no level meter, rather than an invented one.
  await expect(page.getByTestId("voice-level")).toHaveCount(0);

  await page.getByRole("button", { name: "Keyboard", exact: true }).filter({ visible: true }).click();
  await expect(page.getByText("Speaking")).toHaveCount(0);
  expect(await mic()).toEqual([true, false]);
});

test("ROBOT_EVENTS from anyone but the agent are ignored, and so is everything before it joins", async ({ page }) => {
  await routeVoice(page, [{ status: 202, body: { status: "queued", position: 1 } }]);
  await openReady(page);
  await voiceButton(page).click();
  await expect(page.getByText("you're #1")).toBeVisible();

  await emit(page, "ROBOT_EVENTS", toolEvent); // no agent known yet
  await joinAgent(page);
  await emit(page, "ROBOT_EVENTS", toolEvent, "intruder");
  await emit(page, "ROBOT_EVENTS", '{"t":"heard","text":"forged line"}', "intruder");
  await emit(page, "ROBOT_EVENTS", '{"t":"heard","text":"real line"}');
  await expect(page.getByText("real line").filter({ visible: true })).toBeVisible();
  await expect(page.getByText("forged line")).toHaveCount(0);
  await expect(page.getByText(EXECUTOR)).toHaveCount(0);
});

test("a visitor who waits in line keeps the place through one failed poll", async ({ page }) => {
  await openReady(page);
  await fastPoll(page);
  let calls = 0;
  await page.route("**/api/voice", (route) => {
    calls += 1;
    if (calls === 2) return route.abort("connectionrefused");
    return route.fulfill({ status: calls === 1 ? 202 : 200, contentType: "application/json", body: JSON.stringify(calls === 1 ? { status: "queued", position: 3 } : { status: "dispatched" }) });
  });
  await voiceButton(page).click();
  await expect(page.getByText("Agent ready").filter({ visible: true })).toBeVisible();
  expect(calls).toBe(3);
});

test("a full voice service shows the error and leaves keyboard driving alone", async ({ page }) => {
  await routeVoice(page, [{ status: 404, body: { error: "unknown_room" } }]);
  await openReady(page);
  await voiceButton(page).click();
  await expect(page.getByText(/Voice isn't available/).filter({ visible: true })).toBeVisible();
  await expect(page.locator("[data-phase]")).toHaveAttribute("data-phase", "ready");
});

test("session_ending from the voice service ends the session", async ({ page }) => {
  await routeVoice(page, [{ status: 409, body: { error: "session_ending" } }]);
  await openReady(page);
  await voiceButton(page).click();
  await expect(page.locator("[data-phase]")).toHaveAttribute("data-phase", "ended");
});

for (const [name, viewport] of [["desktop", { width: 1440, height: 900 }], ["touch", { width: 375, height: 812 }]] as const) {
  test(`voice queued and active have no serious axe violations (${name})`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await routeVoice(page, [{ status: 202, body: { status: "queued", position: 2 } }, { status: 200, body: { status: "dispatched" } }]);
    await openReady(page);
    await fastPoll(page);
    const violations = async () =>
      (await new AxeBuilder({ page }).analyze()).violations
        .filter((v) => v.impact === "serious" || v.impact === "critical")
        .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);

    await voiceButton(page).click();
    await expect(page.getByText("you're #2").filter({ visible: true })).toBeVisible();
    expect(await violations()).toEqual([]);

    // The next poll answers "dispatched".
    await expect(page.getByText("Agent ready").filter({ visible: true })).toBeVisible();
    await joinAgent(page);
    await emit(page, "ROBOT_EVENTS", '{"t":"agent","state":"listening"}');
    await emit(page, "ROBOT_EVENTS", '{"t":"heard","text":"Pick up the yellow cube"}');
    await emit(page, "ROBOT_EVENTS", toolEvent);
    await expect(page.getByText(EXECUTOR).filter({ visible: true })).toBeVisible();
    expect(await violations()).toEqual([]);
  });
}
