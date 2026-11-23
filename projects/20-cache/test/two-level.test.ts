import { describe, expect, it, vi } from "vitest";
import { LruCache, TOMBSTONE, TwoLevelCache, jsonCodec, type Codec, type LruCacheOptions, type TwoLevelEvent } from "../src/index.js";
import { FakeRedis } from "./fake-redis.js";
import { deferred, flush, manualClock } from "./support.js";

type V = { name: string } | null;

// Two (or more) "replicas" = two TwoLevelCache instances, each with its own L1, sharing one (fake) Redis. One clock
// drives both L1s and the fake Redis's TTLs.
function cluster(l1Options: Partial<LruCacheOptions<string, V>> = {}, extra: { codec?: Codec<V>; l2TimeoutMs?: number } = {}) {
  const clock = manualClock(1000);
  const redis = new FakeRedis(clock.now);
  const replica = () => {
    const events: TwoLevelEvent[] = [];
    const l1 = new LruCache<string, V>({ maxEntries: 100, ttlMs: 1000, now: clock.now, ...l1Options });
    const sub = redis.subscriber();
    const c = new TwoLevelCache<V>({ l1, redis: redis.client(), subscriber: sub, prefix: "app:u:", onEvent: (e) => void events.push(e), ...extra });
    return { c, l1, sub, events };
  };
  return { clock, redis, replica };
}

const user = (name: string) => async () => ({ name });

