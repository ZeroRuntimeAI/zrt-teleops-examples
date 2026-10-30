import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { StudioEnv } from "./env";
import { joinToken, serverToken, signHs256 } from "./jwt";

const SECRET = "unit-test-secret";
const env: StudioEnv = {
  apiKey: "key-123",
  secret: SECRET,
  voiceAgentId: "agent-1",
  apiBase: "https://api.example.test",
  sessionSeconds: 300,
  voiceMaxConcurrent: 5,
  sessionsPerIpPerHour: 10,
  trustedProxyHops: 1,
};

const decode = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;

describe("signHs256", () => {
  it("produces a JWT whose signature is HMAC-SHA256 over header.payload", () => {
    const token = signHs256({ hello: "world" }, SECRET);
    const [header, payload, signature] = token.split(".");

    expect(decode(header)).toEqual({ alg: "HS256", typ: "JWT" });
    expect(decode(payload)).toEqual({ hello: "world" });
    const expected = createHmac("sha256", SECRET).update(`${header}.${payload}`).digest("base64url");
    expect(signature).toBe(expected);
  });

  it("changes the signature when the secret changes", () => {
    expect(signHs256({ a: 1 }, "one").split(".")[2]).not.toBe(signHs256({ a: 1 }, "two").split(".")[2]);
  });
});

describe("joinToken", () => {
  it("is a join-only v2 rtc token bound to one room and participant, living exactly ttlS seconds", () => {
    const [, payload] = joinToken(env, 360, "abcd-efgh-ijkl", "studio-robot-0a1b2c3d").split(".");
    const claims = decode(payload);

    expect(claims).toEqual({
      apikey: "key-123",
      permissions: ["allow_join"],
      version: 2,
      roles: ["rtc"],
      roomId: "abcd-efgh-ijkl",
      participantId: "studio-robot-0a1b2c3d",
      iat: expect.any(Number),
      exp: expect.any(Number),
    });
    expect((claims.exp as number) - (claims.iat as number)).toBe(360);
  });

  it("verifies against the account secret", () => {
    const [header, payload, signature] = joinToken(env, 360, "abcd-efgh-ijkl", "studio-robot-0a1b2c3d").split(".");
    expect(signature).toBe(createHmac("sha256", SECRET).update(`${header}.${payload}`).digest("base64url"));
  });
});

describe("serverToken", () => {
  it("can join and moderate and expires within a minute", () => {
    const claims = decode(serverToken(env).split(".")[1]);
    const now = Math.floor(Date.now() / 1000);

    expect(claims.permissions).toEqual(["allow_join", "allow_mod"]);
    expect(claims.apikey).toBe("key-123");
    expect(claims.exp as number).toBeGreaterThanOrEqual(now + 59);
    expect(claims.exp as number).toBeLessThanOrEqual(now + 61);
  });
});
