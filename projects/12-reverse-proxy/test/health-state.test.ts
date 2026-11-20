import { describe, expect, it } from "vitest";
import { Balancer, NoHealthyUpstreamError } from "../src/balancer.js";
import type { HealthEvent } from "../src/balancer.js";

const urls = (...names: string[]) => names.map((n) => new URL(`http://${n}:80`));

/** A balancer whose clock we move by hand, plus the events it reported. */
function make(names: string[], strategy: "round-robin" | "least-connections" = "round-robin", ejectAfter = 3, ejectMs = 10_000) {
  let now = 1000;
  const events: HealthEvent[] = [];
  const b = new Balancer(urls(...names), strategy, { ejectAfter, ejectMs, clock: () => now, onHealthChange: (e) => events.push(e) });
  return { b, events, advance: (ms: number) => (now += ms) };
}

describe("unhealthy targets are skipped", () => {
  for (const strategy of ["round-robin", "least-connections"] as const) {
    it(`${strategy}: never picks a target marked unhealthy`, () => {
      const { b } = make(["a", "b", "c"], strategy);
      b.setHealthy(b.targets[1]!, false, "test");
      const picked = Array.from({ length: 6 }, () => {
        const lease = b.acquire();
        lease.release();
        return lease.target.url.hostname;
      });
      expect(picked).not.toContain("b");
      expect(new Set(picked)).toEqual(new Set(["a", "c"]));
    });
  }

  it("throws NoHealthyUpstreamError when every target is down", () => {
    const { b } = make(["a", "b"]);
    b.setHealthy(b.targets[0]!, false, "test");
    b.setHealthy(b.targets[1]!, false, "test");
    expect(() => b.acquire()).toThrow(NoHealthyUpstreamError);
  });

  it("a target coming back healthy is used again", () => {
    const { b } = make(["a", "b"]);
    b.setHealthy(b.targets[0]!, false, "test");
    b.setHealthy(b.targets[0]!, true, "test");
    const picked = [b.acquire(), b.acquire()].map((l) => l.target.url.hostname);
    expect(picked).toContain("a");
  });
});

describe("passive ejection", () => {
  it("ejects after N consecutive failures, then lets the target back after ejectMs", () => {
    const { b, advance } = make(["a", "b"], "round-robin", 3, 10_000);
    const a = b.targets[0]!;
    b.reportFailure(a);
    b.reportFailure(a);
    expect(b.isAvailable(a)).toBe(true); // 2 of 3
    b.reportFailure(a);
    expect(b.isAvailable(a)).toBe(false);
    advance(9_999);
    expect(b.isAvailable(a)).toBe(false);
    advance(1);
    expect(b.isAvailable(a)).toBe(true);
  });

  it("a success resets the streak, so failures must be CONSECUTIVE", () => {
    const { b } = make(["a"], "round-robin", 3);
    const a = b.targets[0]!;
    b.reportFailure(a);
    b.reportFailure(a);
    b.reportSuccess(a);
    b.reportFailure(a);
    b.reportFailure(a);
    expect(b.isAvailable(a)).toBe(true);
  });

  it("after the ejection ends, ONE more failure ejects it again (single trial request)", () => {
    const { b, advance } = make(["a"], "round-robin", 3, 1000);
    const a = b.targets[0]!;
    for (let i = 0; i < 3; i++) b.reportFailure(a);
    advance(1000);
    expect(b.isAvailable(a)).toBe(true);
    b.reportFailure(a);
    expect(b.isAvailable(a)).toBe(false);
  });

  it("after the ejection ends, a success clears the slate so it needs N failures again", () => {
    const { b, advance } = make(["a"], "round-robin", 3, 1000);
    const a = b.targets[0]!;
    for (let i = 0; i < 3; i++) b.reportFailure(a);
    advance(1000);
    b.reportSuccess(a);
    b.reportFailure(a);
    b.reportFailure(a);
    expect(b.isAvailable(a)).toBe(true);
  });

  it("failures from requests already in flight do not extend an ejection", () => {
    const { b, advance } = make(["a"], "round-robin", 1, 1000);
    const a = b.targets[0]!;
    b.reportFailure(a); // ejected until 2000
    advance(500);
    b.reportFailure(a); // straggler
    advance(500); // now = 2000
    expect(b.isAvailable(a)).toBe(true);
  });

  it("rejects an ejectAfter below 1", () => {
    expect(() => new Balancer(urls("a"), "round-robin", { ejectAfter: 0 })).toThrow(/ejectAfter/);
  });
});

describe("health events", () => {
  it("reports an ejection once, and the recovery once", () => {
    const { b, events } = make(["a"], "round-robin", 2);
    const a = b.targets[0]!;
    b.reportFailure(a);
    b.reportFailure(a);
    b.reportFailure(a); // already ejected: no second event
    b.reportSuccess(a);
    b.reportSuccess(a); // already recovered: no second event
    expect(events.map((e) => e.healthy)).toEqual([false, true]);
    expect(events[0]!.upstream).toBe("a"); // URL.host drops the default port 80
  });

  it("setHealthy reports only real transitions and clears a passive ejection when healthy again", () => {
    const { b, events } = make(["a"], "round-robin", 1);
    const a = b.targets[0]!;
    b.reportFailure(a); // passive ejection
    b.setHealthy(a, false, "probe failed");
    b.setHealthy(a, false, "probe failed again"); // no change, no event
    b.setHealthy(a, true, "probe passed");
    expect(b.isAvailable(a)).toBe(true); // the ejection was cleared too
    expect(events.map((e) => e.healthy)).toEqual([false, false, true]);
  });
});

describe("avoid (used when retrying)", () => {
  it("prefers a different available target", () => {
    const { b } = make(["a", "b", "c"]);
    const a = b.targets[0]!;
    for (let i = 0; i < 5; i++) {
      const lease = b.acquire(a);
      expect(lease.target).not.toBe(a);
      lease.release();
    }
  });

  it("falls back to the same target when it is the only one available", () => {
    const { b } = make(["a", "b"]);
    b.setHealthy(b.targets[1]!, false, "test");
    expect(b.acquire(b.targets[0]!).target).toBe(b.targets[0]);
  });

  it("does not use an avoided target that is unavailable", () => {
    const { b } = make(["a"]);
    b.setHealthy(b.targets[0]!, false, "test");
    expect(() => b.acquire(b.targets[0]!)).toThrow(NoHealthyUpstreamError);
  });
});