describe("TwoLevelCache: L1 -> L2 -> loader", () => {
  it("a miss everywhere calls the loader and writes the value to L1 and to Redis (prefixed key, same TTL)", async () => {
    const { redis, replica } = cluster();
    const a = replica();
    const loader = vi.fn(user("ann"));
    expect(await a.c.getOrLoad("1", loader)).toEqual({ name: "ann" });
    await a.c.flush();
    expect(loader).toHaveBeenCalledTimes(1);
    expect(a.l1.peek("1")).toEqual({ name: "ann" });
    expect(redis.commands).toEqual(["get app:u:1", "set app:u:1 1000 NX"]); // NX: a load never overwrites
    expect(redis.data.get("app:u:1")!.value).toBe('{"v":{"name":"ann"}}');
    expect(a.c.stats()).toMatchObject({ l2Misses: 1, l2Hits: 0, l2Writes: 1 });
  });

  it("replica B is served from L2 without calling ITS loader; B's L1 copy expires with the Redis copy", async () => {
    const { clock, replica } = cluster();
    const a = replica();
    const b = replica();
    await a.c.getOrLoad("1", user("ann"));
    await a.c.flush();
    clock.advance(700); // Redis has 300 ms left
    const bLoader = vi.fn(user("other"));
    expect(await b.c.getOrLoad("1", bLoader)).toEqual({ name: "ann" });
    expect(bLoader).not.toHaveBeenCalled();
    expect(b.c.stats()).toMatchObject({ l2Hits: 1 });
    clock.advance(299);
    expect(b.l1.peek("1")).toEqual({ name: "ann" });
    clock.advance(1);
    expect(b.l1.peek("1")).toBeUndefined(); // not 1000 ms after B read it
  });

  it("the L1 copy of an L2 hit gets min(Redis TTL, this call's TTL); a Redis key without expiry uses the call's TTL", async () => {
    const { clock, redis, replica } = cluster();
    const a = replica();
    redis.data.set("app:u:long", { value: jsonCodec.encode({ name: "x" }), expiresAt: Infinity });
    await a.c.getOrLoad("long", user("y"), { ttlMs: 50 });
    clock.advance(50);
    expect(a.l1.peek("long")).toBeUndefined();
  });

  it("an L1 hit does not touch Redis", async () => {
    const { redis, replica } = cluster();
    const a = replica();
    await a.c.getOrLoad("1", user("ann"));
    await a.c.flush();
    redis.commands.length = 0;
    await a.c.getOrLoad("1", user("ann"));
    expect(redis.commands).toEqual([]);
  });

  it("50 concurrent misses on one replica: ONE Redis read and ONE loader call (single flight covers L2 too)", async () => {
    const { redis, replica } = cluster();
    const a = replica();
    const d = deferred<V>();
    const loader = vi.fn(() => d.promise);
    const all = Array.from({ length: 50 }, () => a.c.getOrLoad("1", loader));
    await flush();
    d.resolve({ name: "ann" });
    expect(new Set((await Promise.all(all)).map((v) => v?.name))).toEqual(new Set(["ann"]));
    expect(loader).toHaveBeenCalledTimes(1);
    expect(redis.commands.filter((c) => c.startsWith("get"))).toHaveLength(1);
  });

  it("a negative value travels through L2 with its short TTL and counts as a negative hit on the other replica", async () => {
    const { clock, redis, replica } = cluster({ negativeTtlMs: 50 });
    const a = replica();
    const b = replica();
    await a.c.getOrLoad("ghost", async () => null);
    await a.c.flush();
    expect(redis.commands).toContain("set app:u:ghost 50 NX");
    const bLoader = vi.fn(async () => null);
    expect(await b.c.getOrLoad("ghost", bLoader)).toBeNull();
    b.l1.get("ghost");
    expect(bLoader).not.toHaveBeenCalled();
    expect(b.l1.stats().negativeHits).toBe(1);
    clock.advance(50);
    expect(b.l1.has("ghost")).toBe(false);
  });

  it("stale-while-revalidate: a refresh reads L2 first, so a value another replica already refreshed costs no load", async () => {
    const { clock, replica } = cluster({ ttlMs: 100, staleMs: 1000 });
    const a = replica();
    const b = replica();
    await a.c.getOrLoad("1", user("v1"));
    await b.c.getOrLoad("1", user("never")); // from L2
    await a.c.flush();
    clock.advance(100); // both stale, Redis copy gone
    expect(await a.c.getOrLoad("1", user("v2"))).toEqual({ name: "v1" }); // stale; A refreshes from the loader
    await flush();
    await a.c.flush();
    const bLoader = vi.fn(user("never"));
    expect(await b.c.getOrLoad("1", bLoader)).toEqual({ name: "v1" }); // stale; B's refresh finds v2 in Redis
    await flush();
    expect(bLoader).not.toHaveBeenCalled();
    expect(b.l1.peek("1")).toEqual({ name: "v2" });
  });

  it("every caller leaving during the Redis read: the loader is not started even after the read gives up", async () => {
    // (The first version checked the loader right after the abort, before the hung read had timed out: it passed
    // with the check removed -- mutation X15. It now waits until the read is over.)
    const { redis, replica } = cluster({}, { l2TimeoutMs: 30 });
    const a = replica();
    redis.mode = "hang";
    const loader = vi.fn(user("x"));
    const ac = new AbortController();
    const p = a.c.getOrLoad("1", loader, { signal: ac.signal });
    ac.abort(new Error("client left"));
    await expect(p).rejects.toThrow("client left");
    while (!a.events.some((e) => e.type === "l2-error" && e.op === "get")) await new Promise((r) => setTimeout(r, 5));
    await flush();
    expect(loader).not.toHaveBeenCalled();
  });

  it("a Redis PTTL of 0 (expires within the millisecond) is a miss, not a hit with TTL 0", async () => {
    const client = { getWithTtl: async (): Promise<[string, number]> => ['{"v":{"name":"old"}}', 0], set: async () => "OK", publish: async () => 1 };
    const c = new TwoLevelCache<V>({ l1: new LruCache({ maxEntries: 10 }), redis: client, prefix: "p:" });
    expect(await c.getOrLoad("k", user("fresh"))).toEqual({ name: "fresh" });
    expect(c.stats()).toMatchObject({ l2Hits: 0, l2Misses: 1 });
  });

  it("close() waits for a background write that is still on its way to Redis", async () => {
    let written = false;
    const client = {
      getWithTtl: async (): Promise<[null, number]> => [null, -2],
      set: () => new Promise((r) => setTimeout(() => ((written = true), r("OK")), 20)),
      publish: async () => 1,
    };
    const c = new TwoLevelCache<number>({ l1: new LruCache({ maxEntries: 10 }), redis: client, prefix: "p:" });
    await c.getOrLoad("k", async () => 1);
    expect(written).toBe(false);
    await c.close();
    expect(written).toBe(true);
  });
});

