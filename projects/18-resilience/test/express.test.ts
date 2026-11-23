import express from "express";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadShedding, requestSignal, resilienceErrorHandler } from "../src/adapters/express.js";
import { CircuitBreaker } from "../src/breaker.js";
import { Bulkhead } from "../src/bulkhead.js";
import { ClientClosedError } from "../src/errors.js";
import { isRetryableHttp } from "../src/http.js";
import { RetryPolicy } from "../src/retry.js";
import { TimeoutPolicy } from "../src/timeout.js";
import { wrap } from "../src/wrap.js";
import { addressOf, eventually, getJson, hang, json, status, upstream, type Upstream } from "./support.js";

let up: Upstream;
let server: Server;
let base: string;
let breaker: CircuitBreaker;
let shed: Bulkhead;
let lastSignal: AbortSignal | undefined;
let release: (() => void)[] = [];
let passedOn: unknown[] = [];

beforeEach(async () => {
  up = await upstream(json({ from: "upstream" }));
  breaker = new CircuitBreaker({ windowSize: 2, minimumCalls: 2, openMs: 5000, isFailure: isRetryableHttp });
  shed = new Bulkhead({ maxConcurrent: 2, maxQueue: 0 });
  release = [];
  const policy = wrap(new RetryPolicy({ maxAttempts: 1 }), breaker, new TimeoutPolicy({ ms: 200 }));

  const app = express();
  app.get("/proxy", async (req, res, next) => {
    try {
      lastSignal = requestSignal(req, res);
      res.json(await policy.execute((s) => getJson(up.url, s), lastSignal));
    } catch (e) {
      next(e);
    }
  });
  // Long timeout for the disconnect test: only the CLIENT may end this call (see nestjs.test.ts for why).
  app.get("/proxy-long", async (req, res, next) => {
    try {
      lastSignal = requestSignal(req, res);
      res.json(await new TimeoutPolicy({ ms: 15_000 }).execute((s) => getJson(up.url, s), lastSignal));
    } catch (e) {
      next(e);
    }
  });
  app.get("/boom", () => {
    throw new Error("not a resilience error");
  });
  app.get("/slow", loadShedding(shed), (_req, res) => {
    release.push(() => res.json({ done: true }));
  });
  app.use(resilienceErrorHandler());
  // The app's own last error handler: anything our handler does not map must arrive here, unchanged.
  passedOn = [];
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    passedOn.push(err);
    res.status(500).json({ handledBy: "app" });
  });
  server = await new Promise<Server>((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  base = addressOf(server);
});

afterEach(async () => {
  for (const r of release) r();
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  await up.close();
});

describe("Express adapter (real Express 4 app, real upstream server)", () => {
  it("passes a normal answer through, and the request signal is NOT aborted after a normal response", async () => {
    const res = await fetch(`${base}/proxy`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ from: "upstream" });
    await new Promise((r) => setTimeout(r, 20));
    expect(lastSignal!.aborted).toBe(false);
  });

  it("upstream hangs -> 504 with a generic JSON body", async () => {
    up.setHandler(hang);
    const res = await fetch(`${base}/proxy`);
    expect(res.status).toBe(504);
    expect(await res.json()).toEqual({ error: "dependency_timeout", message: "A service we depend on did not answer in time." });
  });

  it("upstream 503 twice -> breaker open -> 503 with Retry-After, and the upstream is not called", async () => {
    up.setHandler(status(503));
    await fetch(`${base}/proxy`);
    await fetch(`${base}/proxy`);
    expect(breaker.state).toBe("open");
    const res = await fetch(`${base}/proxy`);
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("5");
    expect((await res.json()).error).toBe("dependency_unavailable");
    expect(up.hits()).toBe(2);
  });

  it("errors it does not map reach the app's own error handler unchanged", async () => {
    up.setHandler(status(404));
    const res = await fetch(`${base}/proxy`);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ handledBy: "app" });
    const boom = await fetch(`${base}/boom`);
    expect(await boom.json()).toEqual({ handledBy: "app" });
    expect(passedOn.map((e) => (e as Error).name)).toEqual(["HttpError", "Error"]);
  });

  it("an upstream 404 / 401 is NOT passed on as our status by Express's DEFAULT handler", async () => {
    const plain = express();
    plain.get("/x", async (_req, res, next) => {
      try {
        res.json(await getJson(up.url, new AbortController().signal));
      } catch (e) {
        next(e);
      }
    });
    plain.use(resilienceErrorHandler()); // then Express's built-in final handler
    const s = await new Promise<Server>((r) => {
      const srv = plain.listen(0, "127.0.0.1", () => r(srv));
    });
    try {
      up.setHandler(status(404));
      expect((await fetch(`${addressOf(s)}/x`)).status).toBe(500); // was 404 while HttpError had a `status` field
      up.setHandler(status(401));
      expect((await fetch(`${addressOf(s)}/x`)).status).toBe(500); // our client is NOT unauthorized
    } finally {
      s.closeAllConnections();
      await new Promise<void>((r) => s.close(() => r()));
    }
  });

  it("the client disconnects -> the upstream request is cancelled (the upstream sees the close)", async () => {
    up.setHandler(hang);
    const client = new AbortController();
    const p = fetch(`${base}/proxy-long`, { signal: client.signal }).catch((e: unknown) => e);
    await eventually(() => up.hits() === 1);
    client.abort();
    await p;
    await eventually(() => up.closedEarly() === 1);
    expect(lastSignal!.aborted).toBe(true);
    expect(lastSignal!.reason).toBeInstanceOf(ClientClosedError);
  });

  it("loadShedding: 2 slots; the 3rd concurrent request gets 503 at once; a finished request frees its slot", async () => {
    const a = fetch(`${base}/slow`);
    const b = fetch(`${base}/slow`);
    await eventually(() => release.length === 2);
    const c = await fetch(`${base}/slow`);
    expect(c.status).toBe(503);
    expect((await c.json()).error).toBe("overloaded");
    release.shift()!();
    expect((await a).status).toBe(200);
    await eventually(() => shed.running === 1);
    const d = fetch(`${base}/slow`);
    await eventually(() => release.length === 2);
    release.splice(0).forEach((r) => r());
    expect((await b).status).toBe(200);
    expect((await d).status).toBe(200);
    await eventually(() => shed.running === 0);
  });

  it("loadShedding: a client that disconnects mid-request frees its slot", async () => {
    const client = new AbortController();
    const p = fetch(`${base}/slow`, { signal: client.signal }).catch(() => {});
    await eventually(() => shed.running === 1);
    client.abort();
    await p;
    await eventually(() => shed.running === 0);
    release = []; // its response object is gone
  });
});
