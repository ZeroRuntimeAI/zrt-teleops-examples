import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readEnv } from "../../../server/env";
import { getStore, resetStoreForTests } from "../../../server/store";
import { dispatchAgent, UpstreamError } from "../../../server/videosdk";
import { POST } from "./route";

vi.mock("../../../server/videosdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../server/videosdk")>()),
  createRoom: vi.fn(),
  dispatchAgent: vi.fn(),
}));

const ROOM = "abcd-efgh-ijkl";
const post = (body: unknown) =>
  POST(
    new NextRequest("http://studio.test/api/voice", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
const issue = (id: string) => getStore(readEnv()).issueRoom(id, 360);

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("ZERORUNTIME_API_KEY", "key-123");
  vi.stubEnv("ZERORUNTIME_SECRET", "s3cr3t");
  vi.stubEnv("STUDIO_VOICE_AGENT_ID", "agent-1");
  vi.stubEnv("REDIS_URL", "");
  vi.mocked(dispatchAgent).mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
  resetStoreForTests();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("POST /api/voice", () => {
  it.each(["", "   "])("answers 503 voice_unavailable and touches nothing when no agent is configured (%j)", async (blank) => {
    vi.stubEnv("STUDIO_VOICE_AGENT_ID", blank);
    await issue(ROOM);
    const store = getStore(readEnv());
    const acquire = vi.spyOn(store, "acquireVoiceSlot");
    const release = vi.spyOn(store, "releaseVoiceSlot");

    const res = await post({ roomId: ROOM });

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "voice_unavailable" });
    expect(dispatchAgent).not.toHaveBeenCalled();
    expect(acquire).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    // No slot was taken: with one allowed concurrently, a configured server would still grant it.
    vi.stubEnv("STUDIO_VOICE_AGENT_ID", "agent-1");
    expect((await post({ roomId: ROOM })).status).toBe(200);
  });

  it("refuses to dispatch into a room this server did not issue", async () => {
    const res = await post({ roomId: ROOM });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "unknown_room" });
    expect(dispatchAgent).not.toHaveBeenCalled();
  });

  it("dispatches the agent into an issued room, defaulting to English", async () => {
    await issue(ROOM);
    const res = await post({ roomId: ROOM });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "dispatched" });
    expect(dispatchAgent).toHaveBeenCalledWith(expect.objectContaining({ voiceAgentId: "agent-1" }), ROOM, "en");
  });

  it("passes Hindi through", async () => {
    await issue(ROOM);
    await post({ roomId: ROOM, language: "hi" });
    expect(dispatchAgent).toHaveBeenCalledWith(expect.anything(), ROOM, "hi");
  });

  it.each(["fr", "", 5, null])("rejects language %j before touching anything", async (language) => {
    await issue(ROOM);
    const res = await post({ roomId: ROOM, language });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad_language" });
    expect(dispatchAgent).not.toHaveBeenCalled();
  });

  it.each([{}, { roomId: 5 }, { roomId: "../etc" }, { roomId: "" }, "not json", "[]", "null"])(
    "rejects a malformed request %j",
    async (body) => {
      const res = await post(body);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/^bad_(room_id|request)$/);
      expect(dispatchAgent).not.toHaveBeenCalled();
    },
  );

  it("queues the 6th concurrent room at position 1 and does not dispatch it", async () => {
    const rooms = ["aaaa-0000-0000", "aaaa-1111-1111", "aaaa-2222-2222", "aaaa-3333-3333", "aaaa-4444-4444", "aaaa-5555-5555"];
    for (const r of rooms) await issue(r);

    for (const r of rooms.slice(0, 5)) expect((await post({ roomId: r })).status).toBe(200);
    const res = await post({ roomId: rooms[5] });

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: "queued", position: 1 });
    expect(dispatchAgent).toHaveBeenCalledTimes(5);
  });

  it("honours STUDIO_VOICE_MAX_CONCURRENT", async () => {
    vi.stubEnv("STUDIO_VOICE_MAX_CONCURRENT", "1");
    await issue("aaaa-0000-0000");
    await issue("aaaa-1111-1111");
    expect((await post({ roomId: "aaaa-0000-0000" })).status).toBe(200);
    expect((await post({ roomId: "aaaa-1111-1111" })).status).toBe(202);
  });

  it("does not dispatch a second agent when the same room asks again", async () => {
    await issue(ROOM);
    await post({ roomId: ROOM });
    const res = await post({ roomId: ROOM });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "dispatched" });
    expect(dispatchAgent).toHaveBeenCalledTimes(1);
  });

  it("dispatches a queued room once a slot frees up", async () => {
    vi.stubEnv("STUDIO_VOICE_MAX_CONCURRENT", "1");
    await issue("aaaa-0000-0000");
    await issue("aaaa-1111-1111");
    await post({ roomId: "aaaa-0000-0000" });
    expect((await post({ roomId: "aaaa-1111-1111" })).status).toBe(202);

    await getStore(readEnv()).releaseVoiceSlot("aaaa-0000-0000");
    const res = await post({ roomId: "aaaa-1111-1111" });

    expect(res.status).toBe(200);
    expect(dispatchAgent).toHaveBeenLastCalledWith(expect.anything(), "aaaa-1111-1111", "en");
  });

  it("answers 502 and frees the slot when the dispatch fails, so a retry dispatches again", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await issue(ROOM);
    vi.mocked(dispatchAgent).mockRejectedValueOnce(new UpstreamError("dispatchAgent: HTTP 500"));

    const failed = await post({ roomId: ROOM });
    expect(failed.status).toBe(502);
    expect(await failed.json()).toEqual({ error: "upstream_error" });

    const retry = await post({ roomId: ROOM });
    expect(retry.status).toBe(200);
    expect(dispatchAgent).toHaveBeenCalledTimes(2);
  });

  describe("near the end of the session", () => {
    const T0 = Date.parse("2026-03-01T10:00:00Z");
    const at = (secondsAfterIssue: number) => vi.setSystemTime(T0 + secondsAfterIssue * 1000);
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      at(0);
    });

    it("answers 409 session_ending, without a slot or a dispatch, when under 20 s of the room remain", async () => {
      vi.stubEnv("STUDIO_VOICE_MAX_CONCURRENT", "1");
      await issue("aaaa-0000-0000"); // room lives 360 s
      await issue("aaaa-1111-1111");
      at(341); // 19 s left

      const res = await post({ roomId: "aaaa-0000-0000" });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: "session_ending" });
      expect(dispatchAgent).not.toHaveBeenCalled();

      // No slot was consumed: the only slot is still free for another room.
      expect((await post({ roomId: "aaaa-1111-1111" })).status).toBe(409);
      await getStore(readEnv()).issueRoom("aaaa-2222-2222", 360);
      expect((await post({ roomId: "aaaa-2222-2222" })).status).toBe(200);
    });

    it("still dispatches with 20 s or more left", async () => {
      await issue(ROOM);
      at(340);
      expect((await post({ roomId: ROOM })).status).toBe(200);
    });

    it("drops a queued room from the line when its session is ending", async () => {
      vi.stubEnv("STUDIO_VOICE_MAX_CONCURRENT", "1");
      await issue("aaaa-0000-0000");
      await issue("aaaa-1111-1111");
      await post({ roomId: "aaaa-0000-0000" });
      expect((await post({ roomId: "aaaa-1111-1111" })).status).toBe(202);
      at(345);
      expect((await post({ roomId: "aaaa-1111-1111" })).status).toBe(409);

      await getStore(readEnv()).issueRoom("aaaa-2222-2222", 360);
      expect(await (await post({ roomId: "aaaa-2222-2222" })).json()).toEqual({ status: "queued", position: 1 });
    });

    it("holds a late grant's slot only until the room's own expiry, so the next room is not kept waiting", async () => {
      vi.stubEnv("STUDIO_VOICE_MAX_CONCURRENT", "1");
      await issue("aaaa-0000-0000"); // expires at +360
      at(200);
      await issue("aaaa-1111-1111"); // expires at +560
      at(300);
      expect((await post({ roomId: "aaaa-0000-0000" })).status).toBe(200);
      expect((await post({ roomId: "aaaa-1111-1111" })).status).toBe(202);

      // Granted at +300 with 60 s left. A full-length slot would run to +660 and block the next room.
      at(361);
      expect((await post({ roomId: "aaaa-1111-1111" })).status).toBe(200);
    });
  });

  it("answers 500 without a stack when the environment is invalid", async () => {
    vi.stubEnv("ZERORUNTIME_SECRET", "");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await post({ roomId: ROOM });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "server_misconfigured" });
  });
});