describe("TwoLevelCache: invalidation between replicas (pub/sub)", () => {
  it("delete on A removes the key from Redis and from B's L1; B's next read calls the loader", async () => {
    const { redis, replica } = cluster();
    const a = replica();
    const b = replica();
    await a.c.getOrLoad("1", user("old"));
    await a.c.flush();
    await b.c.getOrLoad("1", user("never"));
    expect(await a.c.delete("1")).toBe(true);
    await flush();
    expect(redis.data.get("app:u:1")?.value).toBe(TOMBSTONE);
    expect(b.l1.peek("1")).toBeUndefined();
    expect(b.events).toContainEqual({ type: "invalidated", key: "1" });
    expect(await b.c.getOrLoad("1", user("new"))).toEqual({ name: "new" });
    expect(a.c.stats().invalidationsSent).toBe(1);
    expect(b.c.stats().invalidationsReceived).toBe(1);
  });

  it("set on A writes Redis with the TTL, keeps A's own L1 value (own message ignored), and B then reads the new value", async () => {
    const { redis, replica } = cluster();
    const a = replica();
    const b = replica();
    await b.c.getOrLoad("1", user("old"));
    await b.c.flush();
    expect(await a.c.set("1", { name: "new" }, { ttlMs: 500 })).toBe(true);
    await flush();
    expect(redis.commands).toContain("set app:u:1 500");
    expect(a.l1.peek("1")).toEqual({ name: "new" });
    expect(a.c.stats().invalidationsReceived).toBe(0);
    expect(b.l1.peek("1")).toBeUndefined();
    expect(await b.c.getOrLoad("1", user("never"))).toEqual({ name: "new" });
  });

  it("set without ttlMs uses the L1's default TTL in Redis; Infinity = no expiry", async () => {
    const { redis, replica } = cluster();
    const a = replica();
    await a.c.set("d", { name: "d" });
    await a.c.set("f", { name: "f" }, { ttlMs: Infinity });
    expect(redis.commands).toContain("set app:u:d 1000");
    expect(redis.commands).toContain("set app:u:f -");
  });

  it("an invalidation arriving while B is loading the key: B's result is written to neither L1 nor Redis", async () => {
    const { redis, replica } = cluster();
    const a = replica();
    const b = replica();
    const d = deferred<V>();
    const p = b.c.getOrLoad("1", () => d.promise); // B reads the OLD row from the DB...
    await flush();
    await a.c.delete("1"); // ...A updates the row and invalidates
    await flush();
    d.resolve({ name: "old row" });
    expect(await p).toEqual({ name: "old row" }); // B's caller still gets what it asked for
    await b.c.flush();
    expect(b.l1.peek("1")).toBeUndefined();
    expect(redis.data.get("app:u:1")?.value).toBe(TOMBSTONE);
    expect(redis.commands.filter((c) => c.endsWith("NX"))).toEqual([]); // B did not even try
  });

  it("a local delete during a load also stops the Redis write (not even attempted)", async () => {
    const { redis, replica } = cluster();
    const a = replica();
    const d = deferred<V>();
    const p = a.c.getOrLoad("1", () => d.promise);
    await flush();
    await a.c.delete("1");
    d.resolve({ name: "old" });
    await p;
    await a.c.flush();
    expect(redis.data.get("app:u:1")?.value).toBe(TOMBSTONE);
    expect(redis.commands.filter((c) => c.endsWith("NX"))).toEqual([]);
  });

  it("RACE: B's load finishes after A's set() but BEFORE A's message reaches B: B's write is refused (NX), Redis keeps A's value", async () => {
    const { redis, replica } = cluster();
    const a = replica();
    const b = replica();
    const d = deferred<V>();
    const p = b.c.getOrLoad("1", () => d.promise); // B reads the OLD row
    await flush();
    redis.holdMessages(); // A's invalidation is slow on the network
    expect(await a.c.set("1", { name: "new" })).toBe(true);
    d.resolve({ name: "old" }); // B still thinks its load is current and writes behind
    await p;
    await b.c.flush();
    expect(redis.commands).toContain("set app:u:1 1000 NX");
    expect(redis.data.get("app:u:1")!.value).toBe('{"v":{"name":"new"}}');
    expect(b.c.stats()).toMatchObject({ l2WritesSkipped: 1, l2Writes: 0 });
    expect(b.l1.peek("1")).toEqual({ name: "old" }); // until the message arrives...
    redis.releaseMessages();
    await flush();
    expect(b.l1.peek("1")).toBeUndefined(); // ...then dropped; the next read gets "new" from Redis
    expect(await b.c.getOrLoad("1", user("never"))).toEqual({ name: "new" });
  });

  it("RACE: the same after A's delete(): the tombstone refuses B's late write; a third replica loads fresh", async () => {
    const { redis, replica } = cluster();
    const a = replica();
    const b = replica();
    const c = replica();
    const d = deferred<V>();
    const p = b.c.getOrLoad("1", () => d.promise);
    await flush();
    redis.holdMessages();
    expect(await a.c.delete("1")).toBe(true);
    d.resolve({ name: "old" });
    await p;
    await b.c.flush();
    expect(redis.data.get("app:u:1")!.value).toBe(TOMBSTONE);
    redis.releaseMessages();
    const cLoader = vi.fn(user("fresh"));
    expect(await c.c.getOrLoad("1", cLoader)).toEqual({ name: "fresh" }); // a tombstone is a miss
    expect(cLoader).toHaveBeenCalledTimes(1);
  });

  it("a tombstone lasts tombstoneMs; after it, a load writes Redis again", async () => {
    const clock = manualClock();
    const redis = new FakeRedis(clock.now);
    const c = new TwoLevelCache<number>({ l1: new LruCache({ maxEntries: 10, ttlMs: 1000, now: clock.now }), redis: redis.client(), prefix: "t:", tombstoneMs: 300 });
    await c.delete("k");
    expect(redis.commands).toEqual(["set t:k 300", "publish t:invalidate"]);
    await c.getOrLoad("k", async () => 1);
    await c.flush();
    expect(redis.data.get("t:k")!.value).toBe(TOMBSTONE); // refused during the tombstone
    expect(c.stats().l2WritesSkipped).toBe(1);
    c.l1.clear();
    clock.advance(300);
    await c.getOrLoad("k", async () => 2);
    await c.flush();
    expect(redis.data.get("t:k")!.value).toBe('{"v":2}');
    expect(() => new TwoLevelCache({ l1: c.l1, redis: redis.client(), prefix: "t:", tombstoneMs: 0 })).toThrow(RangeError);
  });

  it("an explicit set() overwrites a tombstone (it is a newer value, not a late load)", async () => {
    const redis = new FakeRedis();
    const c = new TwoLevelCache<number>({ l1: new LruCache({ maxEntries: 10 }), redis: redis.client(), prefix: "t:" });
    await c.delete("k");
    await c.set("k", 5);
    expect(redis.data.get("t:k")!.value).toBe('{"v":5}');
  });

  it("a subscriber that was disconnected MISSES messages (the documented weakness); on reconnect L1 is cleared", async () => {
    const { replica } = cluster();
    const a = replica();
    const b = replica();
    await a.c.getOrLoad("1", user("old"));
    await a.c.getOrLoad("2", user("two"));
    await a.c.flush();
    await b.c.getOrLoad("1", user("never"));
    await b.c.getOrLoad("2", user("never"));
    b.sub.disconnect();
    await a.c.set("1", { name: "new" });
    await flush();
    expect(b.l1.peek("1")).toEqual({ name: "old" }); // missed: stale until the TTL or a reconnect
    b.sub.reconnect();
    expect(b.l1.size).toBe(0);
    expect(b.events).toContainEqual({ type: "resubscribed" });
    expect(b.c.stats().resubscribes).toBe(1);
    expect(await b.c.getOrLoad("1", user("never"))).toEqual({ name: "new" }); // refilled from Redis
  });

  it("a malformed message is ignored and reported; a message for another channel never arrives", async () => {
    const { redis, replica } = cluster();
    const a = replica();
    await a.c.getOrLoad("1", user("x"));
    for (const bad of ["not json", "[1,2]", '["only-one"]', "{}"]) await redis.client().publish("app:u:invalidate", bad);
    await redis.client().publish("other:invalidate", JSON.stringify(["someone", "1"]));
    await flush();
    expect(a.l1.peek("1")).toEqual({ name: "x" });
    expect(a.events.filter((e) => e.type === "l2-error" && e.op === "message")).toHaveLength(4);
  });

  it("the channel defaults to prefix + 'invalidate' and can be set", async () => {
    const redis = new FakeRedis();
    const l1 = new LruCache<string, V>({ maxEntries: 10 });
    const c = new TwoLevelCache<V>({ l1, redis: redis.client(), prefix: "p:", channel: "custom" });
    await c.delete("k");
    const d = new TwoLevelCache<V>({ l1, redis: redis.client(), prefix: "p:" });
    await d.delete("k");
    expect(redis.commands).toEqual(["set p:k 10000", "publish custom", "set p:k 10000", "publish p:invalidate"]); // tombstone, default 10 s
  });

  it("close() waits for pending writes and unsubscribes", async () => {
    const { redis, replica } = cluster();
    const a = replica();
    await a.c.ready;
    expect(redis.subscriberCount).toBe(1);
    await a.c.getOrLoad("1", user("x"));
    await a.c.close();
    expect(redis.data.has("app:u:1")).toBe(true);
    expect(redis.subscriberCount).toBe(0);
  });

  it("without a subscriber: ready is false and nothing listens (other replicas' L1 copies live until their TTL)", async () => {
    const redis = new FakeRedis();
    const c = new TwoLevelCache<V>({ l1: new LruCache({ maxEntries: 1 }), redis: redis.client(), prefix: "p:" });
    expect(await c.ready).toBe(false);
  });
});

