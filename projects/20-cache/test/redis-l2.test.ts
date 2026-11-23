// Against a REAL Redis (the repo's infra Redis: docker compose -f infra/docker-compose.yml up -d redis ->
// 127.0.0.1:56379, or REDIS_URL). If it is not reachable these tests are SKIPPED with a printed notice, never
// silently passed; the README states which runs had Redis. Every key uses a prefix unique to this run and is deleted
// afterwards. Waits on real pub/sub messages are event-driven with a wide 10 s ceiling (a busy machine), never fixed
// sleeps.
import { Redis, type RedisOptions } from "ioredis";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { LruCache, TOMBSTONE, TwoLevelCache, ioredisL2Client, ioredisSubscriber, type TwoLevelEvent } from "../src/index.js";

const URL_ = process.env.REDIS_URL ?? "redis://127.0.0.1:56379";
const PREFIX = `cktest:${process.pid}:${Date.now()}:`;

async function reachable(): Promise<boolean> {
  const probe = new Redis(URL_, { lazyConnect: true, maxRetriesPerRequest: 0, retryStrategy: () => null, connectTimeout: 1000 });
  try {
    await probe.connect();
    return (await probe.ping()) === "PONG";
  } catch {
    return false;
  } finally {
    probe.disconnect();
  }
}

const available = await reachable();
if (!available) console.warn(`\n[redis-l2.test] SKIPPED: no Redis at ${URL_}. Start it: docker compose -f infra/docker-compose.yml up -d redis\n`);

// Resolves when `pred` holds for an event already recorded or a later one; rejects after 10 s.
function waitFor(events: TwoLevelEvent[], pred: (e: TwoLevelEvent) => boolean, what: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (events.some(pred)) return resolve();
      if (Date.now() - started > 10_000) return reject(new Error(`timed out waiting for ${what}`));
      setTimeout(tick, 5);
    };
    tick();
  });
}

