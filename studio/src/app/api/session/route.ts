import { randomBytes } from "node:crypto";
import { SESSION_MARGIN_S } from "../../../server/env";
import { clientIp, json, withEnv } from "../../../server/http";
import { joinToken } from "../../../server/jwt";
import { getStore } from "../../../server/store";
import { createRoom } from "../../../server/videosdk";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const WINDOW_S = 3600;

/** Creates a fresh room and hands the visitor a join-only token that outlives the session cap by a margin. */
export function POST(req: Request): Promise<Response> {
  return withEnv("session", async (env) => {
    const store = getStore(env);

    // Window-aligned key, so the time left in the window is exact and goes back as `retryAfterS`.
    const nowS = Math.floor(Date.now() / 1000);
    const hits = await store.hit(`session:${clientIp(req, env.trustedProxyHops)}:${Math.floor(nowS / WINDOW_S)}`, WINDOW_S);
    if (hits > env.sessionsPerIpPerHour) {
      const retryAfterS = WINDOW_S - (nowS % WINDOW_S);
      return json({ error: "rate_limited", retryAfterS }, 429, { "Retry-After": String(retryAfterS) });
    }

    const roomId = await createRoom(env);
    await store.issueRoom(roomId, env.sessionSeconds + SESSION_MARGIN_S);
    const participantId = `studio-robot-${randomBytes(4).toString("hex")}`;

    return json({
      roomId,
      participantId,
      token: joinToken(env, env.sessionSeconds + SESSION_MARGIN_S, roomId, participantId),
      /** Whether `/api/voice` has an agent to dispatch: the client disables Voice without a speculative call. */
      voiceAvailable: env.voiceAgentId !== null,
      // Epoch ms. The client leaves the room at this time, before the token itself expires.
      expiresAt: Date.now() + env.sessionSeconds * 1000,
    });
  });
}
