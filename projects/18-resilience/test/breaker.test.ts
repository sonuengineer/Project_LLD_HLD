import { describe, expect, it } from "vitest";
import { CircuitBreaker, type CircuitBreakerOptions, type StateChange } from "../src/breaker.js";
import { BrokenCircuitError } from "../src/errors.js";

const ok = async () => "ok";
const boom = async () => {
  throw new Error("down");
};

function make(options: CircuitBreakerOptions = {}) {
  let t = 1_000_000;
  const changes: StateChange[] = [];
  const breaker = new CircuitBreaker({
    windowSize: 10,
    minimumCalls: 4,
    failureRateThreshold: 0.5,
    openMs: 1000,
    now: () => t,
    onStateChange: (c) => changes.push(c),
    ...options,
  });
  const run = (op: () => Promise<string>) => breaker.execute(op).catch((e: unknown) => e);
  return { breaker, changes, run, advance: (ms: number) => (t += ms) };
}

// An operation the test finishes by hand.
function deferred() {
  let resolve: (v: string) => void = () => {};
  let reject: (e: Error) => void = () => {};
  const op = () => new Promise<string>((res, rej) => ((resolve = res), (reject = rej)));
  return { op, resolve: (v = "late") => resolve(v), reject: (e = new Error("late fail")) => reject(e) };
}

describe("CircuitBreaker: closed", () => {
  it("passes results and errors through while closed", async () => {
    const { breaker, run } = make();
    expect(await breaker.execute(ok)).toBe("ok");
    expect(await run(boom)).toMatchObject({ message: "down" });
    expect(breaker.state).toBe("closed");
  });

  it("does not decide before minimumCalls: 3 failures out of 3 stay closed", async () => {
    const { breaker, run } = make();
    for (let i = 0; i < 3; i++) await run(boom);
    expect(breaker.state).toBe("closed");
    await run(boom);
    expect(breaker.state).toBe("open");
  });

  it("opens exactly at the threshold: 2 of 4 failed (50%)", async () => {
    const { breaker, run, changes } = make();
    await run(ok);
    await run(ok);
    await run(boom);
    expect(breaker.state).toBe("closed");
    await run(boom);
    expect(breaker.state).toBe("open");
    expect(changes).toEqual([{ from: "closed", to: "open" }]);
  });

  it("below the threshold stays closed: 4 of 10 failed", async () => {
    const { breaker, run } = make();
    for (const op of [ok, ok, boom, ok, boom, ok, boom, ok, ok, boom]) await run(op);
    expect(breaker.state).toBe("closed");
    expect(breaker.failureRate).toBe(0.4);
  });

  it("is a SLIDING window: old failures fall out", async () => {
    const { breaker, run } = make({ windowSize: 4, minimumCalls: 4, failureRateThreshold: 0.75 });
    for (const op of [boom, boom, ok, ok]) await run(op); // 2/4
    for (const op of [ok, ok]) await run(op); // the two failures fell out: 0/4
    expect(breaker.failureRate).toBe(0);
    for (const op of [boom, boom]) await run(op); // 2/4 again
    expect(breaker.state).toBe("closed");
    await run(boom); // 3/4 = 75%
    expect(breaker.state).toBe("open");
  });

  it("errors that are not failures count as successes (the dependency answered)", async () => {
    const notFound = async () => {
      throw Object.assign(new Error("404"), { status: 404 });
    };
    const { breaker, run } = make({ isFailure: (e) => (e as { status?: number }).status !== 404 });
    for (let i = 0; i < 10; i++) await run(notFound);
    expect(breaker.state).toBe("closed");
    expect(breaker.failureRate).toBe(0);
  });

  it("a call whose caller aborted is not recorded", async () => {
    const { breaker } = make();
    for (let i = 0; i < 10; i++) {
      const c = new AbortController();
      await breaker
        .execute(async () => {
          c.abort(new Error("client gone"));
          throw new Error("aborted fetch");
        }, c.signal)
        .catch(() => {});
    }
    expect(breaker.state).toBe("closed");
    expect(breaker.failureRate).toBe(0);
  });
});

