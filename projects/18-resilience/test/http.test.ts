import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { RetryBudget } from "../src/budget.js";
import { TimeoutError } from "../src/errors.js";
import { HttpError, isRetryableHttp, parseRetryAfter } from "../src/http.js";
import { RetryPolicy } from "../src/retry.js";
import { TimeoutPolicy } from "../src/timeout.js";

describe("parseRetryAfter", () => {
  const now = Date.UTC(2026, 10, 23, 10, 0, 0);
  it.each([
    ["120", 120_000],
    ["0", 0],
    [" 5 ", 5000],
    ["Mon, 23 Nov 2026 10:00:30 GMT", 30_000],
    ["Mon, 23 Nov 2026 09:00:00 GMT", 0], // in the past -> now
  ])("%j -> %s ms", (header, ms) => {
    expect(parseRetryAfter(header, now)).toBe(ms);
  });

  it.each([null, undefined, "", "-5", "1.5", "soon"])("%j -> undefined", (header) => {
    expect(parseRetryAfter(header, now)).toBeUndefined();
  });
});

describe("isRetryableHttp", () => {
  it.each([
    [408, true],
    [429, true],
    [500, true],
    [502, true],
    [503, true],
    [504, true],
    [501, false],
    [400, false],
    [401, false],
    [403, false],
    [404, false],
    [422, false],
  ])("HTTP %s -> %s", (status, retry) => {
    expect(isRetryableHttp(new HttpError(status, undefined))).toBe(retry);
  });

  it("network errors and timeouts are retryable", () => {
    expect(isRetryableHttp(new TypeError("fetch failed"))).toBe(true);
    expect(isRetryableHttp(new TimeoutError(100))).toBe(true);
  });
});

// ---- a real HTTP server on loopback, answering from a script ----

type Handler = (req: IncomingMessage, res: ServerResponse) => void;
let server: Server | undefined;

async function serve(handlers: Handler[]): Promise<{ url: string; hits: () => number; closed: () => number }> {
  let hits = 0;
  let closed = 0;
  server = createServer((req, res) => {
    const h = handlers[Math.min(hits, handlers.length - 1)]!;
    hits++;
    res.on("close", () => {
      if (!res.writableFinished) closed++; // the client went away before we answered
    });
    h(req, res);
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/thing`, hits: () => hits, closed: () => closed };
}

afterEach(async () => {
  server?.closeAllConnections();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
});

const status = (code: number, headers: Record<string, string> = {}): Handler => (_req, res) => {
  res.writeHead(code, headers).end();
};
const json = (body: unknown): Handler => (_req, res) => {
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
};
const hang: Handler = () => {};

// How an app would call an API: fetch with the signal, non-2xx turned into an HttpError.
async function getJson(url: string, signal: AbortSignal): Promise<unknown> {
  const res = await fetch(url, { signal });
  if (!res.ok) {
    await res.body?.cancel();
    throw new HttpError(res.status, parseRetryAfter(res.headers.get("retry-after")));
  }
  return res.json();
}

// retry( timeout( fetch ) ): every attempt gets its own timeout; the retry decides what to do about failures.
function client(extra: ConstructorParameters<typeof RetryPolicy>[0] = {}, timeoutMs = 2000) {
  const timeout = new TimeoutPolicy({ ms: timeoutMs });
  const retry = new RetryPolicy({
    maxAttempts: 3,
    backoff: { initialMs: 1, maxMs: 5, jitter: "none" },
    shouldRetry: isRetryableHttp,
    retryAfterMs: (e) => (e instanceof HttpError ? e.retryAfterMs : undefined),
    ...extra,
  });
  return (url: string, signal?: AbortSignal) => retry.execute((s) => timeout.execute((t) => getJson(url, t), s), signal);
}

describe("over real HTTP (loopback server + fetch)", () => {
  it("503, 503, 200: the third request succeeds", async () => {
    const s = await serve([status(503), status(503), json({ ok: 1 })]);
    expect(await client()(s.url)).toEqual({ ok: 1 });
    expect(s.hits()).toBe(3);
  });

  it("404 is not retried", async () => {
    const s = await serve([status(404), json({ ok: 1 })]);
    await expect(client()(s.url)).rejects.toMatchObject({ name: "HttpError", status: 404 });
    expect(s.hits()).toBe(1);
  });

  it("429 with Retry-After: 1 -> the policy waits the 1000 ms the server asked for", async () => {
    const s = await serve([status(429, { "retry-after": "1" }), json({ ok: 2 })]);
    const waits: number[] = [];
    const get = client({ sleep: async (ms) => void waits.push(ms) });
    expect(await get(s.url)).toEqual({ ok: 2 });
    expect(waits).toEqual([1000]);
  });

  it("all attempts 503: the last HttpError comes back unchanged", async () => {
    const s = await serve([status(503)]);
    await expect(client()(s.url)).rejects.toMatchObject({ name: "HttpError", status: 503 });
    expect(s.hits()).toBe(3);
  });

  it("a server that hangs: TimeoutError, and the request is really cancelled (the server sees the connection close)", async () => {
    const s = await serve([hang]);
    const t0 = Date.now();
    const get = client({ maxAttempts: 1 }, 200);
    await expect(get(s.url)).rejects.toBeInstanceOf(TimeoutError);
    expect(Date.now() - t0).toBeLessThan(1500);
    for (let i = 0; i < 50 && s.closed() === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(s.closed()).toBe(1);
  });

  it("hang, hang, 200: each attempt times out on its own and the third succeeds", async () => {
    const s = await serve([hang, hang, json({ ok: 3 })]);
    expect(await client({}, 150)(s.url)).toEqual({ ok: 3 });
    expect(s.hits()).toBe(3);
  });

  it("the caller aborts mid-request: no retry, the server sees the close", async () => {
    const s = await serve([hang]);
    const caller = new AbortController();
    const p = client()(s.url, caller.signal);
    while (s.hits() === 0) await new Promise((r) => setTimeout(r, 5));
    caller.abort(new Error("client went away"));
    await expect(p).rejects.toThrow("client went away");
    for (let i = 0; i < 50 && s.closed() === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect([s.hits(), s.closed()]).toEqual([1, 1]);
  });

  it("server down (connection refused) with a shared budget: retries stop after a few calls", async () => {
    const s = await serve([json({})]);
    const url = s.url;
    server!.close();
    server = undefined;
    let attempts = 0;
    const budget = new RetryBudget();
    const retry = new RetryPolicy({ budget, backoff: { initialMs: 0, jitter: "none" } });
    for (let i = 0; i < 20; i++) {
      await retry
        .execute((sig) => {
          attempts++;
          return fetch(url, { signal: sig });
        })
        .catch(() => {});
    }
    expect(attempts).toBe(23); // 3 + 2 + 18 x 1, as in the simulation
  });
});
