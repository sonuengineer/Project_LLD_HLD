import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { Balancer } from "../src/balancer.js";
import type { HealthEvent } from "../src/balancer.js";
import type { RequestLog } from "../src/proxy.js";
import { closeAll, countingUpstream, deadPort, listen, namedUpstream, startProxy, waitFor } from "./helpers.js";

afterEach(closeAll);

const send = async (px: number, init?: RequestInit) => {
  const res = await fetch(`http://127.0.0.1:${px}/`, init);
  return { status: res.status, body: await res.text(), headers: res.headers };
};
const settle = () => new Promise((r) => setTimeout(r, 80));

describe("retries", () => {
  it("a GET that hits a dead upstream is retried on a live one and the client sees 200", async () => {
    const entries: RequestLog[] = [];
    const dead = await deadPort();
    const live = await listen(namedUpstream("live"));
    const px = await startProxy([dead, live], { strategy: "round-robin", log: (e) => entries.push(e) });
    const first = await send(px);
    expect(first).toMatchObject({ status: 200, body: "live" });
    await settle();
    expect(entries[0]).toMatchObject({ attempts: 2, status: 200, upstream: `127.0.0.1:${live}` });
  });

  it("a POST is NOT retried: its body was streamed and cannot be replayed", async () => {
    const dead = await deadPort();
    const liveUp = countingUpstream("live");
    const live = await listen(liveUp.server);
    const px = await startProxy([dead, live], { strategy: "round-robin" });
    const res = await send(px, { method: "POST", body: "payload" });
    expect(res.status).toBe(502);
    expect(liveUp.hits()).toBe(0);
  });

  it("a POST with NO body is still not retried: the method is not safe to repeat, whatever the body", async () => {
    const dead = await deadPort();
    const liveUp = countingUpstream("live");
    const live = await listen(liveUp.server);
    const px = await startProxy([dead, live], { strategy: "round-robin" });
    expect((await send(px, { method: "POST" })).status).toBe(502);
    expect((await send(px, { method: "DELETE" })).status).toBe(200); // round-robin moved on to live, no retry involved
    expect(liveUp.hits()).toBe(1);
  });

  it("retries: 0 turns retrying off even for GET", async () => {
    const dead = await deadPort();
    const live = await listen(namedUpstream("live"));
    const px = await startProxy([dead, live], { strategy: "round-robin", retries: 0 });
    expect((await send(px)).status).toBe(502);
  });

  it("never retries once response bytes have reached the client (mid-body failure)", async () => {
    let hits = 0;
    const cut = http.createServer((_req, res) => {
      hits++;
      res.writeHead(200, { "content-length": "100" });
      res.write("x");
      setTimeout(() => res.destroy(), 20);
    });
    const other = countingUpstream("other");
    const px = await startProxy([await listen(cut), await listen(other.server)], { strategy: "round-robin" });
    const res = await fetch(`http://127.0.0.1:${px}/`);
    await expect(res.text()).rejects.toThrow();
    expect(hits).toBe(1);
    expect(other.hits()).toBe(0);
  });

  it("does not retry a response-idle timeout (slow is not unreachable)", async () => {
    const hang = http.createServer(() => undefined);
    const other = countingUpstream("other");
    const px = await startProxy([await listen(hang), await listen(other.server)], { strategy: "round-robin", upstreamTimeoutMs: 100 });
    const res = await send(px);
    expect(res.status).toBe(504);
    expect(other.hits()).toBe(0);
  });

  it("recovers from a connection the upstream reset before answering, even with ONE upstream (stale keep-alive case)", async () => {
    let calls = 0;
    const flaky = http.createServer((req, res) => {
      calls++;
      if (calls === 1) {
        req.socket.destroy(); // closes without any response, like an idle pooled socket the server already dropped
        return;
      }
      res.end("second time lucky");
    });
    const entries: RequestLog[] = [];
    const px = await startProxy(await listen(flaky), { log: (e) => entries.push(e) });
    const res = await send(px);
    expect(res).toMatchObject({ status: 200, body: "second time lucky" });
    await settle();
    expect(entries[0]!.attempts).toBe(2);
  });

  it("gives up with 502 after the allowed attempts when everything is down", async () => {
    const entries: RequestLog[] = [];
    const px = await startProxy(await deadPort(), { log: (e) => entries.push(e) });
    expect((await send(px)).status).toBe(502);
    await settle();
    expect(entries[0]!.attempts).toBe(2); // 1 try + 1 retry, then stop
  });

  it("a retry goes to a DIFFERENT upstream, even when the one that just failed looks less busy", async () => {
    const dead = await deadPort();
    let liveCalls = 0;
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    const live = await listen(
      http.createServer((_q, r) => {
        liveCalls++;
        if (liveCalls === 1) void held.then(() => r.end("held")); // keeps `live` busy
        else r.end("live");
      }),
    );
    const px = await startProxy([dead, live], { strategy: "least-connections", ejectAfter: 1000 });
    const first = fetch(`http://127.0.0.1:${px}/`).then((r) => r.text()); // dead fails, retry lands on live and is held
    await waitFor(() => liveCalls === 1, "first request to be held on live");
    // live has 1 active, dead has 0: least-connections would choose dead again unless the retry avoids it
    const second = await send(px);
    expect(second).toMatchObject({ status: 200, body: "live" });
    release();
    expect(await first).toBe("held");
  });

  it("leaves every counter at zero after retried and failed requests", async () => {
    const dead = await deadPort();
    const live = await listen(namedUpstream("live"));
    const balancer = new Balancer([new URL(`http://127.0.0.1:${dead}`), new URL(`http://127.0.0.1:${live}`)], "round-robin", { ejectAfter: 1000 });
    const px = await startProxy([dead, live], { balancer });
    for (let i = 0; i < 6; i++) await send(px);
    await settle();
    expect(balancer.targets.map((t) => t.active)).toEqual([0, 0]);
  });
});

