import { describe, expect, it, vi } from "vitest";
import { POLL_MS, POLL_RETRIES, VoiceLifecycle, postVoice, type Reply, type VoiceDeps } from "./voiceSession";
import type { VoiceEvent } from "./voiceEvents";

const QUEUED = (position: number): Reply => ({ kind: "queued", position });
const DISPATCHED: Reply = { kind: "dispatched" };
const FLAKY: Reply = { kind: "failed", why: "couldn't reach the server", transient: true };

/** A rig with a scripted server and a pause the test releases by hand (it still ends at once on abort). */
function rig(replies: Reply[], over: Partial<VoiceDeps> = {}) {
  const script = [...replies];
  const events: VoiceEvent[] = [];
  const errors: (string | undefined)[] = [];
  const waits: { ms: number; release(): void }[] = [];
  const deps = {
    request: vi.fn(async () => script.shift() ?? DISPATCHED),
    pause: vi.fn(
      (ms: number, signal: AbortSignal) =>
        new Promise<void>((resolve) => {
          waits.push({ ms, release: resolve });
          signal.addEventListener("abort", () => resolve(), { once: true });
        }),
    ),
    enableMic: vi.fn(async () => {}),
    handBack: vi.fn(),
    dispatch: (e: VoiceEvent) => void events.push(e),
    note: vi.fn(),
    setError: (m?: string) => void errors.push(m),
    end: vi.fn(),
    unavailable: vi.fn(),
    ...over,
  } satisfies VoiceDeps;
  const life = new VoiceLifecycle();
  /** Let queued promise callbacks run. */
  const settle = () => new Promise((r) => setTimeout(r, 0));
  return { deps, life, events, errors, waits, settle };
}

