import express from "express";
import { Redis } from "ioredis";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { rateLimit } from "../src/adapters/express.js";
import { tokenBucket } from "../src/algorithms.js";
import { FailoverStore, type Guard } from "../src/failover-store.js";
import { RateLimiter, type Store } from "../src/limiter.js";
import { MemoryStore } from "../src/memory-store.js";
import { ioredisClient, RedisStore } from "../src/redis-store.js";
import { StoreUnavailableError } from "../src/types.js";

// resilience-kit (projects/18-resilience) as the guard. Loaded dynamically so this package keeps no compile-time
// dependency on it -- the Guard interface is structural.
const RESILIENCE = "../../18-resilience/src/index.js";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const rk: any = await import(/* @vite-ignore */ RESILIENCE);

const algorithm = tokenBucket({ capacity: 2, refillPerSec: 0.001 });
const ok: Store = { consume: async () => ({ allowed: true, limit: 2, remaining: 1, retryAfterMs: 0, resetMs: 0 }) };
const broken = (calls = { n: 0 }): Store => ({
  consume: async () => {
    calls.n++;
    throw new Error("ECONNREFUSED 127.0.0.1:6379");
  },
});

describe("FailoverStore", () => {
  it("primary works: its decision, not marked degraded", async () => {
    const d = await new FailoverStore(ok, { fallback: new MemoryStore() }).consume(algorithm, "k", 1);
    expect(d.remaining).toBe(1);
    expect(d.degraded).toBeUndefined();
  });

  it("primary fails, fallback set: the fallback limits (per instance) and decisions are marked degraded", async () => {
    const errors: unknown[] = [];
    const store = new FailoverStore(broken(), { fallback: new MemoryStore(), onError: (e) => errors.push(e) });
    const limiter = new RateLimiter({ algorithm, store });
    const ds = [await limiter.consume("k"), await limiter.consume("k"), await limiter.consume("k")];
    expect(ds.map((d) => [d.allowed, d.degraded])).toEqual([[true, true], [true, true], [false, true]]);
    expect(errors).toHaveLength(3);
  });

  it("primary fails, no fallback: StoreUnavailableError with the cause", async () => {
    const e = await new FailoverStore(broken()).consume(algorithm, "k", 1).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(StoreUnavailableError);
    expect((e as Error).cause).toMatchObject({ message: "ECONNREFUSED 127.0.0.1:6379" });
  });

  it("the fallback fails too: StoreUnavailableError, not hidden", async () => {
    const e = await new FailoverStore(broken(), { fallback: broken() }).consume(algorithm, "k", 1).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(StoreUnavailableError);
  });

  it("a throwing onError changes nothing", async () => {
    const store = new FailoverStore(broken(), { fallback: new MemoryStore(), onError: () => { throw new Error("logger down"); } });
    expect((await store.consume(algorithm, "k", 1)).degraded).toBe(true);
  });

  it("guarded by resilience-kit: a HANGING primary times out after 100 ms and the fallback answers", async () => {
    const hanging: Store = { consume: () => new Promise(() => {}) };
    const guard: Guard = new rk.TimeoutPolicy({ ms: 100 });
    const t0 = Date.now();
    const d = await new FailoverStore(hanging, { guard, fallback: new MemoryStore() }).consume(algorithm, "k", 1);
    expect(d.degraded).toBe(true);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("guarded by resilience-kit's circuit breaker: once open, the dead primary is not even called", async () => {
    const calls = { n: 0 };
    const guard: Guard = rk.wrap(new rk.CircuitBreaker({ windowSize: 3, minimumCalls: 3, openMs: 60_000 }), new rk.TimeoutPolicy({ ms: 100 }));
    const store = new FailoverStore(broken(calls), { guard, fallback: new MemoryStore() });
    for (let i = 0; i < 10; i++) await store.consume(algorithm, `k${i}`, 1);
    expect(calls.n).toBe(3); // 3 failures opened the breaker; the other 7 went straight to the fallback
  });
});

// ---- A REAL Redis client whose server is gone (a closed port): what actually happens to requests ----
describe("Redis unreachable (real ioredis client, closed port)", () => {
  const clients: Redis[] = [];
  const deadRedis = () => {
    // offline queue off + no retries: commands fail at once instead of waiting for a reconnect
    const c = new Redis("redis://127.0.0.1:1", { enableOfflineQueue: false, maxRetriesPerRequest: 0, retryStrategy: () => null, lazyConnect: true });
    c.on("error", () => {});
    clients.push(c);
    return new RedisStore(ioredisClient(c));
  };
  const servers: Server[] = [];
  afterEach(async () => {
    for (const s of servers.splice(0)) {
      s.closeAllConnections();
      await new Promise<void>((r) => s.close(() => r()));
    }
    for (const c of clients.splice(0)) c.disconnect();
  });
  async function app(onStoreError: "error" | "allow" | "deny", store: Store) {
    const a = express();
    a.get("/x", rateLimit(new RateLimiter({ algorithm, store }), { onStoreError }), (_req, res) => res.send("ran"));
    a.use((_e: unknown, _q: express.Request, res: express.Response, _n: express.NextFunction) => res.status(500).send("error handler"));
    const s = await new Promise<Server>((r) => {
      const srv = a.listen(0, "127.0.0.1", () => r(srv));
    });
    servers.push(s);
    return `http://127.0.0.1:${(s.address() as AddressInfo).port}/x`;
  }

  it('onStoreError "allow" (fail OPEN): requests go through, unlimited, without RateLimit headers', async () => {
    const url = await app("allow", deadRedis());
    const rs = [await fetch(url), await fetch(url), await fetch(url)];
    expect(rs.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(rs[0]!.headers.get("ratelimit-limit")).toBeNull();
  });

  it('onStoreError "deny" (fail CLOSED): 503 with Retry-After, the route does not run', async () => {
    const url = await app("deny", deadRedis());
    const r = await fetch(url);
    expect([r.status, r.headers.get("retry-after"), (await r.json()).error]).toEqual([503, "5", "rate_limit_unavailable"]);
  });

  it('onStoreError "error" (default): the app\'s error handler', async () => {
    const url = await app("error", deadRedis());
    expect(await (await fetch(url)).text()).toBe("error handler");
  });

  it("with a FailoverStore + MemoryStore fallback: still limited (per instance) while Redis is down", async () => {
    const url = await app("deny", new FailoverStore(deadRedis(), { fallback: new MemoryStore() }));
    const s = [await fetch(url), await fetch(url), await fetch(url)].map((r) => r.status);
    expect(s).toEqual([200, 200, 429]); // capacity 2, from the local fallback
  });

  it("a bug (cost above the limit) is never failed open: it reaches the error handler even with allow", async () => {
    const a = express();
    a.get("/x", rateLimit(new RateLimiter({ algorithm, store: deadRedis() }), { onStoreError: "allow", cost: () => 99 }), (_q, res) => res.send("ran"));
    a.use((_e: unknown, _q: express.Request, res: express.Response, _n: express.NextFunction) => res.status(500).send("error handler"));
    const s = await new Promise<Server>((r) => {
      const srv = a.listen(0, "127.0.0.1", () => r(srv));
    });
    servers.push(s);
    expect(await (await fetch(`http://127.0.0.1:${(s.address() as AddressInfo).port}/x`)).text()).toBe("error handler");
  });
});
