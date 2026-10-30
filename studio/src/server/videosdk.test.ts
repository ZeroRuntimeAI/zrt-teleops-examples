import { afterEach, describe, expect, it, vi } from "vitest";
import type { StudioEnv } from "./env";
import { createRoom, dispatchAgent, isRoomId, UpstreamError } from "./videosdk";

const env: StudioEnv = {
  apiKey: "key-123",
  secret: "unit-test-secret",
  voiceAgentId: "agent-9",
  apiBase: "https://api.example.test",
  sessionSeconds: 300,
  voiceMaxConcurrent: 5,
  sessionsPerIpPerHour: 10,
  trustedProxyHops: 1,
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const stubFetch = (response: Response | Error) => {
  const fn = vi.fn(async () => {
    if (response instanceof Error) throw response;
    return response;
  });
  vi.stubGlobal("fetch", fn);
  return fn;
};

afterEach(() => vi.unstubAllGlobals());

describe("isRoomId", () => {
  it.each(["abcd-efgh-ijkl", "Ab_1-Cd_2-Ef_3", "room1"])("accepts %s", (id) => expect(isRoomId(id)).toBe(true));
  it.each(["", "a b", "../x", "a/b", "x".repeat(65), 7, null, undefined])("rejects %s", (id) => expect(isRoomId(id)).toBe(false));
});

describe("createRoom", () => {
  it("POSTs /v2/rooms with the raw server token (no Bearer) and returns the room id", async () => {
    const fetchMock = stubFetch(json({ roomId: "abcd-efgh-ijkl", links: {} }));

    await expect(createRoom(env)).resolves.toBe("abcd-efgh-ijkl");

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toBe("https://api.example.test/v2/rooms");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization.split(".")).toHaveLength(3);
    expect(init.headers.Authorization).not.toMatch(/^Bearer/i);
    const claims = JSON.parse(Buffer.from(init.headers.Authorization.split(".")[1], "base64url").toString());
    expect(claims.permissions).toEqual(["allow_join", "allow_mod"]);
  });

  it("asks for a server-side lifetime: the session cap plus the margin, in whole minutes", async () => {
    const fetchMock = stubFetch(json({ roomId: "abcd-efgh-ijkl" }));
    await createRoom(env);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    // 300 s + 60 s margin = 6 min.
    expect(JSON.parse(init.body as string)).toEqual({
      autoCloseConfig: { type: "session-end-and-deactivate", duration: 6 },
    });

    stubFetch(json({ roomId: "abcd-efgh-ijkl" }));
    const odd = { ...env, sessionSeconds: 301 };
    await createRoom(odd);
    const [, init2] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init2.body as string).autoCloseConfig.duration).toBe(7); // rounds up, never short
  });

  it("throws an UpstreamError carrying only the status on a non-2xx response", async () => {
    stubFetch(json({ error: "nope", echoed: "do-not-surface" }, 401));
    const err = await createRoom(env).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect((err as Error).message).toContain("401");
    expect((err as Error).message).not.toContain("do-not-surface");
  });

  it("throws when the response has no usable roomId", async () => {
    stubFetch(json({ roomId: "../evil" }));
    await expect(createRoom(env)).rejects.toBeInstanceOf(UpstreamError);
  });

  it("wraps a network failure", async () => {
    stubFetch(new TypeError("fetch failed"));
    await expect(createRoom(env)).rejects.toBeInstanceOf(UpstreamError);
  });
});

describe("dispatchAgent", () => {
  it("POSTs /v2/agent/dispatch with agentId, meetingId and the language metadata", async () => {
    const fetchMock = stubFetch(json({ success: true }));

    await dispatchAgent(env, "abcd-efgh-ijkl", "hi");

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toBe("https://api.example.test/v2/agent/dispatch");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      agentId: "agent-9",
      meetingId: "abcd-efgh-ijkl",
      metadata: { language: "hi" },
    });
    expect(init.headers.Authorization).not.toMatch(/^Bearer/i);
  });

  it("throws an UpstreamError on a non-2xx response", async () => {
    stubFetch(json({}, 500));
    await expect(dispatchAgent(env, "abcd-efgh-ijkl", "en")).rejects.toBeInstanceOf(UpstreamError);
  });
});
