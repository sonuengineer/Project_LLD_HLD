import express from "express";
import { Redis } from "ioredis";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { cachedJson } from "../src/adapters/express.js";
import { LruCache } from "../src/cache.js";
import { ioredisL2Client, ioredisSubscriber, TwoLevelCache } from "../src/two-level.js";

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

const until = async (cond: () => boolean, what: string) => {
  const end = Date.now() + 10_000;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe("cachedJson (real Express 4 app)", () => {
  it("miss then hit: the producer runs once, X-Cache tells which, the JSON is the same", async () => {
    let calls = 0;
    const cache = new LruCache<string, { id: string; n: number }>({ maxEntries: 100, ttlMs: 60_000 });
    const app = express();
    app.get("/p/:id", cachedJson(cache, { key: (req) => `p:${(req as express.Request).params.id}` }, (req) => ({ id: (req as express.Request).params.id!, n: ++calls })));
    const base = await listen(app);
    const a = await fetch(`${base}/p/7`);
    const b = await fetch(`${base}/p/7`);
    expect([a.status, a.headers.get("x-cache"), await a.json()]).toEqual([200, "miss", { id: "7", n: 1 }]);
    expect([b.status, b.headers.get("x-cache"), await b.json()]).toEqual([200, "hit", { id: "7", n: 1 }]);
    expect(calls).toBe(1);
  });

  it("passes ttlMs on: after it the producer runs again", async () => {
    let t = 0;
    let calls = 0;
    const cache = new LruCache<string, number>({ maxEntries: 10, now: () => t }); // no default TTL
    const app = express();
    app.get("/t", cachedJson(cache, { key: () => "t", ttlMs: 1000 }, () => ++calls));
    const base = await listen(app);
    const get = async () => [(await fetch(`${base}/t`)).headers.get("x-cache"), calls];
    expect(await get()).toEqual(["miss", 1]);
    t = 999;
    expect(await get()).toEqual(["hit", 1]);
    t = 1001;
    expect(await get()).toEqual(["miss", 2]);
  });

  it("different keys are different entries", async () => {
    let calls = 0;
    const cache = new LruCache<string, number>({ maxEntries: 100 });
    const app = express();
    app.get("/p/:id", cachedJson(cache, { key: (req) => `p:${(req as express.Request).params.id}` }, () => ++calls));
    const base = await listen(app);
    expect([await (await fetch(`${base}/p/1`)).json(), await (await fetch(`${base}/p/2`)).json(), await (await fetch(`${base}/p/1`)).json()]).toEqual([1, 2, 1]);
  });

  it("per-user data: the user is IN the key, so users never see each other's data", async () => {
    const cache = new LruCache<string, { cartOf: string }>({ maxEntries: 100 });
    const app = express();
    const user = (req: express.Request) => req.headers["x-user"] as string | undefined;
    app.get("/cart", cachedJson(cache, { key: (req) => (user(req as express.Request) ? `cart:${user(req as express.Request)}` : undefined) }, (req) => ({ cartOf: user(req as express.Request) ?? "anonymous" })));
    const base = await listen(app);
    const as = async (u?: string) => {
      const r = await fetch(`${base}/cart`, { headers: u ? { "x-user": u } : {} });
      return [r.headers.get("x-cache"), (await r.json()).cartOf];
    };
    expect([await as("alice"), await as("bob"), await as("alice"), await as()]).toEqual([
      ["miss", "alice"],
      ["miss", "bob"],
      ["hit", "alice"],
      ["bypass", "anonymous"], // no key -> not cached
    ]);
  });

  it("20 concurrent requests for one key: ONE producer call (no stampede), all get the same answer", async () => {
    let calls = 0;
    let release: () => void = () => {};
    const cache = new LruCache<string, { v: number }>({ maxEntries: 100 });
    const app = express();
    app.get("/slow", cachedJson(cache, { key: () => "slow" }, async () => {
      calls++;
      await new Promise<void>((r) => (release = r));
      return { v: 42 };
    }));
    const base = await listen(app);
    const all = Array.from({ length: 20 }, () => fetch(`${base}/slow`));
    await until(() => calls === 1, "the first load");
    await new Promise((r) => setTimeout(r, 100)); // the other 19 arrive and join it
    release();
    const responses = await Promise.all(all);
    expect(calls).toBe(1);
    expect(await Promise.all(responses.map((r) => r.json()))).toEqual(Array(20).fill({ v: 42 }));
    expect(responses.filter((r) => r.headers.get("x-cache") === "miss")).toHaveLength(1);
  });

  it("not found (null) -> 404, and it is cached like any value", async () => {
    let calls = 0;
    const cache = new LruCache<string, { id: string } | null>({ maxEntries: 100 });
    const app = express();
    app.get("/p/:id", cachedJson(cache, { key: (req) => `p:${(req as express.Request).params.id}` }, () => (calls++, null)));
    const base = await listen(app);
    const r1 = await fetch(`${base}/p/x`);
    const r2 = await fetch(`${base}/p/x`);
    expect([r1.status, await r1.json(), r2.status, r2.headers.get("x-cache"), calls]).toEqual([404, { error: "not_found" }, 404, "hit", 1]);
  });

  it("a producer error is NOT cached: it reaches the error handler, and the next request tries again", async () => {
    let calls = 0;
    const cache = new LruCache<string, string>({ maxEntries: 100 });
    const app = express();
    app.get("/x", cachedJson(cache, { key: () => "x" }, () => {
      if (++calls === 1) throw new Error("db down");
      return "ok";
    }));
    app.use((err: Error, _q: express.Request, res: express.Response, _n: express.NextFunction) => res.status(503).json({ seen: err.message }));
    const base = await listen(app);
    const r1 = await fetch(`${base}/x`);
    expect([r1.status, (await r1.json()).seen]).toEqual([503, "db down"]);
    const r2 = await fetch(`${base}/x`);
    expect([r2.status, await r2.json(), r2.headers.get("x-cache")]).toEqual([200, "ok", "miss"]);
  });

  it("every waiting client disconnects -> the shared load's signal is aborted; one stays -> the load goes on", async () => {
    const seen: AbortSignal[] = [];
    let release: (v: string) => void = () => {};
    const cache = new LruCache<string, string>({ maxEntries: 100 });
    const app = express();
    app.get("/k/:k", cachedJson(cache, { key: (req) => `k:${(req as express.Request).params.k}` }, (_req, signal) => {
      seen.push(signal);
      return new Promise<string>((r) => (release = r));
    }));
    const base = await listen(app);

    const c1 = new AbortController();
    const c2 = new AbortController();
    const p1 = fetch(`${base}/k/a`, { signal: c1.signal }).catch(() => "gone");
    const p2 = fetch(`${base}/k/a`, { signal: c2.signal }).catch(() => "gone");
    await until(() => seen.length === 1, "the load to start");
    await new Promise((r) => setTimeout(r, 100));
    c1.abort();
    c2.abort();
    await Promise.all([p1, p2]);
    await until(() => seen[0]!.aborted, "the load's signal to abort");

    const c3 = new AbortController();
    const p3 = fetch(`${base}/k/b`, { signal: c3.signal }).catch(() => "gone");
    const p4 = fetch(`${base}/k/b`);
    await until(() => seen.length === 2, "the second load");
    await new Promise((r) => setTimeout(r, 100));
    c3.abort();
    await p3;
    await new Promise((r) => setTimeout(r, 100));
    expect(seen[1]!.aborted).toBe(false); // one client still waits
    release("done");
    expect(await (await p4).json()).toBe("done");
  });
});

// ---- Two app instances sharing one Redis L2 ----
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
if (!haveRedis) console.warn(`\n[express-helper.test] two-instance test SKIPPED: no Redis at ${REDIS_URL}\n`);

describe.skipIf(!haveRedis)("two Express instances sharing a TwoLevelCache over one Redis", () => {
  it("instance A loads; instance B answers from Redis WITHOUT running its producer", async () => {
    const prefix = `ckexpress:${process.pid}:${Date.now()}:`;
    const conns: Redis[] = [];
    const conn = () => {
      const c = new Redis(REDIS_URL);
      conns.push(c);
      return c;
    };
    const calls = { a: 0, b: 0 };
    try {
      const bases: string[] = [];
      for (const name of ["a", "b"] as const) {
        const cache = new TwoLevelCache<{ from: string }>({
          l1: new LruCache({ maxEntries: 100, ttlMs: 60_000 }),
          redis: ioredisL2Client(conn()),
          subscriber: ioredisSubscriber(conn()),
          prefix,
        });
        const app = express();
        app.get("/x", cachedJson(cache, { key: () => "shared" }, () => {
          calls[name]++;
          return { from: name };
        }));
        bases.push(await listen(app));
      }
      const a = await fetch(`${bases[0]}/x`);
      expect([a.headers.get("x-cache"), await a.json()]).toEqual(["miss", { from: "a" }]);
      // A writes Redis behind the response (write-behind): wait until the key is really there.
      const admin = conn();
      const end = Date.now() + 10_000;
      while ((await admin.exists(`${prefix}shared`)) !== 1) {
        if (Date.now() > end) throw new Error("A's write never reached Redis");
        await new Promise((r) => setTimeout(r, 10));
      }
      const b = await fetch(`${bases[1]}/x`);
      expect([b.headers.get("x-cache"), await b.json()]).toEqual(["hit", { from: "a" }]);
      expect(calls).toEqual({ a: 1, b: 0 }); // B's producer never ran
    } finally {
      const admin = conns[0]!;
      const keys = await admin.keys(`${prefix}*`);
      if (keys.length > 0) await admin.del(...keys);
      await Promise.all(conns.map((c) => c.quit().catch(() => c.disconnect())));
    }
  });
});
