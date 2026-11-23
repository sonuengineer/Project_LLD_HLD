// Against a REAL Redis (the repo's infra Redis: docker compose -f infra/docker-compose.yml up -d redis ->
// 127.0.0.1:56379, or REDIS_URL). If it is not reachable these tests are SKIPPED with a printed notice, never
// silently passed; the README states which runs had Redis.
import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { slidingWindow, tokenBucket } from "../src/algorithms.js";
import { RateLimiter } from "../src/limiter.js";
import { MemoryStore } from "../src/memory-store.js";
import { ioredisClient, RedisStore } from "../src/redis-store.js";
import type { Algorithm } from "../src/types.js";

const URL_ = process.env.REDIS_URL ?? "redis://127.0.0.1:56379";
const PREFIX = `rltest:${process.pid}:`;

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
if (!available) console.warn(`\n[redis.test] SKIPPED: no Redis at ${URL_}. Start it: docker compose -f infra/docker-compose.yml up -d redis\n`);

describe.skipIf(!available)("RedisStore against a real Redis", () => {
  const clients: Redis[] = [];
  const client = () => {
    const c = new Redis(URL_);
    clients.push(c);
    return c;
  };
  let admin: Redis;

  beforeAll(() => {
    admin = client();
  });
  beforeEach(async () => {
    const keys = await admin.keys(`${PREFIX}*`);
    if (keys.length > 0) await admin.del(...keys);
  });
  afterAll(async () => {
    const keys = await admin.keys(`${PREFIX}*`);
    if (keys.length > 0) await admin.del(...keys);
    await Promise.all(clients.map((c) => c.quit()));
  });

  // Seeded PRNG (mulberry32): a failing sequence can be replayed from its seed.
  const rng = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  async function parity<S>(name: string, algorithm: Algorithm<S>, seed: number, steps: number, maxAdvanceMs: number) {
    let t = 1_700_000_000_000;
    const now = () => t;
    const mem = new RateLimiter({ algorithm, store: new MemoryStore({ now }), prefix: `${PREFIX}${name}:` });
    const red = new RateLimiter({ algorithm, store: new RedisStore(ioredisClient(client()), { now }), prefix: `${PREFIX}${name}:` });
    const rand = rng(seed);
    let allowed = 0;
    let denied = 0;
    for (let i = 0; i < steps; i++) {
      t += Math.floor(rand() * maxAdvanceMs);
      const key = `k${Math.floor(rand() * 3)}`;
      const cost = 1 + Math.floor(rand() * Math.min(3, algorithm.limit));
      const a = await mem.consume(key, cost);
      const b = await red.consume(key, cost);
      expect(b, `step ${i}, seed ${seed}`).toEqual(a);
      if (a.allowed) allowed++;
      else denied++;
    }
    return { allowed, denied };
  }

  it("token bucket: TypeScript and Redis Lua give IDENTICAL decisions over 600 random steps (3 seeds)", async () => {
    for (const seed of [1, 2, 3]) {
      const r = await parity(`tb${seed}`, tokenBucket({ capacity: 5, refillPerSec: 3 }), seed, 200, 700);
      expect(r.allowed > 0 && r.denied > 0).toBe(true); // both outcomes really exercised
    }
  });

  it("sliding window: TypeScript and Redis Lua give IDENTICAL decisions over 600 random steps (3 seeds)", async () => {
    for (const seed of [4, 5, 6]) {
      const r = await parity(`sw${seed}`, slidingWindow({ limit: 6, windowMs: 1000 }), seed, 200, 400);
      expect(r.allowed > 0 && r.denied > 0).toBe(true);
    }
  });

  it("atomic across instances: 3 clients, 300 concurrent requests, capacity 50 -> exactly 50 allowed", async () => {
    const algorithm = tokenBucket({ capacity: 50, refillPerSec: 0.001 });
    const limiters = [0, 1, 2].map(() => new RateLimiter({ algorithm, store: new RedisStore(ioredisClient(client())), prefix: PREFIX }));
    const results = await Promise.all(Array.from({ length: 300 }, (_, i) => limiters[i % 3]!.consume("hot")));
    expect(results.filter((d) => d.allowed)).toHaveLength(50);
  });

  it("sliding window is atomic too: 200 concurrent, limit 40 -> exactly 40 allowed", async () => {
    const algorithm = slidingWindow({ limit: 40, windowMs: 60_000 });
    const limiters = [0, 1].map(() => new RateLimiter({ algorithm, store: new RedisStore(ioredisClient(client())), prefix: PREFIX }));
    const results = await Promise.all(Array.from({ length: 200 }, (_, i) => limiters[i % 2]!.consume("hot")));
    expect(results.filter((d) => d.allowed)).toHaveLength(40);
  });

  it("uses Redis's own clock by default (no now passed): works and sets an expiry on the key", async () => {
    const limiter = new RateLimiter({ algorithm: tokenBucket({ capacity: 2, refillPerSec: 1 }), store: new RedisStore(ioredisClient(client())), prefix: PREFIX });
    expect((await limiter.consume("clock")).allowed).toBe(true);
    const ttl = await admin.pttl(`${PREFIX}clock`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(3000); // capacity / rate s + 1 s
  });

  it("NOSCRIPT after SCRIPT FLUSH (e.g. a Redis restart): loads the script and carries on", async () => {
    const limiter = new RateLimiter({ algorithm: tokenBucket({ capacity: 3, refillPerSec: 1 }), store: new RedisStore(ioredisClient(client())), prefix: PREFIX });
    await limiter.consume("flush");
    await admin.script("FLUSH");
    expect(await limiter.consume("flush")).toMatchObject({ allowed: true, remaining: 1 });
  });

  it("errors other than NOSCRIPT are passed through, not retried", async () => {
    let calls = 0;
    const store = new RedisStore({
      evalsha: async () => {
        calls++;
        throw new Error("READONLY You can't write against a read only replica.");
      },
      scriptLoad: async () => "x",
    });
    const limiter = new RateLimiter({ algorithm: tokenBucket({ capacity: 1, refillPerSec: 1 }), store });
    await expect(limiter.consume("x")).rejects.toThrow(/READONLY/);
    expect(calls).toBe(1);
  });

  it("without a clock option the time argument is EMPTY (so the script uses Redis TIME); with one it is that time", async () => {
    const seen: string[][] = [];
    const spy = { evalsha: async (_s: string, _k: string[], a: string[]) => (seen.push(a), [1, 0, 0, 0]), scriptLoad: async () => "x" };
    const algorithm = tokenBucket({ capacity: 1, refillPerSec: 1 });
    await new RateLimiter({ algorithm, store: new RedisStore(spy) }).consume("k");
    await new RateLimiter({ algorithm, store: new RedisStore(spy, { now: () => 1234 }) }).consume("k", 1);
    expect(seen).toEqual([
      ["1", "1", "", "1"], // capacity, rate, now = "" -> Redis TIME, cost
      ["1", "1", "1234", "1"],
    ]);
  });

  it("an unexpected reply shape is an error, not a guess", async () => {
    const store = new RedisStore({ evalsha: async () => [1, 2], scriptLoad: async () => "x" });
    const limiter = new RateLimiter({ algorithm: tokenBucket({ capacity: 1, refillPerSec: 1 }), store });
    await expect(limiter.consume("x")).rejects.toThrow(/unexpected reply/);
  });
});
