import { SESSION_MARGIN_S, type StudioEnv } from "./env";
import { serverToken } from "./jwt";

/** A VideoSDK call failed. The message carries the call and the HTTP status only, never a body or a token. */
export class UpstreamError extends Error {
  name = "UpstreamError";
}

/** Room ids are `xxxx-xxxx-xxxx` from nanoid. This only bounds charset and length; the issued-room check does the gating. */
export const isRoomId = (value: unknown): value is string => typeof value === "string" && /^[\w-]{1,64}$/.test(value);

const ROOM_TIMEOUT_MS = 10_000;
// Dispatch waits on the agent registry, which can take 15 s or more.
const DISPATCH_TIMEOUT_MS = 30_000;

async function post(env: StudioEnv, what: string, path: string, body: unknown, timeoutMs: number): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${env.apiBase}${path}`, {
      method: "POST",
      // The raw token, no "Bearer": that is what api.videosdk.live expects.
      headers: { Authorization: serverToken(env), "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
  } catch (e) {
    throw new UpstreamError(`${what}: request failed (${e instanceof Error ? e.name : "error"})`);
  }
  if (!res.ok) throw new UpstreamError(`${what}: HTTP ${res.status}`);
  return res.json().catch(() => null);
}

/**
 * The room's server-side lifetime, so the session cap holds even against a client that ignores its
 * timer. `duration` is whole MINUTES, a positive integer (VideoSDK's validateAutoCloseConfig: `type`
 * is "session-ends" | "session-end-and-deactivate", `duration` a positive integer no larger than the
 * account's session maximum; the media server reads it as `autoCloseDuration` in minutes).
 * Deactivate: a Studio room is single-use, so it must not reopen after it closes.
 */
const autoCloseConfig = (env: StudioEnv) => ({
  type: "session-end-and-deactivate",
  duration: Math.ceil((env.sessionSeconds + SESSION_MARGIN_S) / 60),
});

/** Creates an empty room with server credentials and a server-side lifetime, and returns its id. */
export async function createRoom(env: StudioEnv): Promise<string> {
  const body = { autoCloseConfig: autoCloseConfig(env) };
  const room = (await post(env, "createRoom", "/v2/rooms", body, ROOM_TIMEOUT_MS)) as { roomId?: unknown } | null;
  if (!isRoomId(room?.roomId)) throw new UpstreamError("createRoom: response had no usable roomId");
  return room.roomId;
}

/** Asks the voice agent to join `roomId`. */
export async function dispatchAgent(env: StudioEnv, roomId: string, language: "en" | "hi"): Promise<void> {
  await post(
    env,
    "dispatchAgent",
    "/v2/agent/dispatch",
    { agentId: env.voiceAgentId, meetingId: roomId, metadata: { language } },
    DISPATCH_TIMEOUT_MS,
  );
}