describe("CircuitBreaker: open and half-open", () => {
  async function tripped(options: CircuitBreakerOptions = {}) {
    const m = make(options);
    for (let i = 0; i < 4; i++) await m.run(boom);
    expect(m.breaker.state).toBe("open");
    return m;
  }

  it("open: rejects at once WITHOUT calling the operation, with the time until the probe", async () => {
    const { breaker, advance } = await tripped();
    let called = 0;
    advance(400);
    const e = await breaker.execute(async () => (called++, "x")).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(BrokenCircuitError);
    expect(e).toMatchObject({ state: "open", retryAfterMs: 600 });
    expect(called).toBe(0);
  });

  it("after openMs it is half-open (checked lazily, no timer)", async () => {
    const { breaker, advance, changes } = await tripped();
    advance(999);
    expect(breaker.state).toBe("open");
    advance(1);
    expect(breaker.state).toBe("half-open");
    expect(changes.at(-1)).toEqual({ from: "open", to: "half-open" });
  });

  it("half-open: one probe goes through, a second concurrent call is rejected", async () => {
    const { breaker, advance } = await tripped();
    advance(1000);
    const probe = deferred();
    const p = breaker.execute(probe.op);
    const second = await breaker.execute(ok).catch((e: unknown) => e);
    expect(second).toMatchObject({ name: "BrokenCircuitError", state: "half-open", retryAfterMs: 0 });
    probe.resolve("fine");
    expect(await p).toBe("fine");
    expect(breaker.state).toBe("closed");
  });

  it("probe succeeds -> closed with an EMPTY window (old failures forgotten)", async () => {
    const { breaker, advance, run } = await tripped();
    advance(1000);
    await run(ok);
    expect(breaker.state).toBe("closed");
    expect(breaker.failureRate).toBe(0);
    for (let i = 0; i < 3; i++) await run(boom); // 3 failures: below minimumCalls again
    expect(breaker.state).toBe("closed");
  });

  it("probe fails -> open again with a NEW openMs", async () => {
    const { breaker, advance, run, changes } = await tripped();
    advance(1000);
    await run(boom);
    expect(breaker.state).toBe("open");
    advance(999);
    expect(breaker.state).toBe("open");
    advance(1);
    expect(breaker.state).toBe("half-open");
    expect(changes.map((c) => c.to)).toEqual(["open", "half-open", "open", "half-open"]);
  });

  it("halfOpenMaxCalls 3: needs 3 successful probes; the 4th concurrent call is rejected", async () => {
    const { breaker, advance } = await tripped({ halfOpenMaxCalls: 3 });
    advance(1000);
    const probes = [deferred(), deferred(), deferred()];
    const running = probes.map((d) => breaker.execute(d.op));
    expect(await breaker.execute(ok).catch((e: unknown) => e)).toBeInstanceOf(BrokenCircuitError);
    probes[0]!.resolve();
    await running[0];
    expect(breaker.state).toBe("half-open");
    // A finished probe's slot is NOT reused: 1 success + 2 in flight = 3.
    expect(await breaker.execute(ok).catch((e: unknown) => e)).toBeInstanceOf(BrokenCircuitError);
    probes[1]!.resolve();
    probes[2]!.resolve();
    await Promise.all(running);
    expect(breaker.state).toBe("closed");
  });

  it("a probe whose caller aborted frees its slot without deciding anything", async () => {
    const { breaker, advance } = await tripped();
    advance(1000);
    const c = new AbortController();
    await breaker
      .execute(async () => {
        c.abort(new Error("gone"));
        throw new Error("aborted");
      }, c.signal)
      .catch(() => {});
    expect(breaker.state).toBe("half-open");
    expect(await breaker.execute(ok)).toBe("ok"); // the slot was free again
    expect(breaker.state).toBe("closed");
  });

  it("an error that is not a failure, in half-open, counts as a successful probe", async () => {
    const { breaker, advance } = await tripped({ isFailure: (e) => (e as Error).message !== "404" });
    advance(1000);
    await breaker.execute(async () => Promise.reject(new Error("404"))).catch(() => {});
    expect(breaker.state).toBe("closed");
  });
});

