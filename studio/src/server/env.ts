/** Server configuration. Read per request, so a bad deploy fails with a clear error instead of at import time. */
export interface StudioEnv {
  apiKey: string;
  secret: string;
  /** Absent: Voice is off (`/api/voice` answers 503, `/api/session` says `voiceAvailable: false`). */
  voiceAgentId: string | null;
  /** No trailing slash. */
  apiBase: string;
  /** Absent: the in-memory store is used (one process only). */
  redisUrl?: string;
  sessionSeconds: number;
  voiceMaxConcurrent: number;
  sessionsPerIpPerHour: number;
  /** How many reverse proxies in front of Studio append to `x-forwarded-for`: the client is that many entries from the end. */
  trustedProxyHops: number;
}

/** How long past the session cap a join token, an issued room and a voice slot stay valid. */
export const SESSION_MARGIN_S = 60;

const REQUIRED = {
  apiKey: "ZERORUNTIME_API_KEY",
  secret: "ZERORUNTIME_SECRET",
} as const;

const DEFAULT_API_BASE = "https://api.videosdk.live";
const DEFAULT_SESSION_SECONDS = 300;
const DEFAULT_VOICE_MAX_CONCURRENT = 5;
const DEFAULT_SESSIONS_PER_IP_PER_HOUR = 10;
const DEFAULT_TRUSTED_PROXY_HOPS = 1;

const value = (source: Record<string, string | undefined>, name: string) => source[name]?.trim() || undefined;

/**
 * Reads and validates the environment. Throws one error naming every missing or invalid variable;
 * the message carries variable names only, never values.
 */
export function readEnv(source: Record<string, string | undefined> = process.env): StudioEnv {
  const problems: string[] = [];

  const missing = Object.values(REQUIRED).filter((name) => !value(source, name));
  if (missing.length) problems.push(`missing ${missing.join(", ")}`);

  const invalid: string[] = [];
  const positiveInt = (name: string, fallback: number) => {
    const raw = value(source, name);
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (!Number.isSafeInteger(n) || n < 1) invalid.push(name);
    return n;
  };
  const sessionSeconds = positiveInt("STUDIO_SESSION_SECONDS", DEFAULT_SESSION_SECONDS);
  const voiceMaxConcurrent = positiveInt("STUDIO_VOICE_MAX_CONCURRENT", DEFAULT_VOICE_MAX_CONCURRENT);
  const sessionsPerIpPerHour = positiveInt("STUDIO_SESSIONS_PER_IP_PER_HOUR", DEFAULT_SESSIONS_PER_IP_PER_HOUR);
  const trustedProxyHops = positiveInt("STUDIO_TRUSTED_PROXY_HOPS", DEFAULT_TRUSTED_PROXY_HOPS);

  const apiBase = (value(source, "ZERORUNTIME_API_BASE") ?? DEFAULT_API_BASE).replace(/\/+$/, "");
  if (!/^https?:\/\/[^\s/]+/.test(apiBase)) invalid.push("ZERORUNTIME_API_BASE");

  if (invalid.length) problems.push(`invalid ${invalid.join(", ")}`);
  if (problems.length) throw new Error(`Invalid Studio environment: ${problems.join("; ")}`);

  return {
    apiKey: value(source, REQUIRED.apiKey)!,
    secret: value(source, REQUIRED.secret)!,
    voiceAgentId: value(source, "STUDIO_VOICE_AGENT_ID") ?? null,
    apiBase,
    redisUrl: value(source, "REDIS_URL"),
    sessionSeconds,
    voiceMaxConcurrent,
    sessionsPerIpPerHour,
    trustedProxyHops,
  };
}
