import { createHmac } from "node:crypto";
import type { StudioEnv } from "./env";

const SERVER_TOKEN_TTL_S = 60;

/** HS256 JWT with node:crypto only. VideoSDK accepts the same token shape as zujonow-api-server's onboardingToken. */
export function signHs256(payload: object, secret: string): string {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${part({ alg: "HS256", typ: "JWT" })}.${part(payload)}`;
  return `${unsigned}.${createHmac("sha256", secret).update(unsigned).digest("base64url")}`;
}

const nowS = () => Math.floor(Date.now() / 1000);

/**
 * The visitor's token: join-only, `ttlS` seconds long, and bound to one room and participant. A version 2
 * `rtc` token is checked by the signalling manager against the room and participant it joins (a different
 * one is refused), and the REST API refuses `rtc` tokens, so a leaked token cannot join any other room
 * under this account or call the API.
 */
export function joinToken(env: StudioEnv, ttlS: number, roomId: string, participantId: string): string {
  const iat = nowS();
  return signHs256(
    {
      apikey: env.apiKey,
      permissions: ["allow_join"],
      version: 2,
      roles: ["rtc"],
      roomId,
      participantId,
      iat,
      exp: iat + ttlS,
    },
    env.secret,
  );
}

/** Server-to-API token for room creation and agent dispatch. Never leaves the server. */
export function serverToken(env: StudioEnv): string {
  const iat = nowS();
  return signHs256(
    { apikey: env.apiKey, permissions: ["allow_join", "allow_mod"], iat, exp: iat + SERVER_TOKEN_TTL_S },
    env.secret,
  );
}
