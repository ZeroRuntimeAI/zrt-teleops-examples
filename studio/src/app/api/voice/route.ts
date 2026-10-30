import { isRecord, json, withEnv } from "../../../server/http";
import { getStore } from "../../../server/store";
import { dispatchAgent, isRoomId } from "../../../server/videosdk";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Below this much room lifetime left, an agent would barely get to speak: refuse instead of dispatching. */
const MIN_ROOM_LEFT_MS = 20_000;
const LANGUAGES = ["en", "hi"] as const;
type Language = (typeof LANGUAGES)[number];
const isLanguage = (value: unknown): value is Language => LANGUAGES.some((l) => l === value);

/** Dispatches the voice agent into a room this server issued, or queues the room when voice is at capacity. */
export function POST(req: Request): Promise<Response> {
  return withEnv("voice", async (env) => {
    // Before anything else: no slot, no dispatch, no store write for a service that has no agent.
    if (!env.voiceAgentId) return json({ error: "voice_unavailable" }, 503);

    const body: unknown = await req.json().catch(() => null);
    if (!isRecord(body)) return json({ error: "bad_request" }, 400);

    const { roomId, language = "en" } = body;
    if (!isRoomId(roomId)) return json({ error: "bad_room_id" }, 400);
    if (!isLanguage(language)) return json({ error: "bad_language" }, 400);

    const store = getStore(env);
    // Only rooms /api/session issued: otherwise this would dispatch agents into arbitrary rooms.
    const roomLeftMs = await store.roomTtlMs(roomId);
    if (roomLeftMs <= 0) return json({ error: "unknown_room" }, 404);
    if (roomLeftMs < MIN_ROOM_LEFT_MS) {
      // Also leaves the line, so a visitor whose session is ending cannot hold up the rooms behind.
      await store.releaseVoiceSlot(roomId);
      return json({ error: "session_ending" }, 409);
    }

    // The slot lasts as long as the room, never longer: a late grant must not hold capacity past its session.
    const slot = await store.acquireVoiceSlot(roomId, env.voiceMaxConcurrent, roomLeftMs / 1000);
    if (!slot.ok) return json({ status: "queued", position: slot.position }, 202);

    // A room that already holds its slot has its agent: a repeat call must not dispatch another.
    if (!slot.already) {
      try {
        await dispatchAgent(env, roomId, language);
      } catch (e) {
        // Free the slot, or a retry would find it held and report "dispatched" with no agent.
        await store.releaseVoiceSlot(roomId);
        throw e;
      }
    }
    return json({ status: "dispatched" });
  });
}
