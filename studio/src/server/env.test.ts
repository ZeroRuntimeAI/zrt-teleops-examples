import { describe, expect, it } from "vitest";
import { readEnv } from "./env";

const required = { ZERORUNTIME_API_KEY: "k", ZERORUNTIME_SECRET: "s", STUDIO_VOICE_AGENT_ID: "a" };

describe("readEnv", () => {
  it("names every missing required variable in one error", () => {
    expect(() => readEnv({ STUDIO_VOICE_AGENT_ID: "a" })).toThrowError(/ZERORUNTIME_API_KEY.*ZERORUNTIME_SECRET/);
  });

  it("treats blank values as missing", () => {
    expect(() => readEnv({ ...required, ZERORUNTIME_SECRET: "   " })).toThrowError(/ZERORUNTIME_SECRET/);
  });

  it("treats STUDIO_VOICE_AGENT_ID as optional: absent or blank is null, not an error", () => {
    const withoutAgent = { ZERORUNTIME_API_KEY: "k", ZERORUNTIME_SECRET: "s" };
    expect(readEnv(withoutAgent).voiceAgentId).toBeNull();
    expect(readEnv({ ...withoutAgent, STUDIO_VOICE_AGENT_ID: "  " }).voiceAgentId).toBeNull();
  });

  it("applies the documented defaults", () => {
    expect(readEnv(required)).toEqual({
      apiKey: "k",
      secret: "s",
      voiceAgentId: "a",
      apiBase: "https://api.videosdk.live",
      redisUrl: undefined,
      sessionSeconds: 300,
      voiceMaxConcurrent: 5,
      sessionsPerIpPerHour: 10,
      trustedProxyHops: 1,
    });
  });

  it("reads overrides and strips a trailing slash from the API base", () => {
    const env = readEnv({
      ...required,
      ZERORUNTIME_API_BASE: "https://api.example.test/",
      REDIS_URL: "redis://cache:6379",
      STUDIO_SESSION_SECONDS: "120",
      STUDIO_VOICE_MAX_CONCURRENT: "2",
      STUDIO_SESSIONS_PER_IP_PER_HOUR: "3",
      STUDIO_TRUSTED_PROXY_HOPS: "2",
    });

    expect(env).toMatchObject({
      apiBase: "https://api.example.test",
      redisUrl: "redis://cache:6379",
      sessionSeconds: 120,
      voiceMaxConcurrent: 2,
      sessionsPerIpPerHour: 3,
      trustedProxyHops: 2,
    });
  });

  it.each(["abc", "0", "-5", "1.5"])("rejects %s as a numeric setting and names the variable, not the value", (bad) => {
    expect(() => readEnv({ ...required, STUDIO_SESSION_SECONDS: bad })).toThrowError(/STUDIO_SESSION_SECONDS/);
  });

  it.each(["0", "-1", "two", "1.5"])("rejects STUDIO_TRUSTED_PROXY_HOPS=%s and names the variable", (bad) => {
    expect(() => readEnv({ ...required, STUDIO_TRUSTED_PROXY_HOPS: bad })).toThrowError(/STUDIO_TRUSTED_PROXY_HOPS/);
  });

  it("rejects an API base that is not an http(s) URL", () => {
    expect(() => readEnv({ ...required, ZERORUNTIME_API_BASE: "ftp://x" })).toThrowError(/ZERORUNTIME_API_BASE/);
  });

  it("never puts a secret value in the error", () => {
    expect(() => readEnv({ ZERORUNTIME_SECRET: "super-secret-value" })).toThrowError(/ZERORUNTIME_API_KEY/);
    try {
      readEnv({ ZERORUNTIME_SECRET: "super-secret-value" });
    } catch (e) {
      expect((e as Error).message).not.toContain("super-secret-value");
    }
  });
});