describe("passive health on real traffic", () => {
  it("stops sending to an upstream after it fails ejectAfter times in a row", async () => {
    const dead = await deadPort();
    const live = await listen(namedUpstream("live"));
    const events: HealthEvent[] = [];
    const px = await startProxy([dead, live], { strategy: "round-robin", retries: 0, ejectAfter: 2, onHealthChange: (e) => events.push(e) });
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await send(px)).status);
    // dead(502) live dead(502 -> ejected) live live live
    expect(statuses).toEqual([502, 200, 502, 200, 200, 200]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ upstream: `127.0.0.1:${dead}`, healthy: false });
  });

  it("failures must be consecutive on real traffic: a success in between keeps the upstream in rotation", async () => {
    let calls = 0;
    const flaky = http.createServer((req, res) => {
      calls++;
      if (calls % 2 === 1) req.socket.destroy(); // odd calls fail, even calls succeed
      else res.end("ok");
    });
    const px = await startProxy(await listen(flaky), { retries: 0, ejectAfter: 2 });
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await send(px)).status);
    expect(statuses).toEqual([502, 200, 502, 200, 502, 200]); // never 503: it is never ejected
  });

  it("an upstream that answers 500 is NOT ejected (reachable, so not a connection failure)", async () => {
    const broken = http.createServer((_q, r) => r.writeHead(500).end("app bug"));
    const px = await startProxy(await listen(broken), { retries: 0, ejectAfter: 2 });
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await send(px)).status);
    expect(statuses).toEqual([500, 500, 500, 500, 500]); // never turned into 503
  });

  it("answers 503 with Retry-After when no upstream is available", async () => {
    const px = await startProxy(await deadPort(), { retries: 0, ejectAfter: 1 });
    expect((await send(px)).status).toBe(502); // the failure that ejects it
    const second = await send(px);
    expect(second.status).toBe(503);
    expect(second.headers.get("retry-after")).toBe("1");
  });

  it("a client that gives up does not count as an upstream failure", async () => {
    const hang = http.createServer(() => undefined);
    const balancer = new Balancer([new URL(`http://127.0.0.1:${await listen(hang)}`)], "round-robin", { ejectAfter: 1 });
    const px = await startProxy(1, { balancer }); // port ignored: the injected balancer decides
    for (let i = 0; i < 3; i++) {
      const ctl = new AbortController();
      const p = fetch(`http://127.0.0.1:${px}/`, { signal: ctl.signal }).catch(() => undefined);
      await waitFor(() => balancer.targets[0]!.active === 1, "request to reach the upstream");
      ctl.abort();
      await p;
      await waitFor(() => balancer.targets[0]!.active === 0, "counter to return to zero");
    }
    expect(balancer.isAvailable(balancer.targets[0]!)).toBe(true);
  });
});

describe("active health checks end to end", () => {
  it("takes an unhealthy upstream out of rotation and puts it back when it recovers", async () => {
    let bHealthy = false;
    const a = await listen(
      http.createServer((q, r) => {
        r.writeHead(q.url === "/health" ? 200 : 200).end("A");
      }),
    );
    const b = await listen(
      http.createServer((q, r) => {
        if (q.url === "/health") r.writeHead(bHealthy ? 200 : 500).end();
        else r.end("B");
      }),
    );
    const events: HealthEvent[] = [];
    const px = await startProxy([a, b], {
      strategy: "round-robin",
      healthCheck: { path: "/health", intervalMs: 20, timeoutMs: 200, unhealthyThreshold: 2, healthyThreshold: 2 },
      onHealthChange: (e) => events.push(e),
    });

    await waitFor(() => events.some((e) => !e.healthy), "B to be marked unhealthy");
    const bodies: string[] = [];
    for (let i = 0; i < 6; i++) bodies.push((await send(px)).body);
    expect(bodies).toEqual(["A", "A", "A", "A", "A", "A"]);

    bHealthy = true;
    await waitFor(() => events.some((e) => e.healthy), "B to be marked healthy again");
    const later: string[] = [];
    for (let i = 0; i < 4; i++) later.push((await send(px)).body);
    expect(later).toContain("B");
    expect(events.map((e) => e.upstream)).toEqual([`127.0.0.1:${b}`, `127.0.0.1:${b}`]);
  });
});

describe("connect timeout wiring", () => {
  it("does not cut off a normal request that is merely slow to answer (the timer is cleared on connect)", async () => {
    const slow = http.createServer((_q, r) => setTimeout(() => r.end("slow but fine"), 250));
    const px = await startProxy(await listen(slow), { connectTimeoutMs: 80 });
    expect(await send(px)).toMatchObject({ status: 200, body: "slow but fine" });
  });
});
