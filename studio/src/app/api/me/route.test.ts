import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

const TOKEN = "dash.board-token_123";

const call = (cookie?: string) =>
  GET(new NextRequest("http://studio.test/api/me", cookie ? { headers: { cookie } } : undefined));
const userCookie = (value: unknown) => `user=${encodeURIComponent(JSON.stringify(value))}`;
const profile = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

let fetchMock: ReturnType<typeof vi.fn>;
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubEnv("ZERORUNTIME_API_KEY", "key-123");
  vi.stubEnv("ZERORUNTIME_SECRET", "s3cr3t");
  vi.stubEnv("STUDIO_VOICE_AGENT_ID", "agent-1");
  fetchMock = vi.fn(async () => profile({ name: "Ada" }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("GET /api/me", () => {
  it("is signed out without a cookie, and does not call the profile API", async () => {
    const res = await call();
    expect(await res.json()).toEqual({ signedIn: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["not json", "user=%7Bnope"],
    ["a JSON array", userCookie([1])],
    ["no accessToken", userCookie({ uid: "u1" })],
    ["an empty accessToken", userCookie({ accessToken: "", uid: "u1" })],
    ["a non-string accessToken", userCookie({ accessToken: 7, uid: "u1" })],
    ["a header-injecting accessToken", userCookie({ accessToken: "a\r\nX-Evil: 1", uid: "u1" })],
  ])("is signed out for a cookie with %s", async (_label, cookie) => {
    expect(await (await call(cookie)).json()).toEqual({ signedIn: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("works without a voice agent configured", async () => {
    vi.stubEnv("STUDIO_VOICE_AGENT_ID", "");
    const res = await call(userCookie({ accessToken: TOKEN, uid: "u1" }));
    expect(await res.json()).toEqual({ signedIn: true, name: "Ada" });
  });

  it("returns the profile name and sends the raw access token (no Bearer)", async () => {
    const res = await call(userCookie({ accessToken: TOKEN, uid: "u1" }));
    const text = await res.text();

    expect(JSON.parse(text)).toEqual({ signedIn: true, name: "Ada" });
    expect(text).not.toContain(TOKEN);
    expect(res.headers.get("cache-control")).toBe("no-store");

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { headers: Record<string, string> }];
    expect(url).toBe("https://api.videosdk.live/v1/users/profile");
    expect(init.headers.Authorization).toBe(TOKEN);
  });

  it("also accepts a cookie whose JSON is not URL-encoded", async () => {
    const res = await call(`user=${JSON.stringify({ accessToken: TOKEN, uid: "u1" })}`);
    expect(await res.json()).toEqual({ signedIn: true, name: "Ada" });
  });

  it("uses ZERORUNTIME_API_BASE", async () => {
    vi.stubEnv("ZERORUNTIME_API_BASE", "https://api.example.test");
    await call(userCookie({ accessToken: TOKEN, uid: "u1" }));
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.example.test/v1/users/profile");
  });

  it.each([
    ["a 401", () => profile({ name: "Ada" }, 401)],
    ["a 204", () => new Response(null, { status: 204 })],
    ["a missing name", () => profile({})],
    ["a blank name", () => profile({ name: "  " })],
    ["a non-string name", () => profile({ name: 5 })],
    ["a body that is not JSON", () => new Response("<html>", { status: 200 })],
  ])("is signed out on %s from the profile API", async (_label, make) => {
    fetchMock.mockResolvedValueOnce(make());
    const res = await call(userCookie({ accessToken: TOKEN, uid: "u1" }));
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ signedIn: false });
    expect(text).not.toContain(TOKEN);
  });

  it("is signed out when the profile call throws, and the log line carries no token", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError(`fetch failed for ${TOKEN}`));
    expect(await (await call(userCookie({ accessToken: TOKEN, uid: "u1" }))).json()).toEqual({ signedIn: false });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).not.toContain(TOKEN);
  });

  it("falls back to the customer name when the account has none", async () => {
    fetchMock.mockResolvedValueOnce(profile({ authResponse: { customer: { name: "Ada L" } } }));
    expect(await (await call(userCookie({ accessToken: TOKEN, uid: "u1" }))).json()).toEqual({ signedIn: true, name: "Ada L" });
  });

  it("trims and bounds the display name", async () => {
    fetchMock.mockResolvedValueOnce(profile({ name: `  ${"x".repeat(300)}  ` }));
    const body = await (await call(userCookie({ accessToken: TOKEN, uid: "u1" }))).json();
    expect(body.name).toBe("x".repeat(80));
  });

  it("answers 500 without a stack when the environment is invalid", async () => {
    vi.stubEnv("ZERORUNTIME_API_KEY", "");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await call(userCookie({ accessToken: TOKEN, uid: "u1" }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "server_misconfigured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
