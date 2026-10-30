import { Redis } from "ioredis";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { readEnv } from "./env";
import { getStore, MemoryStore, RedisStore, resetStoreForTests, type StudioStore, WAIT_STALE_S } from "./store";

const REDIS_URL = process.env.STUDIO_TEST_REDIS_URL;
const redis = REDIS_URL ? new Redis(REDIS_URL) : null;
afterAll(async () => {
  await redis?.quit();
});

type Factory = () => StudioStore;
const factories: [string, Factory][] = [["MemoryStore", () => new MemoryStore()]];
// Runs the same contract against a real Redis when STUDIO_TEST_REDIS_URL is set; each run gets its own key prefix.
if (redis) factories.push(["RedisStore", () => new RedisStore(redis, `studio-test:${crypto.randomUUID()}:`)]);

describe.each(factories)("%s contract", (_name, make) => {
  it("hit counts up per key inside one window", async () => {
    const store = make();
    expect(await store.hit("a", 60)).toBe(1);
    expect(await store.hit("a", 60)).toBe(2);
    expect(await store.hit("a", 60)).toBe(3);
    expect(await store.hit("b", 60)).toBe(1);
  });

  it("only knows rooms it issued", async () => {
    const store = make();
    expect(await store.hasRoom("abcd-efgh-ijkl")).toBe(false);
    await store.issueRoom("abcd-efgh-ijkl", 60);
    expect(await store.hasRoom("abcd-efgh-ijkl")).toBe(true);
    expect(await store.hasRoom("other-room-xxxx")).toBe(false);
  });

  it("reports the remaining lifetime of an issued room, and 0 for an unknown one", async () => {
    const store = make();
    expect(await store.roomTtlMs("nope")).toBe(0);
    await store.issueRoom("abcd-efgh-ijkl", 60);
    const left = await store.roomTtlMs("abcd-efgh-ijkl");
    expect(left).toBeGreaterThan(55_000);
    expect(left).toBeLessThanOrEqual(60_000);
  });

  it("grants slots up to max, then queues with a stable 1-based position", async () => {
    const store = make();
    expect(await store.acquireVoiceSlot("a", 2, 60)).toEqual({ ok: true });
    expect(await store.acquireVoiceSlot("b", 2, 60)).toEqual({ ok: true });
    expect(await store.acquireVoiceSlot("c", 2, 60)).toEqual({ ok: false, position: 1 });
    expect(await store.acquireVoiceSlot("d", 2, 60)).toEqual({ ok: false, position: 2 });
    expect(await store.acquireVoiceSlot("c", 2, 60)).toEqual({ ok: false, position: 1 });
  });

  it("is idempotent for a room that already holds a slot", async () => {
    const store = make();
    expect(await store.acquireVoiceSlot("a", 1, 60)).toEqual({ ok: true });
    expect(await store.acquireVoiceSlot("a", 1, 60)).toEqual({ ok: true, already: true });
  });

  it("hands a released slot to the head of the queue, not to a later arrival", async () => {
    const store = make();
    await store.acquireVoiceSlot("a", 1, 60);
    expect(await store.acquireVoiceSlot("c", 1, 60)).toEqual({ ok: false, position: 1 });
    expect(await store.acquireVoiceSlot("d", 1, 60)).toEqual({ ok: false, position: 2 });

    await store.releaseVoiceSlot("a");
    expect(await store.acquireVoiceSlot("d", 1, 60)).toEqual({ ok: false, position: 2 });
    expect(await store.acquireVoiceSlot("c", 1, 60)).toEqual({ ok: true });
    expect(await store.acquireVoiceSlot("d", 1, 60)).toEqual({ ok: false, position: 1 });
  });

  it("lets a fresh room take a freed slot when nobody is queued", async () => {
    const store = make();
    await store.acquireVoiceSlot("a", 1, 60);
    await store.releaseVoiceSlot("a");
    expect(await store.acquireVoiceSlot("b", 1, 60)).toEqual({ ok: true });
  });

  it("drops a queued room that is released", async () => {
    const store = make();
    await store.acquireVoiceSlot("a", 1, 60);
    await store.acquireVoiceSlot("b", 1, 60);
    await store.releaseVoiceSlot("b");
    expect(await store.acquireVoiceSlot("c", 1, 60)).toEqual({ ok: false, position: 1 });
  });
});

