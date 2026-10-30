import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readEnv } from "../../../server/env";
import { getStore, resetStoreForTests } from "../../../server/store";
import { createRoom, UpstreamError } from "../../../server/videosdk";
import { POST } from "./route";

vi.mock("../../../server/videosdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../server/videosdk")>()),
  createRoom: vi.fn(),
  dispatchAgent: vi.fn(),
}));

const SECRET = "s3cr3t-must-never-leak";
const ROOM = "abcd-efgh-ijkl";

const call = (headers: Record<string, string> = {}) =>
  POST(new NextRequest("http://studio.test/api/session", { method: "POST", headers }));
const claims = (token: string) => JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()) as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("ZERORUNTIME_API_KEY", "key-123");
  vi.stubEnv("ZERORUNTIME_SECRET", SECRET);
  vi.stubEnv("STUDIO_VOICE_AGENT_ID", "agent-1");
  vi.stubEnv("REDIS_URL", "");
  vi.mocked(createRoom).mockResolvedValue(ROOM);
});

afterEach(() => {
  resetStoreForTests();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("POST /api/session", () => {
  it("returns a room, a join-only token and the session end time", async () => {
    const before = Date.now();
    const res = await call({ "x-forwarded-for": "203.0.113.9" });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.roomId).toBe(ROOM);
    expect(body.participantId).toMatch(/^studio-robot-[0-9a-f]{8}$/);
    expect(body.expiresAt).toBeGreaterThanOrEqual(before + 300_000);
    expect(body.expiresAt).toBeLessThanOrEqual(Date.now() + 300_000);

    const c = claims(body.token);
    expect(c.permissions).toEqual(["allow_join"]);
    // Bound to this room and participant: the signalling server rejects any other join with it.
    expect(c).toMatchObject({ version: 2, roles: ["rtc"], roomId: body.roomId, participantId: body.participantId });
    expect((c.exp as number) - (c.iat as number)).toBe(360);
    // The token outlives the session, so the client leaves cleanly instead of hitting a token error.
    expect((c.exp as number) * 1000).toBeGreaterThan(body.expiresAt);
  });

  it("reports voiceAvailable true when an agent is configured and false when not", async () => {
    expect((await (await call()).json()).voiceAvailable).toBe(true);
    vi.stubEnv("STUDIO_VOICE_AGENT_ID", "");
    const res = await call();
    expect(res.status).toBe(200);
    expect((await res.json()).voiceAvailable).toBe(false);
  });

  it("never puts the account secret in the response, and forbids caching", async () => {
    const res = await call();
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).not.toContain(SECRET);
  });

  it("remembers the room it issued", async () => {
    await call();
    expect(await getStore(readEnv()).hasRoom(ROOM)).toBe(true);
  });

  it("rate limits the 11th call from one IP in an hour", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-01T10:20:00Z"));
    const ip = { "x-forwarded-for": "203.0.113.9" };

    for (let i = 0; i < 10; i++) expect((await call(ip)).status).toBe(200);
    const res = await call(ip);

    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "rate_limited", retryAfterS: 2400 });
    expect(res.headers.get("retry-after")).toBe("2400");
    expect(createRoom).toHaveBeenCalledTimes(10);
  });

  it("cannot be dodged by forging the first x-forwarded-for entry", async () => {
    for (let i = 0; i < 10; i++) {
      expect((await call({ "x-forwarded-for": `forged-${i}, 203.0.113.9` })).status).toBe(200);
    }
    expect((await call({ "x-forwarded-for": "forged-11, 203.0.113.9" })).status).toBe(429);
  });

  it("honours STUDIO_TRUSTED_PROXY_HOPS", async () => {
    vi.stubEnv("STUDIO_TRUSTED_PROXY_HOPS", "2");
    for (let i = 0; i < 10; i++) await call({ "x-forwarded-for": `203.0.113.9, 10.0.0.${i}` });
    expect((await call({ "x-forwarded-for": "203.0.113.9, 10.0.0.99" })).status).toBe(429);
    expect((await call({ "x-forwarded-for": "198.51.100.1, 10.0.0.1" })).status).toBe(200);
  });

  it("counts each IP separately, and a missing header as one shared 'unknown' client", async () => {
    for (let i = 0; i < 10; i++) await call({ "x-forwarded-for": "198.51.100.1" });
    expect((await call({ "x-forwarded-for": "198.51.100.1" })).status).toBe(429);
    expect((await call({ "x-forwarded-for": "198.51.100.2" })).status).toBe(200);

    for (let i = 0; i < 10; i++) await call();
    expect((await call()).status).toBe(429);
  });

  it("opens a fresh window after the hour rolls over", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-01T10:59:00Z"));
    for (let i = 0; i < 10; i++) await call();
    expect((await call()).status).toBe(429);

    vi.setSystemTime(new Date("2026-03-01T11:00:01Z"));
    expect((await call()).status).toBe(200);
  });

  it("answers 500 without a stack or env values when the environment is invalid", async () => {
    vi.stubEnv("ZERORUNTIME_SECRET", "");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await call();
    const text = await res.text();

    expect(res.status).toBe(500);
    expect(JSON.parse(text)).toEqual({ error: "server_misconfigured" });
    expect(text).not.toMatch(/at \w|\.ts:/);
  });

  it("answers 502 when VideoSDK cannot create the room, without counting a token", async () => {
    vi.mocked(createRoom).mockRejectedValue(new UpstreamError("createRoom: HTTP 401"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await call();

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "upstream_error" });
  });
});
