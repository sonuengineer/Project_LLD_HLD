import express from "express";
import { Redis } from "ioredis";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { keyByIp, rateLimit } from "../src/adapters/express.js";
import { slidingWindow, tokenBucket } from "../src/algorithms.js";
import { RateLimiter, type Store } from "../src/limiter.js";
import { MemoryStore } from "../src/memory-store.js";
import { ioredisClient, RedisStore } from "../src/redis-store.js";

const servers: Server[] = [];
async function listen(app: express.Express): Promise<string> {
  const s = await new Promise<Server>((r) => {
    const srv = app.listen(0, "127.0.0.1", () => r(srv));
  });
  servers.push(s);
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
});

const memoryLimiter = (capacity: number, prefix = "rl:") =>
  new RateLimiter({ algorithm: tokenBucket({ capacity, refillPerSec: 0.001 }), store: new MemoryStore(), prefix });

describe("Express middleware (real Express 4 app)", () => {
  it("allows `limit` requests with RateLimit-* headers, then 429 with Retry-After; the route does not run", async () => {
    let ran = 0;
    const app = express();
    app.get("/x", rateLimit(memoryLimiter(3)), (_req, res) => {
      ran++;
      res.json({ ok: true });
    });
    const base = await listen(app);
    const remaining: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await fetch(`${base}/x`);
      expect(r.status).toBe(200);
      expect(r.headers.get("ratelimit-limit")).toBe("3");
      remaining.push(r.headers.get("ratelimit-remaining")!);
    }
    expect(remaining).toEqual(["2", "1", "0"]);
    const denied = await fetch(`${base}/x`);
    expect(denied.status).toBe(429);
    expect(Number(denied.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(await denied.json()).toEqual({ error: "rate_limited", message: "Too many requests. Try again later." });
    expect(ran).toBe(3);
  });

  it("a forged X-Forwarded-For does NOT give a fresh limit (default ignores the header)", async () => {
    const app = express();
    app.get("/x", rateLimit(memoryLimiter(2)), (_req, res) => res.send("ok"));
    const base = await listen(app);
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await fetch(`${base}/x`, { headers: { "x-forwarded-for": `10.9.9.${i}` } })).status);
    expect(statuses).toEqual([200, 200, 429, 429, 429]);
  });

  it("behind one trusted proxy: clients are told apart by the proxy-appended address", async () => {
    const app = express();
    app.get("/x", rateLimit(memoryLimiter(1), { key: keyByIp({ trustedProxies: 1 }) }), (_req, res) => res.send("ok"));
    const base = await listen(app);
    const as = (ip: string) => fetch(`${base}/x`, { headers: { "x-forwarded-for": `6.6.6.6, ${ip}` } }).then((r) => r.status);
    expect([await as("203.0.113.1"), await as("203.0.113.2"), await as("203.0.113.1")]).toEqual([200, 200, 429]);
  });

  it("custom key (per user) and undefined = not limited by this limiter", async () => {
    const app = express();
    const perUser = rateLimit(memoryLimiter(1, "rl:user:"), { key: (req) => (req.headers["x-user"] as string | undefined) ?? undefined });
    app.get("/x", perUser, (_req, res) => res.send("ok"));
    const base = await listen(app);
    const get = (user?: string) => fetch(`${base}/x`, { headers: user ? { "x-user": user } : {} }).then((r) => r.status);
    expect([await get("alice"), await get("alice"), await get("bob"), await get(), await get(), await get()]).toEqual([200, 429, 200, 200, 200, 200]);
  });

  it("two limiters stacked (per IP and per user): the first denial wins, the route never runs", async () => {
    let ran = 0;
    const app = express();
    app.get("/x", rateLimit(memoryLimiter(10, "rl:ip:")), rateLimit(memoryLimiter(1, "rl:u:"), { key: () => "user:1" }), (_req, res) => {
      ran++;
      res.send("ok");
    });
    const base = await listen(app);
    expect([(await fetch(`${base}/x`)).status, (await fetch(`${base}/x`)).status]).toEqual([200, 429]);
    expect(ran).toBe(1);
  });

  it("cost per request (e.g. a bulk endpoint costs 5)", async () => {
    const app = express();
    app.get("/bulk", rateLimit(memoryLimiter(10), { cost: () => 5 }), (_req, res) => res.send("ok"));
    const base = await listen(app);
    const s = [(await fetch(`${base}/bulk`)).status, (await fetch(`${base}/bulk`)).status, (await fetch(`${base}/bulk`)).status];
    expect(s).toEqual([200, 200, 429]);
  });

  it("headers: false sends no RateLimit-* on allowed responses (still on the 429)", async () => {
    const app = express();
    app.get("/x", rateLimit(memoryLimiter(1), { headers: false }), (_req, res) => res.send("ok"));
    const base = await listen(app);
    expect((await fetch(`${base}/x`)).headers.get("ratelimit-limit")).toBeNull();
    const denied = await fetch(`${base}/x`);
    expect([denied.status, denied.headers.get("ratelimit-limit"), denied.headers.get("retry-after") !== null]).toEqual([429, "1", true]);
  });

  it("a store error (e.g. Redis down) goes to the app's error handler; the route does not run", async () => {
    let ran = 0;
    const broken: Store = { consume: async () => Promise.reject(new Error("ECONNREFUSED redis")) };
    const app = express();
    app.get("/x", rateLimit(new RateLimiter({ algorithm: tokenBucket({ capacity: 1, refillPerSec: 1 }), store: broken })), () => ran++);
    app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(503).json({ seen: err.message }));
    const base = await listen(app);
    const r = await fetch(`${base}/x`);
    expect([r.status, (await r.json()).seen, ran]).toEqual([503, "ECONNREFUSED redis", 0]);
  });

  it("a key function that throws also goes to the error handler", async () => {
    const app = express();
    app.get("/x", rateLimit(memoryLimiter(1), { key: () => { throw new Error("no session"); } }), (_req, res) => res.send("ok"));
    app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(500).send(err.message));
    const base = await listen(app);
    expect(await (await fetch(`${base}/x`)).text()).toBe("no session");
  });
});