describe("TwoLevelCache: codec", () => {
  it("default JSON round trip, including a top-level undefined and null; what JSON loses (Date -> string, Map -> {})", () => {
    for (const v of [{ a: 1, b: [1, "x", null] }, null, undefined, 0, "", "text", [1, 2]]) {
      expect(jsonCodec.decode(jsonCodec.encode(v))).toEqual(v);
    }
    expect(jsonCodec.decode(jsonCodec.encode(undefined))).toBeUndefined();
    const date = new Date(0);
    expect(jsonCodec.decode(jsonCodec.encode({ date }))).toEqual({ date: "1970-01-01T00:00:00.000Z" });
    expect(jsonCodec.decode(jsonCodec.encode(new Map([[1, 2]])))).toEqual({});
    expect(jsonCodec.decode(jsonCodec.encode({ gone: undefined }))).toEqual({});
  });

  it("a custom codec is used in both directions (keeps a Date a Date)", async () => {
    type D = { at: Date };
    const codec: Codec<D> = { encode: (v) => String(v.at.getTime()), decode: (s) => ({ at: new Date(Number(s)) }) };
    const clock = manualClock();
    const redis = new FakeRedis(clock.now);
    const mk = () => new TwoLevelCache<D>({ l1: new LruCache({ maxEntries: 10, ttlMs: 100, now: clock.now }), redis: redis.client(), prefix: "d:", codec });
    const a = mk();
    await a.getOrLoad("k", async () => ({ at: new Date(5) }));
    await a.flush();
    expect(redis.data.get("d:k")!.value).toBe("5");
    const got = await mk().getOrLoad("k", async () => ({ at: new Date(9) }));
    expect(got.at).toBeInstanceOf(Date);
    expect(got.at.getTime()).toBe(5);
  });

  it("a value Redis holds that cannot be decoded is a miss: the loader runs and overwrites it", async () => {
    const { redis, replica } = cluster();
    const a = replica();
    redis.data.set("app:u:1", { value: "{broken", expiresAt: Infinity });
    expect(await a.c.getOrLoad("1", user("fresh"))).toEqual({ name: "fresh" });
    await a.c.flush();
    expect(redis.data.get("app:u:1")!.value).toBe('{"v":{"name":"fresh"}}');
    expect(a.events).toContainEqual(expect.objectContaining({ type: "l2-error", op: "decode", key: "1" }));
  });

  it("a value that cannot be encoded is not written to Redis but is still returned and cached in L1", async () => {
    const clock = manualClock();
    const redis = new FakeRedis(clock.now);
    const events: TwoLevelEvent[] = [];
    const c = new TwoLevelCache<{ n: bigint }>({ l1: new LruCache({ maxEntries: 10, now: clock.now }), redis: redis.client(), prefix: "b:", onEvent: (e) => void events.push(e) });
    expect(await c.getOrLoad("k", async () => ({ n: 1n }))).toEqual({ n: 1n });
    await c.flush();
    expect(c.l1.peek("k")).toEqual({ n: 1n });
    expect(redis.data.size).toBe(0);
    expect(events).toContainEqual(expect.objectContaining({ type: "l2-error", op: "encode" }));
    expect(await c.set("k", { n: 2n })).toBe(false); // set: L1 updated, Redis not
    expect(c.l1.peek("k")).toEqual({ n: 2n });
    // Not just undefined (which a separate guard also catches): a number or an object must not reach Redis either
    // (the first version only tried undefined, so mutation X16 survived).
    for (const notAString of [undefined, 5, { v: 1 }]) {
      const bad = new TwoLevelCache<number>({ l1: new LruCache({ maxEntries: 1 }), redis: redis.client(), prefix: "x:", codec: { encode: () => notAString as unknown as string, decode: Number } });
      expect(await bad.set("k", 1)).toBe(false);
      await bad.getOrLoad("j", async () => 1);
      await bad.flush();
    }
    expect([...redis.data.keys()].filter((k) => k.startsWith("x:"))).toEqual([]);
  });
});

