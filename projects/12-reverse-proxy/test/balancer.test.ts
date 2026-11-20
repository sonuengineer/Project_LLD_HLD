import { describe, expect, it } from "vitest";
import { Balancer } from "../src/balancer.js";

const urls = (...names: string[]) => names.map((n) => new URL(`http://${n}:80`));
const names = (leases: { target: { url: URL } }[]) => leases.map((l) => l.target.url.hostname);

describe("construction", () => {
  it("needs at least one upstream and a known strategy", () => {
    expect(() => new Balancer([])).toThrow(/at least one/);
    expect(() => new Balancer(urls("a"), "random" as never)).toThrow(/unknown strategy/);
  });
});

describe("round-robin", () => {
  it("cycles through the targets in order", () => {
    const b = new Balancer(urls("a", "b", "c"), "round-robin");
    const picked = Array.from({ length: 7 }, () => b.acquire().target.url.hostname);
    expect(picked).toEqual(["a", "b", "c", "a", "b", "c", "a"]);
  });

  it("ignores load: a busy target still gets its turn", () => {
    const b = new Balancer(urls("a", "b"), "round-robin");
    b.acquire(); // a, never released
    b.acquire(); // b
    expect(b.acquire().target.url.hostname).toBe("a");
  });
});

describe("least-connections", () => {
  it("picks the target with the fewest active requests", () => {
    const b = new Balancer(urls("a", "b", "c"), "least-connections");
    const first = b.acquire(); // all idle -> a
    b.acquire(); // b (a is busy)
    b.acquire(); // c
    expect(first.target.url.hostname).toBe("a");
    // everyone has 1; free up b only
    b.targets[1]!.active = 0;
    expect(b.acquire().target.url.hostname).toBe("b");
  });

  it("rotates among ties instead of always choosing the first target", () => {
    const b = new Balancer(urls("a", "b", "c"), "least-connections");
    const picked: string[] = [];
    for (let i = 0; i < 6; i++) {
      const lease = b.acquire();
      picked.push(lease.target.url.hostname);
      lease.release(); // idle again, so every pick is a tie
    }
    expect(picked).toEqual(["a", "b", "c", "a", "b", "c"]);
  });

  it("keeps sending to the target that finishes fast and avoids the one that is stuck", () => {
    const b = new Balancer(urls("slow", "fast"), "least-connections");
    b.acquire(); // goes to "slow" (first tie), never released
    const picked: string[] = [];
    for (let i = 0; i < 5; i++) {
      const lease = b.acquire();
      picked.push(lease.target.url.hostname);
      lease.release();
    }
    expect(picked).toEqual(["fast", "fast", "fast", "fast", "fast"]);
  });
});

describe("leases", () => {
  it("count up on acquire and down on release", () => {
    const b = new Balancer(urls("a"), "round-robin");
    const l1 = b.acquire();
    const l2 = b.acquire();
    expect(b.targets[0]!.active).toBe(2);
    l1.release();
    l2.release();
    expect(b.targets[0]!.active).toBe(0);
  });

  it("release is idempotent: a double release does not undercount", () => {
    const b = new Balancer(urls("a"), "round-robin");
    const lease = b.acquire();
    b.acquire();
    lease.release();
    lease.release();
    expect(b.targets[0]!.active).toBe(1);
  });

  it("names are what the tests think they are", () => {
    const b = new Balancer(urls("a", "b"));
    expect(names([b.acquire(), b.acquire()])).toEqual(["a", "b"]);
  });
});