describe.skipIf(!redis)("RedisStore against a real Redis", () => {
  const fresh = () => {
    const prefix = `studio-test:${crypto.randomUUID()}:`;
    return { prefix, store: new RedisStore(redis!, prefix) };
  };

  it("gives the counter key a TTL on its first hit", async () => {
    const { prefix, store } = fresh();
    await store.hit("k", 60);
    const ttl = await redis!.ttl(`${prefix}hit:k`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60);
  });

  it("never grants more than max slots under concurrent calls, and queues the rest in distinct places", async () => {
    const { store } = fresh();
    const results = await Promise.all(Array.from({ length: 30 }, (_, i) => store.acquireVoiceSlot(`room-${i}`, 5, 60)));

    expect(results.filter((r) => r.ok)).toHaveLength(5);
    const positions = results.flatMap((r) => (r.ok ? [] : [r.position])).sort((a, b) => a - b);
    expect(positions).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
  });

  it("drops a waiter that stopped polling", async () => {
    const { prefix, store } = fresh();
    await store.acquireVoiceSlot("holder", 1, 60);
    await store.acquireVoiceSlot("ghost", 1, 60);
    await redis!.zadd(`${prefix}voice:seen`, Date.now() - (WAIT_STALE_S + 5) * 1000, "ghost");

    expect(await store.acquireVoiceSlot("live", 1, 60)).toEqual({ ok: false, position: 1 });
  });

  it("reads a room's remaining lifetime from the key's PTTL", async () => {
    const { prefix, store } = fresh();
    await store.issueRoom("r", 60);
    await redis!.pexpire(`${prefix}room:r`, 15_000);
    const left = await store.roomTtlMs("r");
    expect(left).toBeGreaterThan(14_000);
    expect(left).toBeLessThanOrEqual(15_000);
  });

  it("holds a late grant only for the ttl it was given, fractional seconds included", async () => {
    const { prefix, store } = fresh();
    await store.acquireVoiceSlot("a", 1, 12.345);
    const expiresAt = await redis!.zscore(`${prefix}voice:active`, "a");
    const [sec, usec] = await redis!.time();
    const nowMs = Number(sec) * 1000 + Math.floor(Number(usec) / 1000);
    expect(Number(expiresAt) - nowMs).toBeGreaterThan(12_000);
    expect(Number(expiresAt) - nowMs).toBeLessThanOrEqual(12_345);
  });

  it("frees a slot once its ttl has passed", async () => {
    const { prefix, store } = fresh();
    await store.acquireVoiceSlot("a", 1, 60);
    await redis!.zadd(`${prefix}voice:active`, Date.now() - 1000, "a");

    expect(await store.acquireVoiceSlot("b", 1, 60)).toEqual({ ok: true });
  });
});

describe("MemoryStore time behaviour", () => {
  const clock = (start = 1_000_000) => {
    let now = start;
    return { now: () => now, advance: (s: number) => (now += s * 1000) };
  };

  it("starts a new hit window once the old one has elapsed", async () => {
    const c = clock();
    const store = new MemoryStore(c.now);
    await store.hit("ip", 60);
    await store.hit("ip", 60);
    c.advance(61);
    expect(await store.hit("ip", 60)).toBe(1);
  });

  it("forgets an issued room after its ttl", async () => {
    const c = clock();
    const store = new MemoryStore(c.now);
    await store.issueRoom("r", 60);
    c.advance(59);
    expect(await store.hasRoom("r")).toBe(true);
    c.advance(2);
    expect(await store.hasRoom("r")).toBe(false);
  });

  it("counts a room's remaining lifetime down to 0", async () => {
    const c = clock();
    const store = new MemoryStore(c.now);
    await store.issueRoom("r", 60);
    expect(await store.roomTtlMs("r")).toBe(60_000);
    c.advance(45);
    expect(await store.roomTtlMs("r")).toBe(15_000);
    c.advance(15);
    expect(await store.roomTtlMs("r")).toBe(0);
  });

  it("frees a voice slot after its ttl", async () => {
    const c = clock();
    const store = new MemoryStore(c.now);
    await store.acquireVoiceSlot("a", 1, 60);
    expect(await store.acquireVoiceSlot("b", 1, 60)).toEqual({ ok: false, position: 1 });
    c.advance(61);
    expect(await store.acquireVoiceSlot("b", 1, 60)).toEqual({ ok: true });
  });

  it("drops a waiter that stopped polling so it cannot block the queue", async () => {
    const c = clock();
    const store = new MemoryStore(c.now);
    await store.acquireVoiceSlot("a", 1, 600);
    await store.acquireVoiceSlot("ghost", 1, 600);
    c.advance(WAIT_STALE_S - 1);
    await store.acquireVoiceSlot("live", 1, 600);
    c.advance(2);
    expect(await store.acquireVoiceSlot("live", 1, 600)).toEqual({ ok: false, position: 1 });
  });
});

describe("getStore", () => {
  afterEach(() => {
    resetStoreForTests();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  const base = { ZERORUNTIME_API_KEY: "k", ZERORUNTIME_SECRET: "s", STUDIO_VOICE_AGENT_ID: "a" };

  it("returns one shared in-memory store when REDIS_URL is absent", () => {
    const env = readEnv(base);
    expect(getStore(env)).toBeInstanceOf(MemoryStore);
    expect(getStore(env)).toBe(getStore(env));
  });

  it("warns, once, that the in-memory store is not for production", () => {
    vi.stubEnv("NODE_ENV", "production");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const env = readEnv(base);
    getStore(env);
    getStore(env);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("REDIS_URL");
  });

  it("stays quiet outside production", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    getStore(readEnv(base));
    expect(warn).not.toHaveBeenCalled();
  });
});