describe("CircuitBreaker: stale results (generations)", () => {
  it("a slow call that started while closed and fails after the breaker opened does not reset the open timer", async () => {
    const { breaker, run, advance } = make();
    const slow = deferred();
    const p = breaker.execute(slow.op).catch((e: unknown) => e);
    for (let i = 0; i < 4; i++) await run(boom); // opens at t0
    advance(900);
    slow.reject();
    await p;
    advance(100); // t0 + 1000: half-open as planned, not pushed back
    expect(breaker.state).toBe("half-open");
  });

  it("a slow call from the closed state that succeeds during half-open is not counted as the probe", async () => {
    const { breaker, run, advance } = make();
    const slow = deferred();
    const p = breaker.execute(slow.op);
    for (let i = 0; i < 4; i++) await run(boom);
    advance(1000);
    expect(breaker.state).toBe("half-open");
    slow.resolve();
    await p;
    expect(breaker.state).toBe("half-open"); // still waiting for a real probe
    await run(boom);
    expect(breaker.state).toBe("open");
  });

  it("a slow call from the closed state that FAILS during half-open does not reopen it", async () => {
    const { breaker, run, advance } = make();
    const slow = deferred();
    const p = breaker.execute(slow.op).catch(() => {});
    for (let i = 0; i < 4; i++) await run(boom);
    advance(1000);
    const probe = deferred();
    const probeRun = breaker.execute(probe.op);
    slow.reject();
    await p;
    expect(breaker.state).toBe("half-open");
    probe.resolve();
    await probeRun;
    expect(breaker.state).toBe("closed");
  });
});

describe("CircuitBreaker: odds and ends", () => {
  it("a throwing onStateChange does not turn a finished call into an error", async () => {
    const breaker = new CircuitBreaker({
      windowSize: 1,
      minimumCalls: 1,
      onStateChange: () => {
        throw new Error("logger down");
      },
    });
    const e = await breaker.execute(boom).catch((x: unknown) => x);
    expect(e).toMatchObject({ message: "down" }); // the operation's own error, not the logger's
    expect(breaker.state).toBe("open");
  });

  it("an isFailure that throws counts as a failure; in half-open it does not leave the breaker stuck", async () => {
    let t = 0;
    const breaker = new CircuitBreaker({
      windowSize: 1,
      minimumCalls: 1,
      openMs: 100,
      now: () => t,
      isFailure: () => {
        throw new Error("classifier bug");
      },
    });
    const e = await breaker.execute(boom).catch((x: unknown) => x);
    expect(e).toMatchObject({ message: "down" }); // the operation's error, not the classifier's
    expect(breaker.state).toBe("open");
    t += 100;
    await breaker.execute(boom).catch(() => {}); // the probe; its classification throws
    expect(breaker.state).toBe("open"); // decided (as a failure), not stuck in half-open
    t += 100;
    expect(await breaker.execute(ok)).toBe("ok");
    expect(breaker.state).toBe("closed");
  });

  it("a synchronously throwing operation is recorded like any failure", async () => {
    const breaker = new CircuitBreaker({ windowSize: 1, minimumCalls: 1 });
    await breaker
      .execute(() => {
        throw new Error("sync");
      })
      .catch(() => {});
    expect(breaker.state).toBe("open");
  });

  it("an already-aborted caller: not called, not recorded", async () => {
    const breaker = new CircuitBreaker({ windowSize: 1, minimumCalls: 1 });
    await expect(breaker.execute(ok, AbortSignal.abort(new Error("no")))).rejects.toThrow("no");
    expect(breaker.state).toBe("closed");
  });

  it.each([
    [{ failureRateThreshold: 0 }],
    [{ failureRateThreshold: 1.5 }],
    [{ windowSize: 0 }],
    [{ windowSize: 5, minimumCalls: 6 }],
    [{ openMs: 0 }],
    [{ halfOpenMaxCalls: 0 }],
  ])("rejects %j", (opts) => {
    expect(() => new CircuitBreaker(opts)).toThrow(RangeError);
  });

  it("defaults: window 20, minimum 10, 50%, 30 s", async () => {
    let t = 0;
    const breaker = new CircuitBreaker({ now: () => t });
    for (let i = 0; i < 9; i++) await breaker.execute(boom).catch(() => {});
    expect(breaker.state).toBe("closed");
    await breaker.execute(boom).catch(() => {});
    expect(breaker.state).toBe("open");
    t += 29_999;
    expect(breaker.state).toBe("open");
    t += 1;
    expect(breaker.state).toBe("half-open");
  });
});
