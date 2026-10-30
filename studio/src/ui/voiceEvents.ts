/**
 * What the voice agent said and did, as one pure reducer. Events come from the `ROBOT_EVENTS`
 * pubsub topic (`parseRobotEvent`), the js-sdk agent participant, and the page's own steps.
 */

export const TRANSCRIPT_CAP = 100;
export const TOOLS_CAP = 20;

/** The longest each field from the room may be: anything more is cut, with an ellipsis. */
export const LIMITS = { text: 2000, name: 64, executor: 200, args: 200 } as const;
/** A `ROBOT_EVENTS` message longer than this is not parsed at all. */
const MAX_MESSAGE = 32_768;

/** `s` cut to `max` characters, the last one an ellipsis. */
function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export const AGENT_PHASES = ["idle", "listening", "thinking", "speaking"] as const;
export type AgentPhase = (typeof AGENT_PHASES)[number];
const isPhase = (s: unknown): s is AgentPhase => AGENT_PHASES.some((p) => p === s);

export type Who = "you" | "agent";
export type TranscriptRow = { who: Who; text: string; at?: number };
export type ToolRow = { name: string; ok?: boolean; executor?: string; args?: string };

export type VoiceState = {
  agent: "off" | "queued" | AgentPhase;
  /** Place in line while `queued`. */
  position?: number;
  transcript: TranscriptRow[];
  tools: ToolRow[];
};

export const initialVoice: VoiceState = { agent: "off", transcript: [], tools: [] };

export type VoiceEvent =
  | { t: "off" }
  | { t: "queued"; position: number }
  | { t: "dispatched" }
  | { t: "agent"; state: string }
  | { t: "say"; who: Who; text: string; at?: number }
  | { t: "tool"; name: string; ok?: boolean; args?: Record<string, unknown>; result?: Record<string, unknown> };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const BRIEF = { depth: 2, entries: 6, string: 60, key: 32 } as const;

/** One value for the one-line call, in bounded space whatever its shape: deep levels become `…`. */
function brief(v: unknown, depth: number): string {
  if (typeof v === "string") return JSON.stringify(clip(v, BRIEF.string));
  if (v === null || typeof v !== "object") return String(v);
  if (depth <= 0) return Array.isArray(v) ? "[…]" : "{…}";
  const more = (n: number) => (n > BRIEF.entries ? ", …" : "");
  if (Array.isArray(v)) return `[${v.slice(0, BRIEF.entries).map((x) => brief(x, depth - 1)).join(", ")}${more(v.length)}]`;
  const entries = Object.entries(v);
  return `{${entries.slice(0, BRIEF.entries).map(([k, x]) => `${clip(k, BRIEF.key)}: ${brief(x, depth - 1)}`).join(", ")}${more(entries.length)}}`;
}

/** `item="yellow", n=2`: the call's arguments the way the mockup shows them, at most `LIMITS.args` long. */
function formatArgs(args: Record<string, unknown> | undefined): string | undefined {
  if (!args) return undefined;
  const entries = Object.entries(args);
  if (!entries.length) return undefined;
  const parts = entries.slice(0, 8).map(([k, v]) => `${clip(k, BRIEF.key)}=${brief(v, BRIEF.depth)}`);
  return clip(parts.join(", ") + (entries.length > 8 ? ", …" : ""), LIMITS.args);
}

const sameLine = (a: string, b: string) => a.toLowerCase().replace(/[\s.,!?]+/g, " ").trim() === b.toLowerCase().replace(/[\s.,!?]+/g, " ").trim();

/** Both the room event and the SDK transcript report what was said: a repeat of the speaker's last line is dropped. */
// ponytail: a speaker who really says the same thing twice in a row loses the second; fine for a transcript.
function say(rows: TranscriptRow[], row: TranscriptRow): TranscriptRow[] {
  if (typeof row.text !== "string") return rows;
  const text = clip(row.text.trim(), LIMITS.text);
  if (!text) return rows;
  const last = rows.findLast((r) => r.who === row.who);
  if (last && sameLine(last.text, text)) return rows;
  return [...rows, { ...row, text }].slice(-TRANSCRIPT_CAP);
}

export function reduceVoice(state: VoiceState, e: VoiceEvent): VoiceState {
  switch (e.t) {
    case "off":
      return { ...state, agent: "off", position: undefined };
    case "queued":
      return { ...state, agent: "queued", position: e.position };
    case "dispatched":
      return state.agent === "off" || state.agent === "queued" ? { ...state, agent: "idle", position: undefined } : state;
    case "agent":
      // An agent from an earlier turn of Voice must not light up a switch that is off or still waiting.
      return isPhase(e.state) && state.agent !== "off" && state.agent !== "queued" ? { ...state, agent: e.state } : state;
    case "say":
      return { ...state, transcript: say(state.transcript, { who: e.who, text: e.text, at: e.at }) };
    case "tool": {
      if (typeof e.name !== "string") return state;
      const executor = e.result?.executor;
      const row: ToolRow = {
        name: clip(e.name, LIMITS.name),
        ok: e.ok,
        args: formatArgs(e.args),
        ...(typeof executor === "string" ? { executor: clip(executor, LIMITS.executor) } : {}),
      };
      return { ...state, tools: [...state.tools, row].slice(-TOOLS_CAP) };
    }
  }
}

/** A `ROBOT_EVENTS` message as a voice event; null for robot-state summaries and anything malformed. */
export function parseRobotEvent(message: string): VoiceEvent | null {
  if (typeof message !== "string" || message.length > MAX_MESSAGE) return null;
  let m: unknown;
  try {
    m = JSON.parse(message);
  } catch {
    return null;
  }
  if (!isRecord(m)) return null;
  switch (m.t) {
    case "heard":
      return typeof m.text === "string" ? { t: "say", who: "you", text: m.text } : null;
    case "agent":
      return typeof m.state === "string" ? { t: "agent", state: m.state } : null;
    case "tool":
      if (typeof m.name !== "string") return null;
      return {
        t: "tool",
        name: m.name,
        ok: typeof m.ok === "boolean" ? m.ok : undefined,
        args: isRecord(m.args) ? m.args : undefined,
        result: isRecord(m.result) ? m.result : undefined,
      };
    default:
      return null;
  }
}

/**
 * A `ROBOT_EVENTS` message, believed only when it comes from the room's agent participant. Anyone in
 * the room can publish on the topic, so before the agent is known (`agentId` null) nothing is.
 */
export function acceptRobotEvent(message: string, from: string, agentId: string | null): VoiceEvent | null {
  return agentId !== null && from === agentId ? parseRobotEvent(message) : null;
}
