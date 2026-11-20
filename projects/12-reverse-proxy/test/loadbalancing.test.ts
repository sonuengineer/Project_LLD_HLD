import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { Balancer } from "../src/balancer.js";
import type { RequestLog } from "../src/proxy.js";
import { closeAll, deadPort, listen, namedUpstream, startProxy } from "./helpers.js";

afterEach(closeAll);

const get = async (px: number, path = "/") => {
  const res = await fetch(`http://127.0.0.1:${px}${path}`);
  return { status: res.status, body: await res.text() };
};

const settle = () => new Promise((r) => setTimeout(r, 80));

describe("round-robin over real upstreams", () => {
  it("spreads 9 sequential requests evenly, in order", async () => {
    const ports = [await listen(namedUpstream("A")), await listen(namedUpstream("B")), await listen(namedUpstream("C"))];
    const px = await startProxy(ports, { strategy: "round-robin" });
    const bodies: string[] = [];
    for (let i = 0; i < 9; i++) bodies.push((await get(px)).body);
    expect(bodies).toEqual(["A", "B", "C", "A", "B", "C", "A", "B", "C"]);
  });

  it("is the default strategy", async () => {
    const ports = [await listen(namedUpstream("A")), await listen(namedUpstream("B"))];
    const px = await startProxy(ports);
    expect([(await get(px)).body, (await get(px)).body]).toEqual(["A", "B"]);
  });
});

describe("least-connections over real upstreams", () => {
  it("steers new requests away from an upstream that is stuck on a slow request", async () => {
    let stuck: http.ServerResponse | undefined;
    let slowGotIt: () => void = () => undefined;
    const arrived = new Promise<void>((resolve) => (slowGotIt = resolve));
    const slow = http.createServer((_req, res) => {
      stuck = res; // hold it open on purpose
      slowGotIt();
    });
    const slowPort = await listen(slow);
    const fastPort = await listen(namedUpstream("fast"));

    const balancer = new Balancer([new URL(`http://127.0.0.1:${slowPort}`), new URL(`http://127.0.0.1:${fastPort}`)], "least-connections");
    const px = await startProxy([slowPort, fastPort], { balancer });

    const first = fetch(`http://127.0.0.1:${px}/slow-one`).then((r) => r.text()); // idle tie -> first target (slow)
    await arrived;
    expect(balancer.targets[0]!.active).toBe(1);

    const bodies: string[] = [];
    for (let i = 0; i < 6; i++) bodies.push((await get(px)).body);
    expect(bodies).toEqual(["fast", "fast", "fast", "fast", "fast", "fast"]);

    stuck!.end("slow-done");
    expect(await first).toBe("slow-done");
    await settle();
    expect(balancer.targets.map((t) => t.active)).toEqual([0, 0]);
  });
});

describe("active-request accounting", () => {
  it("returns to zero after success, upstream failure, client abort and a mid-response drop", async () => {
    const ok = await listen(namedUpstream("ok"));
    const dead = await deadPort();
    let clientLeft: () => void = () => undefined;
    const sawRequest = new Promise<void>((resolve) => (clientLeft = resolve));
    const hang = await listen(
      http.createServer(() => {
        clientLeft(); // never answers
      }),
    );
    const cut = await listen(
      http.createServer((_req, res) => {
        res.writeHead(200, { "content-length": "100" });
        res.write("x");
        setTimeout(() => res.destroy(), 20);
      }),
    );

    const balancer = new Balancer([ok, dead, hang, cut].map((p) => new URL(`http://127.0.0.1:${p}`)), "round-robin");
    const px = await startProxy([ok, dead, hang, cut], { balancer, retries: 0 }); // retries off: this test is about one attempt per request

    expect((await get(px)).status).toBe(200); // ok
    expect((await get(px)).status).toBe(502); // dead

    const ctl = new AbortController();
    const hung = fetch(`http://127.0.0.1:${px}/`, { signal: ctl.signal }).catch(() => undefined); // hang
    await sawRequest;
    expect(balancer.targets[2]!.active).toBe(1); // proves the counter really was up while it hung
    ctl.abort();
    await hung;

    const res = await fetch(`http://127.0.0.1:${px}/`); // cut
    await expect(res.text()).rejects.toThrow();

    await settle();
    expect(balancer.targets.map((t) => t.active)).toEqual([0, 0, 0, 0]);
  });
});

describe("balancing alone does not give availability", () => {
  it("with retries and ejection switched off, a dead upstream still gets its share of traffic", async () => {
    const live = await listen(namedUpstream("live"));
    const dead = await deadPort();
    const px = await startProxy([live, dead], { strategy: "round-robin", retries: 0, ejectAfter: 1000 });
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) statuses.push((await get(px)).status);
    expect(statuses).toEqual([200, 502, 200, 502]);
  });
});

describe("logging and construction", () => {
  it("logs which upstream served each request", async () => {
    const entries: RequestLog[] = [];
    const a = await listen(namedUpstream("A"));
    const b = await listen(namedUpstream("B"));
    const px = await startProxy([a, b], { log: (e) => entries.push(e) });
    await get(px);
    await get(px);
    await settle();
    expect(entries.map((e) => e.upstream)).toEqual([`127.0.0.1:${a}`, `127.0.0.1:${b}`]);
  });

  it("requires an upstream or a balancer, and validates every URL in a list", async () => {
    const { createProxy } = await import("../src/proxy.js");
    expect(() => createProxy({})).toThrow(/required/);
    expect(() => createProxy({ upstream: [new URL("http://a.test"), new URL("https://b.test")] })).toThrow(/http/);
  });
});