describe.skipIf(!available)("TwoLevelCache against a real Redis", () => {
  const conns: Redis[] = [];
  const conn = (opts: RedisOptions = {}) => {
    const c = new Redis(URL_, opts);
    conns.push(c);
    return c;
  };
  let admin: Redis;

  beforeAll(() => {
    admin = conn();
  });
  afterAll(async () => {
    const keys = await admin.keys(`${PREFIX}*`);
    if (keys.length > 0) await admin.del(...keys);
    expect(await admin.keys(`${PREFIX}*`)).toEqual([]);
    await Promise.all(conns.map((c) => c.quit().catch(() => c.disconnect())));
  });

  // One "replica": its own L1, its own command connection and its own subscriber connection (named, so one test can
  // find and kill exactly this replica's subscriber; the pid keeps it apart from any other process on this Redis).
  let replicas = 0;
  function replica(prefix: string, l1Ttl = 60_000) {
    const events: TwoLevelEvent[] = [];
    const subName = `cachekit-test-${process.pid}-${++replicas}`;
    const sub = conn({ connectionName: subName });
    const cache = new TwoLevelCache<{ name: string } | null>({
      l1: new LruCache({ maxEntries: 100, ttlMs: l1Ttl }),
      redis: ioredisL2Client(conn()),
      subscriber: ioredisSubscriber(sub),
      prefix,
      onEvent: (e) => void events.push(e),
    });
    return { cache, events, sub, subName };
  }

  it("the ioredis adapter: GET + PTTL in one MULTI (missing -> [null, -2], no expiry -> -1, PX -> remaining ms)", async () => {
    const l2 = ioredisL2Client(conn());
    expect(await l2.getWithTtl(`${PREFIX}nothing`)).toEqual([null, -2]);
    await l2.set(`${PREFIX}forever`, "a", undefined, false);
    expect(await l2.getWithTtl(`${PREFIX}forever`)).toEqual(["a", -1]);
    await l2.set(`${PREFIX}px`, "b", 60_000, false);
    const [v, pttl] = await l2.getWithTtl(`${PREFIX}px`);
    expect(v).toBe("b");
    expect(pttl).toBeGreaterThan(50_000); // wide margin for a busy machine
    expect(pttl).toBeLessThanOrEqual(60_000);
    // NX: refused (null, what the cache counts as l2WritesSkipped) when the key exists, written when it does not.
    expect(await l2.set(`${PREFIX}px`, "c", 60_000, true)).toBeNull();
    expect(await l2.set(`${PREFIX}forever`, "c", undefined, true)).toBeNull();
    expect(await admin.get(`${PREFIX}px`)).toBe("b");
    expect(await l2.set(`${PREFIX}nx`, "d", 60_000, true)).toBe("OK");
    expect(await l2.set(`${PREFIX}nx2`, "e", undefined, true)).toBe("OK");
    expect(await admin.pttl(`${PREFIX}nx2`)).toBe(-1);
  });

  it("a load on replica A is served from Redis on replica B without calling B's loader; Redis holds it with the TTL", async () => {
    const p = `${PREFIX}load:`;
    const a = replica(p);
    const b = replica(p);
    await Promise.all([a.cache.ready, b.cache.ready]);
    expect(await a.cache.getOrLoad("1", async () => ({ name: "ann" }))).toEqual({ name: "ann" });
    await a.cache.flush();
    const pttl = await admin.pttl(`${p}1`);
    expect(pttl).toBeGreaterThan(50_000);
    expect(pttl).toBeLessThanOrEqual(60_000);
    const bLoader = vi.fn(async () => ({ name: "other" }));
    expect(await b.cache.getOrLoad("1", bLoader)).toEqual({ name: "ann" });
    expect(bLoader).not.toHaveBeenCalled();
    expect(b.cache.stats()).toMatchObject({ l2Hits: 1, l2Errors: 0 });
  });

  it("a delete on A reaches B's L1 through pub/sub; B then loads fresh", async () => {
    const p = `${PREFIX}del:`;
    const a = replica(p);
    const b = replica(p);
    expect(await a.cache.ready).toBe(true);
    expect(await b.cache.ready).toBe(true);
    await a.cache.getOrLoad("1", async () => ({ name: "old" }));
    await a.cache.flush();
    await b.cache.getOrLoad("1", async () => ({ name: "never" }));
    expect(b.cache.l1.peek("1")).toEqual({ name: "old" });
    expect(await a.cache.delete("1")).toBe(true);
    await waitFor(b.events, (e) => e.type === "invalidated" && e.key === "1", "B's invalidation");
    expect(b.cache.l1.peek("1")).toBeUndefined();
    expect(await admin.get(`${p}1`)).toBe(TOMBSTONE); // a tombstone, not DEL (see the race test below)
    const tombstonePttl = await admin.pttl(`${p}1`);
    expect(tombstonePttl).toBeGreaterThan(0);
    expect(tombstonePttl).toBeLessThanOrEqual(10_000);
    expect(await b.cache.getOrLoad("1", async () => ({ name: "new" }))).toEqual({ name: "new" });
    expect(a.events.some((e) => e.type === "invalidated")).toBe(false); // A ignored its own message
  });

  it("a set on A: B drops its copy and reads the new value from Redis", async () => {
    const p = `${PREFIX}set:`;
    const a = replica(p);
    const b = replica(p);
    await Promise.all([a.cache.ready, b.cache.ready]);
    await b.cache.getOrLoad("1", async () => ({ name: "old" }));
    expect(await a.cache.set("1", { name: "new" })).toBe(true);
    await waitFor(b.events, (e) => e.type === "invalidated", "B's invalidation");
    const bLoader = vi.fn(async () => ({ name: "never" }));
    expect(await b.cache.getOrLoad("1", bLoader)).toEqual({ name: "new" });
    expect(bLoader).not.toHaveBeenCalled();
  });

  it("RACE: B's load of the OLD value finishes right after A's set(): Redis keeps A's value whichever arrives first", async () => {
    // Before SET NX, this lost: B's write-behind (on B's connection) reached Redis after A's set, and Redis served the
    // old value to every replica. Now either B's message arrives first (B does not write) or B's NX is refused.
    const p = `${PREFIX}race:`;
    const a = replica(p);
    const b = replica(p);
    await Promise.all([a.cache.ready, b.cache.ready]);
    for (let i = 0; i < 20; i++) {
      let release!: (v: { name: string }) => void;
      const loading = b.cache.getOrLoad(`k${i}`, () => new Promise((r) => (release = r)));
      while (release === undefined) await new Promise((r) => setImmediate(r)); // B's Redis read done, loader running
      await a.cache.set(`k${i}`, { name: "new" });
      release({ name: "old" });
      await loading;
      await b.cache.flush();
      expect(await admin.get(`${p}k${i}`), `round ${i}`).toBe('{"v":{"name":"new"}}');
    }
    const s = b.cache.stats();
    console.log(`[race] 20 rounds: B's write refused by NX ${s.l2WritesSkipped}x, B wrote ${s.l2Writes}x, otherwise the invalidation arrived first`);
    expect(s.l2Writes).toBe(0);
  });

  it("the subscriber connection is killed: ioredis reconnects, L1 is cleared, and invalidations arrive again", async () => {
    const p = `${PREFIX}reconnect:`;
    const a = replica(p);
    const b = replica(p);
    await Promise.all([a.cache.ready, b.cache.ready]);
    await b.cache.getOrLoad("1", async () => ({ name: "cached" }));
    // Find B's subscriber connection by its name (CLIENT ID cannot run on a connection in subscriber mode) and kill it,
    // as a network blip or a Redis failover would.
    const list = String(await admin.call("CLIENT", "LIST", "TYPE", "pubsub"));
    const ids = list.split("\n").filter((l) => l.includes(`name=${b.subName} `)).map((l) => /id=(\d+)/.exec(l)![1]!);
    expect(ids).toHaveLength(1);
    await admin.client("KILL", "ID", ids[0]!);
    await waitFor(b.events, (e) => e.type === "resubscribed", "B's resubscribe");
    expect(b.cache.l1.size).toBe(0);
    expect(b.cache.stats().resubscribes).toBeGreaterThanOrEqual(1);
    await b.cache.getOrLoad("2", async () => ({ name: "two" }));
    await a.cache.delete("2");
    await waitFor(b.events, (e) => e.type === "invalidated" && e.key === "2", "an invalidation after the reconnect");
    expect(b.cache.l1.peek("2")).toBeUndefined();
  });

  it("Redis unreachable (nothing listens on the port): reads go to the loader, set / delete resolve false, no crash", async () => {
    const dead = conn({ port: 1, lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 0, retryStrategy: () => null });
    dead.on("error", () => {}); // ioredis emits connection errors as events; an app logs them
    const events: TwoLevelEvent[] = [];
    const cache = new TwoLevelCache<number>({ l1: new LruCache({ maxEntries: 10, ttlMs: 60_000 }), redis: ioredisL2Client(dead), prefix: `${PREFIX}dead:`, onEvent: (e) => void events.push(e) });
    const loader = vi.fn(async () => 42);
    expect(await cache.getOrLoad("k", loader)).toBe(42);
    expect(await cache.getOrLoad("k", loader)).toBe(42);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(await cache.set("k", 1)).toBe(false);
    expect(await cache.delete("k")).toBe(false);
    await cache.flush();
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.type === "l2-error")).toBe(true);
  });

  it("the command connection dies mid-run: the cache degrades to L1 + loader", async () => {
    const p = `${PREFIX}outage:`;
    const c = conn({ lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 0, retryStrategy: () => null });
    c.on("error", () => {});
    await c.connect(); // with the offline queue off, a command sent before the connection is up fails at once
    const cache = new TwoLevelCache<number>({ l1: new LruCache({ maxEntries: 10, ttlMs: 60_000 }), redis: ioredisL2Client(c), prefix: p });
    expect(await cache.getOrLoad("a", async () => 1)).toBe(1);
    await cache.flush();
    expect(cache.stats().l2Writes).toBe(1);
    const id = String(await c.client("ID"));
    await admin.client("KILL", "ID", id);
    const loader = vi.fn(async () => 2);
    expect(await cache.getOrLoad("b", loader)).toBe(2);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(await cache.getOrLoad("a", async () => -1)).toBe(1); // still in L1
    expect(cache.stats().l2Errors).toBeGreaterThanOrEqual(1);
  });
});