// ---- Two app instances, one Redis: the limit holds ACROSS instances ----
const REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:56379";
async function redisUp(): Promise<boolean> {
  const r = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 0, retryStrategy: () => null, connectTimeout: 1000 });
  try {
    await r.connect();
    return (await r.ping()) === "PONG";
  } catch {
    return false;
  } finally {
    r.disconnect();
  }
}
const haveRedis = await redisUp();
if (!haveRedis) console.warn(`\n[express.test] multi-instance test SKIPPED: no Redis at ${REDIS_URL}\n`);

describe.skipIf(!haveRedis)("two Express instances sharing one Redis", () => {
  it("limit 10 per window, 30 requests spread over 2 instances (15 each, concurrently) -> exactly 10 allowed in total", async () => {
    const prefix = `rltest:${process.pid}:multi:`;
    const clients = [new Redis(REDIS_URL), new Redis(REDIS_URL)];
    try {
      const bases: string[] = [];
      for (const c of clients) {
        const limiter = new RateLimiter({ algorithm: slidingWindow({ limit: 10, windowMs: 60_000 }), store: new RedisStore(ioredisClient(c)), prefix });
        const app = express();
        app.get("/x", rateLimit(limiter, { key: () => "shared-client" }), (_req, res) => res.send("ok"));
        bases.push(await listen(app));
      }
      const statuses = await Promise.all(Array.from({ length: 30 }, (_, i) => fetch(`${bases[i % 2]}/x`).then((r) => r.status)));
      expect(statuses.filter((s) => s === 200)).toHaveLength(10);
      expect(statuses.filter((s) => s === 429)).toHaveLength(20);
    } finally {
      const keys = await clients[0]!.keys(`${prefix}*`);
      if (keys.length > 0) await clients[0]!.del(...keys);
      await Promise.all(clients.map((c) => c.quit()));
    }
  });
});