describe("TwoLevelCache: Redis outage degrades to L1 + loader", () => {
  it("Redis down: reads go to the loader, L1 still caches, set / delete resolve false, nothing throws", async () => {
    const { redis, replica } = cluster();
    const a = replica();
    redis.mode = "down";
    const loader = vi.fn(user("db"));
    expect(await a.c.getOrLoad("1", loader)).toEqual({ name: "db" });
    expect(await a.c.getOrLoad("1", loader)).toEqual({ name: "db" }); // L1 hit
    expect(loader).toHaveBeenCalledTimes(1);
    await a.c.flush();
    expect(await a.c.set("2", { name: "two" })).toBe(false);
    expect(a.l1.peek("2")).toEqual({ name: "two" });
    expect(await a.c.delete("1")).toBe(false);
    expect(a.l1.peek("1")).toBeUndefined();
    expect(a.c.stats().l2Errors).toBe(6); // get, the write behind, set, publish, del, publish
    const ops = a.events.flatMap((e) => (e.type === "l2-error" ? [e.op] : []));
    expect(ops).toEqual(["get", "set", "set", "publish", "delete", "publish"]);
  });

  it("Redis hanging: each call gives up after l2TimeoutMs and the loader answers (real timers, 30 ms)", async () => {
    const { redis, replica } = cluster({}, { l2TimeoutMs: 30 });
    const a = replica();
    redis.mode = "hang";
    const started = performance.now();
    expect(await a.c.getOrLoad("1", user("db"))).toEqual({ name: "db" });
    expect(performance.now() - started).toBeGreaterThanOrEqual(25); // it did wait for the timeout (timer slack)
    expect(await a.c.delete("1")).toBe(false);
    await a.c.flush();
    expect(a.events[0]).toMatchObject({ type: "l2-error", op: "get" });
    expect(String((a.events[0] as { error: Error }).error.message)).toMatch(/did not answer within 30 ms/);
  });

  it("subscribing fails: ready resolves false with an l2-error, the cache still works", async () => {
    const { redis, replica } = cluster();
    redis.mode = "down";
    const a = replica();
    expect(await a.c.ready).toBe(false);
    expect(a.events[0]).toMatchObject({ type: "l2-error", op: "subscribe" });
    expect(await a.c.getOrLoad("1", user("db"))).toEqual({ name: "db" });
    await a.c.close();
  });

  it("Redis back after an outage: the next miss uses it again", async () => {
    const { redis, replica } = cluster();
    const a = replica();
    redis.mode = "down";
    await a.c.getOrLoad("1", user("db"));
    redis.mode = "ok";
    await a.c.getOrLoad("2", user("db"));
    await a.c.flush();
    expect(redis.data.has("app:u:2")).toBe(true);
  });

  it("a throwing onEvent handler changes nothing", async () => {
    const redis = new FakeRedis();
    redis.mode = "down";
    const c = new TwoLevelCache<number>({ l1: new LruCache({ maxEntries: 1 }), redis: redis.client(), prefix: "p:", onEvent: () => { throw new Error("logger broke"); } });
    expect(await c.getOrLoad("k", async () => 1)).toBe(1);
    expect(await c.delete("k")).toBe(false);
  });

  it("TTLs go to Redis as whole ms, rounded UP (never PX 0)", async () => {
    const redis = new FakeRedis();
    const c = new TwoLevelCache<number>({ l1: new LruCache({ maxEntries: 10 }), redis: redis.client(), prefix: "r:" });
    await c.set("a", 1, { ttlMs: 0.5 });
    await c.set("b", 1, { ttlMs: 10.2 });
    expect(redis.commands.filter((x) => x.startsWith("set"))).toEqual(["set r:a 1", "set r:b 11"]);
    expect(c.stats().l2Errors).toBe(0);
  });

  it("invalid options: empty prefix, bad l2TimeoutMs", () => {
    const redis = new FakeRedis();
    const l1 = new LruCache<string, number>({ maxEntries: 1 });
    expect(() => new TwoLevelCache({ l1, redis: redis.client(), prefix: "" })).toThrow(TypeError);
    for (const t of [0, -1, NaN, Infinity]) expect(() => new TwoLevelCache({ l1, redis: redis.client(), prefix: "p:", l2TimeoutMs: t })).toThrow(RangeError);
  });
});
