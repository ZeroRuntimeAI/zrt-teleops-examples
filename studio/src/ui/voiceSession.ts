/**
 * Turning Voice on, without React: ask for an agent, wait in line, open the mic, hand control
 * over. Everything it touches is passed in, so the polling can be tested step by step.
 */
import type { LogEvent } from "./ActivityLog";
import type { VoiceEvent } from "./voiceEvents";

export type Language = "en" | "hi";
/** The server drops a waiter it has not heard from for 30 s. */
export const POLL_MS = 5_000;
/** A failed poll while queued is tried again this many times, in a row, before the place is given up. */
export const POLL_RETRIES = 2;

export type Reply =
  | { kind: "dispatched" }
  | { kind: "queued"; position: number }
  | { kind: "ending" }
  /** No voice agent is configured on the server (503 `voice_unavailable`): not an error, Voice just isn't offered. */
  | { kind: "unavailable" }
  /** `transient`: the server was unreachable or erred, so asking again may work. */
  | { kind: "failed"; why: string; transient: boolean };

/** One `POST /api/voice`. Rejects only when `signal` aborts it. */
export async function postVoice(roomId: string, language: Language, signal: AbortSignal): Promise<Reply> {
  let res: Response;
  try {
    res = await fetch("/api/voice", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ roomId, language }), signal });
  } catch (e) {
    if (signal.aborted) throw e;
    return { kind: "failed", why: "couldn't reach the server", transient: true };
  }
  const body: Record<string, unknown> = await res.json().catch(() => ({}));
  if (res.status === 409) return { kind: "ending" };
  if (res.status === 503 && body.error === "voice_unavailable") return { kind: "unavailable" };
  if (res.status === 202 && typeof body.position === "number") return { kind: "queued", position: body.position };
  if (res.ok && body.status === "dispatched") return { kind: "dispatched" };
  const why = typeof body.error === "string" ? body.error.replace(/_/g, " ") : `HTTP ${res.status}`;
  return { kind: "failed", why, transient: res.status >= 500 };
}

/** Resolves after `ms`, or at once when `signal` aborts. */
export const pause = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const id = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(id), resolve()), { once: true });
  });

export type VoiceDeps = {
  request(signal: AbortSignal): Promise<Reply>;
  pause(ms: number, signal: AbortSignal): Promise<void>;
  enableMic(on: boolean): Promise<void>;
  handBack(): void;
  dispatch(e: VoiceEvent): void;
  note(e: LogEvent): void;
  setError(message: string | undefined): void;
  /** The voice service says the room is ending: so is the session. */
  end(): void;
  /** The server has no voice agent: the page stops offering Voice. */
  unavailable(): void;
  /** Poll interval, for tests; `POLL_MS` by default. */
  pollMs?: number;
};

const unavailable = (why: string) => `Voice isn't available right now (${why}).`;
const MIC_DENIED = "Voice needs the microphone. Allow it in the browser, then turn Voice on again.";

/** At most one request-and-poll chain runs at a time; `stop` ends it, and a stale chain cannot act after that. */
export class VoiceLifecycle {
  private pending: AbortController | null = null;

  get busy(): boolean {
    return this.pending !== null;
  }

  /** Abort the chain in flight, if any. */
  stop(): void {
    this.pending?.abort();
    this.pending = null;
  }

  async start(d: VoiceDeps): Promise<void> {
    if (this.pending) return;
    const abort = new AbortController();
    const { signal } = abort;
    this.pending = abort;
    d.setError(undefined);
    const finish = () => {
      if (this.pending === abort) this.pending = null;
    };
    const fail = (why: string) => {
      if (signal.aborted) return;
      finish();
      d.setError(why);
      d.dispatch({ t: "off" });
    };
    const pollMs = d.pollMs ?? POLL_MS;
    try {
      let line = -1;
      let retries = 0;
      for (;;) {
        const reply = await d.request(signal);
        if (signal.aborted) return;
        if (reply.kind === "dispatched") break;
        if (reply.kind === "ending") {
          finish();
          d.dispatch({ t: "off" });
          return d.end();
        }
        if (reply.kind === "unavailable") {
          finish();
          d.dispatch({ t: "off" });
          return d.unavailable();
        }
        if (reply.kind === "failed") {
          // Only a poll for a place already held is worth repeating; a first request tells the visitor at once.
          if (!reply.transient || line < 0 || retries >= POLL_RETRIES) return fail(unavailable(reply.why));
          retries += 1;
        } else {
          retries = 0;
          d.dispatch({ t: "queued", position: reply.position });
          if (reply.position !== line) d.note({ op: "app", what: "voice", step: "queued", position: reply.position });
          line = reply.position;
        }
        await d.pause(pollMs, signal);
        if (signal.aborted) return;
      }
      d.dispatch({ t: "dispatched" });
      d.note({ op: "app", what: "voice", step: "dispatched" });
      try {
        await d.enableMic(true);
      } catch {
        return fail(MIC_DENIED);
      }
      if (signal.aborted) return void d.enableMic(false).catch(() => {}); // Switched off while the mic was opening.
      d.handBack();
      finish();
    } catch (e) {
      fail(unavailable(e instanceof Error ? e.message : String(e)));
    }
  }
}