describe("VoiceLifecycle", () => {
  it("polls every POLL_MS while queued, then opens the mic and hands control back", async () => {
    const r = rig([QUEUED(2), QUEUED(1), DISPATCHED]);
    const done = r.life.start(r.deps);
    await r.settle();
    expect(r.waits.map((w) => w.ms)).toEqual([POLL_MS]);
    r.waits[0].release();
    await r.settle();
    r.waits[1].release();
    await done;
    expect(r.deps.request).toHaveBeenCalledTimes(3);
    expect(r.events).toEqual([{ t: "queued", position: 2 }, { t: "queued", position: 1 }, { t: "dispatched" }]);
    expect(r.deps.enableMic).toHaveBeenCalledWith(true);
    expect(r.deps.handBack).toHaveBeenCalledTimes(1);
    expect(r.life.busy).toBe(false);
  });

  it("voice_unavailable ends the attempt quietly: no error text, no mic, the page told", async () => {
    const r = rig([{ kind: "unavailable" }]);
    await r.life.start(r.deps);
    expect(r.deps.unavailable).toHaveBeenCalledTimes(1);
    expect(r.errors.filter(Boolean)).toEqual([]);
    expect(r.events).toContainEqual({ t: "off" });
    expect(r.deps.enableMic).not.toHaveBeenCalled();
    expect(r.life.busy).toBe(false);
  });

  it("uses an injected interval", async () => {
    const r = rig([QUEUED(1)], { pollMs: 25 });
    void r.life.start(r.deps);
    await r.settle();
    expect(r.waits[0].ms).toBe(25);
    r.life.stop();
  });

  it("stop (Leave queue) ends the poll: no further request", async () => {
    const r = rig([QUEUED(3), QUEUED(3)]);
    const done = r.life.start(r.deps);
    await r.settle();
    r.life.stop();
    await done;
    await r.settle();
    expect(r.deps.request).toHaveBeenCalledTimes(1);
    expect(r.deps.enableMic).not.toHaveBeenCalled();
    expect(r.deps.handBack).not.toHaveBeenCalled();
    expect(r.life.busy).toBe(false);
  });

  it("stop while a request is in flight drops its answer", async () => {
    let answer!: (r: Reply) => void;
    const r = rig([], { request: vi.fn(() => new Promise<Reply>((resolve) => (answer = resolve))) });
    const done = r.life.start(r.deps);
    r.life.stop();
    answer(DISPATCHED);
    await done;
    expect(r.events).toEqual([]);
    expect(r.deps.enableMic).not.toHaveBeenCalled();
  });

  it("a 409 mid-poll ends the session and leaves the line", async () => {
    const r = rig([QUEUED(1), { kind: "ending" }]);
    const done = r.life.start(r.deps);
    await r.settle();
    r.waits[0].release();
    await done;
    expect(r.deps.end).toHaveBeenCalledTimes(1);
    expect(r.events.at(-1)).toEqual({ t: "off" });
    expect(r.deps.enableMic).not.toHaveBeenCalled();
    expect(r.life.busy).toBe(false);
  });

  it("start while busy does nothing: one poller", async () => {
    const r = rig([QUEUED(1), QUEUED(1)]);
    const first = r.life.start(r.deps);
    await r.settle();
    await r.life.start(r.deps);
    await r.life.start(r.deps);
    expect(r.deps.request).toHaveBeenCalledTimes(1);
    r.life.stop();
    await first;
  });

  it("rapid on, off, on leaves exactly one live poller", async () => {
    const r = rig([QUEUED(1), QUEUED(1), QUEUED(1), DISPATCHED]);
    const first = r.life.start(r.deps);
    await r.settle();
    r.life.stop();
    const second = r.life.start(r.deps);
    await r.settle();
    await first; // the first chain is over
    expect(r.deps.request).toHaveBeenCalledTimes(2);
    // Releasing the first chain's stale pause must not make it poll again.
    r.waits[0].release();
    await r.settle();
    expect(r.deps.request).toHaveBeenCalledTimes(2);
    r.waits[1].release();
    await r.settle();
    r.waits[2]?.release();
    await second;
    expect(r.deps.enableMic).toHaveBeenCalledTimes(1);
    expect(r.deps.handBack).toHaveBeenCalledTimes(1);
  });

  it("keeps the place through failed polls, up to POLL_RETRIES in a row", async () => {
    const r = rig([QUEUED(2), FLAKY, FLAKY, QUEUED(1), DISPATCHED]);
    const done = r.life.start(r.deps);
    for (let i = 0; i < 4; i += 1) {
      await r.settle();
      r.waits[i].release();
    }
    await done;
    expect(r.errors).toEqual([undefined]); // only the reset at the start
    expect(r.deps.request).toHaveBeenCalledTimes(5);
    expect(r.waits.every((w) => w.ms === POLL_MS)).toBe(true);
    expect(r.deps.handBack).toHaveBeenCalledTimes(1);
  });

  it("a success resets the retry budget", async () => {
    const r = rig([QUEUED(2), FLAKY, FLAKY, QUEUED(2), FLAKY, FLAKY, DISPATCHED]);
    const done = r.life.start(r.deps);
    for (let i = 0; i < 6; i += 1) {
      await r.settle();
      r.waits[i].release();
    }
    await done;
    expect(r.deps.handBack).toHaveBeenCalledTimes(1);
  });

  it("gives up with the error after more than POLL_RETRIES failures in a row", async () => {
    const r = rig([QUEUED(2), FLAKY, FLAKY, FLAKY]);
    const done = r.life.start(r.deps);
    for (let i = 0; i <= POLL_RETRIES; i += 1) {
      await r.settle();
      r.waits[i].release();
    }
    await done;
    expect(r.deps.request).toHaveBeenCalledTimes(4);
    expect(r.errors.at(-1)).toMatch(/Voice isn't available/);
    expect(r.events.at(-1)).toEqual({ t: "off" });
    expect(r.life.busy).toBe(false);
  });

  it("does not retry a first request that fails, or an answer that is final", async () => {
    const first = rig([FLAKY]);
    await first.life.start(first.deps);
    expect(first.deps.request).toHaveBeenCalledTimes(1);
    expect(first.errors.at(-1)).toMatch(/Voice isn't available/);

    const final = rig([QUEUED(1), { kind: "failed", why: "unknown room", transient: false }]);
    const done = final.life.start(final.deps);
    await final.settle();
    final.waits[0].release();
    await done;
    expect(final.deps.request).toHaveBeenCalledTimes(2);
    expect(final.errors.at(-1)).toContain("unknown room");
  });

  it("a denied mic is an error and Voice goes off", async () => {
    const r = rig([DISPATCHED], { enableMic: vi.fn(async () => Promise.reject(new Error("denied"))) });
    await r.life.start(r.deps);
    expect(r.errors.at(-1)).toMatch(/microphone/);
    expect(r.events.at(-1)).toEqual({ t: "off" });
    expect(r.deps.handBack).not.toHaveBeenCalled();
  });

  it("switched off while the mic opens: the mic is muted again and nothing is handed over", async () => {
    let opened!: () => void;
    const enableMic = vi.fn((on: boolean) => (on ? new Promise<void>((resolve) => (opened = resolve)) : Promise.resolve()));
    const r = rig([DISPATCHED], { enableMic });
    const done = r.life.start(r.deps);
    await r.settle();
    r.life.stop();
    opened();
    await done;
    expect(enableMic).toHaveBeenLastCalledWith(false);
    expect(r.deps.handBack).not.toHaveBeenCalled();
  });
});

describe("postVoice", () => {
  const reply = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status }));
  const post = async (fetchMock: ReturnType<typeof vi.fn>) => {
    vi.stubGlobal("fetch", fetchMock);
    try {
      return await postVoice("room-1", "hi", new AbortController().signal);
    } finally {
      vi.unstubAllGlobals();
    }
  };

  it("maps the server's answers", async () => {
    expect(await post(reply(200, { status: "dispatched" }))).toEqual(DISPATCHED);
    expect(await post(reply(202, { status: "queued", position: 4 }))).toEqual(QUEUED(4));
    expect(await post(reply(409, { error: "session_ending" }))).toEqual({ kind: "ending" });
    expect(await post(reply(503, { error: "voice_unavailable" }))).toEqual({ kind: "unavailable" });
    expect(await post(reply(503, { error: "upstream_busy" }))).toMatchObject({ kind: "failed", transient: true });
    expect(await post(reply(404, { error: "unknown_room" }))).toEqual({ kind: "failed", why: "unknown room", transient: false });
    expect(await post(reply(400, { error: "bad_language" }))).toMatchObject({ kind: "failed", transient: false });
  });

  it("sends the room and language as JSON", async () => {
    const fetchMock = reply(200, { status: "dispatched" });
    await post(fetchMock);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/voice");
    expect(JSON.parse(String(init.body))).toEqual({ roomId: "room-1", language: "hi" });
  });

  it("a server error or an unreachable server is transient; an aborted request throws", async () => {
    expect(await post(reply(503, {}))).toMatchObject({ kind: "failed", transient: true });
    expect(await post(vi.fn(async () => Promise.reject(new TypeError("offline"))))).toMatchObject({ kind: "failed", transient: true });
    const abort = new AbortController();
    abort.abort();
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new DOMException("aborted", "AbortError"))));
    await expect(postVoice("r", "en", abort.signal)).rejects.toThrow();
    vi.unstubAllGlobals();
  });
});
