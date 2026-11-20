import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Balancer } from "../src/balancer.js";
import type { HealthEvent } from "../src/balancer.js";
import { HealthChecker, httpProbe } from "../src/health.js";
import type { Probe } from "../src/health.js";
import { closeAll, deadPort, listen } from "./helpers.js";
import { watchConnect } from "../src/connect.js";
import type { ClientRequest } from "node:http";
import { EventEmitter } from "node:events";

afterEach(closeAll);

/** Probe results come from a script: one array of booleans per host, consumed one per round. */
function scripted(script: Record<string, boolean[]>): Probe {
  const used: Record<string, number> = {};
  return async (base) => {
    const host = base.hostname;
    const i = used[host] ?? 0;
    used[host] = i + 1;
    const results = script[host]!;
    return results[Math.min(i, results.length - 1)]!;
  };
}

const setup = (script: Record<string, boolean[]>, unhealthy = 2, healthy = 2) => {
  const events: HealthEvent[] = [];
  const b = new Balancer([new URL("http://a:80"), new URL("http://b:80")], "round-robin", { onHealthChange: (e) => events.push(e) });
  const checker = new HealthChecker(b, { path: "/health", probe: scripted(script), unhealthyThreshold: unhealthy, healthyThreshold: healthy });
  return { b, events, checker };
};

describe("HealthChecker thresholds", () => {
  it("one failed probe does not mark a target down; two in a row do", async () => {
    const { b, checker } = setup({ a: [false, false], b: [true] });
    await checker.checkOnce();
    expect(b.targets[0]!.healthy).toBe(true);
    await checker.checkOnce();
    expect(b.targets[0]!.healthy).toBe(false);
    expect(b.targets[1]!.healthy).toBe(true);
  });

  it("a pass in between resets the failure streak (no flapping on a lone blip)", async () => {
    const { b, checker } = setup({ a: [false, true, false, true], b: [true] });
    for (let i = 0; i < 4; i++) await checker.checkOnce();
    expect(b.targets[0]!.healthy).toBe(true);
  });

  it("a down target needs healthyThreshold passes in a row to come back", async () => {
    const { b, checker } = setup({ a: [false, false, true, true], b: [true] });
    await checker.checkOnce();
    await checker.checkOnce();
    expect(b.targets[0]!.healthy).toBe(false);
    await checker.checkOnce(); // 1 pass
    expect(b.targets[0]!.healthy).toBe(false);
    await checker.checkOnce(); // 2 passes
    expect(b.targets[0]!.healthy).toBe(true);
  });

  it("a probe that throws counts as a failure", async () => {
    const b = new Balancer([new URL("http://a:80")]);
    const checker = new HealthChecker(b, {
      path: "/h",
      unhealthyThreshold: 1,
      probe: async () => {
        throw new Error("boom");
      },
    });
    await checker.checkOnce();
    expect(b.targets[0]!.healthy).toBe(false);
  });

  it("reports transitions as health events", async () => {
    const { events, checker } = setup({ a: [false, false, true, true], b: [true] });
    for (let i = 0; i < 4; i++) await checker.checkOnce();
    expect(events.map((e) => [e.upstream, e.healthy])).toEqual([
      ["a", false],
      ["a", true],
    ]);
  });

  it("rejects a path that does not start with /", () => {
    expect(() => new HealthChecker(new Balancer([new URL("http://a:80")]), { path: "health" })).toThrow(/start with/);
  });
});

describe("httpProbe against real servers", () => {
  const serveStatus = async (status: number) => listen(http.createServer((_q, r) => r.writeHead(status).end()));
  const base = (port: number) => new URL(`http://127.0.0.1:${port}`);

  it("treats 2xx and 3xx as healthy and 4xx and 5xx as unhealthy", async () => {
    expect(await httpProbe(base(await serveStatus(200)), "/h", 1000)).toBe(true);
    expect(await httpProbe(base(await serveStatus(302)), "/h", 1000)).toBe(true);
    expect(await httpProbe(base(await serveStatus(404)), "/h", 1000)).toBe(false);
    expect(await httpProbe(base(await serveStatus(503)), "/h", 1000)).toBe(false);
  });

  it("treats a refused connection and a hung server as unhealthy", async () => {
    expect(await httpProbe(base(await deadPort()), "/h", 1000)).toBe(false);
    const hung = await listen(http.createServer(() => undefined));
    const started = Date.now();
    expect(await httpProbe(base(hung), "/h", 100)).toBe(false);
    expect(Date.now() - started).toBeLessThan(1500);
  });
});

describe("watchConnect (connect timeout helper)", () => {
  const fakes = (connecting: boolean) => {
    const socket = Object.assign(new EventEmitter(), { connecting });
    const req = new EventEmitter();
    return { socket, req: req as unknown as ClientRequest, give: () => req.emit("socket", socket) };
  };

  it("fires when the connection is not established in time", () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const { req, give } = fakes(true);
    watchConnect(req, 100, onTimeout);
    give();
    vi.advanceTimersByTime(99);
    expect(onTimeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("does not fire once the socket connected", () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const { socket, req, give } = fakes(true);
    watchConnect(req, 100, onTimeout);
    give();
    socket.emit("connect");
    vi.advanceTimersByTime(1000);
    expect(onTimeout).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("does not fire if the socket closes first", () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const { socket, req, give } = fakes(true);
    watchConnect(req, 100, onTimeout);
    give();
    socket.emit("close");
    vi.advanceTimersByTime(1000);
    expect(onTimeout).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("ignores a reused keep-alive socket that is already connected", () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const { req, give } = fakes(false);
    watchConnect(req, 100, onTimeout);
    give();
    vi.advanceTimersByTime(1000);
    expect(onTimeout).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
