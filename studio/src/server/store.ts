import { Redis } from "ioredis";
import type { StudioEnv } from "./env";

export type VoiceSlot =
  /** `already` is set when this room held its slot before the call: do not dispatch a second agent. */
  | { ok: true; already?: true }
  /** `position` is the room's 1-based place in the waiting line. */
  | { ok: false; position: number };

/** Rate-limit counters, the rooms this server issued, and the voice-session slots with their waiting line. */
export interface StudioStore {
  /** Fixed-window counter: returns the hit count for `key` in the window that its first hit opened. */
  hit(key: string, windowS: number): Promise<number>;
  issueRoom(roomId: string, ttlS: number): Promise<void>;
  hasRoom(roomId: string): Promise<boolean>;
  /** Milliseconds until an issued room expires; 0 for a room this server did not issue (or one that has expired). */
  roomTtlMs(roomId: string): Promise<number>;
  /**
   * Takes one of `max` voice slots for `ttlS` seconds, or joins the line. Calling again for a queued room
   * is the poll: it keeps the room's place, and a slot goes to the head of the line first.
   */
  acquireVoiceSlot(roomId: string, max: number, ttlS: number): Promise<VoiceSlot>;
  /** Frees the slot (or the place in line) early, e.g. when the dispatch failed. */
  releaseVoiceSlot(roomId: string): Promise<void>;
}

/** A queued room that has not polled for this long is dropped, so a closed tab cannot block the line. */
export const WAIT_STALE_S = 30;

const MS = 1000;

export class MemoryStore implements StudioStore {
  private counters = new Map<string, { n: number; resetAt: number }>();
  private rooms = new Map<string, number>();
  private active = new Map<string, number>();
  /** Insertion order is the line. `set` on an existing key refreshes `seen` and keeps the place. */
  private waiting = new Map<string, number>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  async hit(key: string, windowS: number): Promise<number> {
    const now = this.now();
    // ponytail: sweeps are O(n) per call; fine for a single-process dev/test store, which is all this is for.
    for (const [k, c] of this.counters) if (c.resetAt <= now) this.counters.delete(k);
    const current = this.counters.get(key);
    const next = { n: (current?.n ?? 0) + 1, resetAt: current?.resetAt ?? now + windowS * MS };
    this.counters.set(key, next);
    return next.n;
  }

  async issueRoom(roomId: string, ttlS: number): Promise<void> {
    const now = this.now();
    for (const [id, expiresAt] of this.rooms) if (expiresAt <= now) this.rooms.delete(id);
    this.rooms.set(roomId, now + ttlS * MS);
  }

  async hasRoom(roomId: string): Promise<boolean> {
    return (await this.roomTtlMs(roomId)) > 0;
  }

  async roomTtlMs(roomId: string): Promise<number> {
    return Math.max(0, (this.rooms.get(roomId) ?? 0) - this.now());
  }

  async acquireVoiceSlot(roomId: string, max: number, ttlS: number): Promise<VoiceSlot> {
    const now = this.now();
    for (const [id, expiresAt] of this.active) if (expiresAt <= now) this.active.delete(id);
    for (const [id, seen] of this.waiting) if (now - seen > WAIT_STALE_S * MS) this.waiting.delete(id);

    if (this.active.has(roomId)) return { ok: true, already: true };

    this.waiting.set(roomId, now);
    const rank = [...this.waiting.keys()].indexOf(roomId);
    if (rank < max - this.active.size) {
      this.waiting.delete(roomId);
      this.active.set(roomId, now + ttlS * MS);
      return { ok: true };
    }
    return { ok: false, position: rank + 1 };
  }

  async releaseVoiceSlot(roomId: string): Promise<void> {
    this.active.delete(roomId);
    this.waiting.delete(roomId);
  }
}

/** Atomic fixed-window counter: the window opens with the first hit and the key always gets its TTL. */
const HIT_LUA = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return n`;

/**
 * Same rules as MemoryStore.acquireVoiceSlot, in one atomic script.
 * KEYS: active (score = slot expiry ms), wait (score = place in line), seen (score = last poll ms).
 * ARGV: roomId, max, slot ttl ms, stale ms. Returns {1, 0} granted, {1, 1} already held, {0, position} queued.
 */
const ACQUIRE_LUA = `
local t = redis.call('TIME')
local now = t[1] * 1000 + math.floor(t[2] / 1000)
local room, max, ttl, stale = ARGV[1], tonumber(ARGV[2]), tonumber(ARGV[3]), tonumber(ARGV[4])

redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
for _, id in ipairs(redis.call('ZRANGEBYSCORE', KEYS[3], '-inf', now - stale - 1)) do
  redis.call('ZREM', KEYS[2], id)
  redis.call('ZREM', KEYS[3], id)
end

if redis.call('ZSCORE', KEYS[1], room) then return {1, 1} end

local last = redis.call('ZREVRANGE', KEYS[2], 0, 0, 'WITHSCORES')
local place = now
if last[2] and tonumber(last[2]) >= now then place = tonumber(last[2]) + 1 end
redis.call('ZADD', KEYS[2], 'NX', place, room)
redis.call('ZADD', KEYS[3], now, room)

local rank = redis.call('ZRANK', KEYS[2], room)
if rank < max - redis.call('ZCARD', KEYS[1]) then
  redis.call('ZREM', KEYS[2], room)
  redis.call('ZREM', KEYS[3], room)
  redis.call('ZADD', KEYS[1], now + ttl, room)
  return {1, 0}
end
return {0, rank + 1}`;

export class RedisStore implements StudioStore {
  constructor(
    private readonly redis: Redis,
    private readonly prefix = "studio:",
  ) {}

  private voiceKeys() {
    return [`${this.prefix}voice:active`, `${this.prefix}voice:wait`, `${this.prefix}voice:seen`] as const;
  }

  async hit(key: string, windowS: number): Promise<number> {
    return Number(await this.redis.eval(HIT_LUA, 1, `${this.prefix}hit:${key}`, windowS));
  }

  async issueRoom(roomId: string, ttlS: number): Promise<void> {
    await this.redis.set(`${this.prefix}room:${roomId}`, "1", "EX", ttlS);
  }

  async hasRoom(roomId: string): Promise<boolean> {
    return (await this.redis.exists(`${this.prefix}room:${roomId}`)) === 1;
  }

  async roomTtlMs(roomId: string): Promise<number> {
    // PTTL: -2 for no such key, -1 for a key without expiry; neither is an issued room.
    return Math.max(0, await this.redis.pttl(`${this.prefix}room:${roomId}`));
  }

  async acquireVoiceSlot(roomId: string, max: number, ttlS: number): Promise<VoiceSlot> {
    const [granted, extra] = (await this.redis.eval(
      ACQUIRE_LUA,
      3,
      ...this.voiceKeys(),
      roomId,
      max,
      Math.round(ttlS * MS),
      WAIT_STALE_S * MS,
    )) as [number, number];
    if (granted === 1) return extra === 1 ? { ok: true, already: true } : { ok: true };
    return { ok: false, position: extra };
  }

  async releaseVoiceSlot(roomId: string): Promise<void> {
    await Promise.all(this.voiceKeys().map((key) => this.redis.zrem(key, roomId)));
  }
}

const STORE_KEY = Symbol.for("zeroruntime.studio.store");
type StoreHolder = typeof globalThis & { [STORE_KEY]?: StudioStore };

function createStore(env: StudioEnv): StudioStore {
  if (!env.redisUrl) {
    if (process.env.NODE_ENV === "production") {
      console.warn(
        "[studio] REDIS_URL is not set: rate limits and the voice queue are per process and reset on restart. Set REDIS_URL to run more than one replica.",
      );
    }
    return new MemoryStore();
  }
  // Fail a request fast when Redis is down instead of queueing commands for minutes.
  const redis = new Redis(env.redisUrl, { maxRetriesPerRequest: 1, connectTimeout: 5000 });
  redis.on("error", (e: Error) => console.error(`[studio] redis: ${e.message}`));
  return new RedisStore(redis);
}

/** One store per process, on `globalThis` so Next's per-route module instances and dev reloads share it. */
export function getStore(env: StudioEnv): StudioStore {
  const holder = globalThis as StoreHolder;
  return (holder[STORE_KEY] ??= createStore(env));
}

export function resetStoreForTests(): void {
  delete (globalThis as StoreHolder)[STORE_KEY];
}
