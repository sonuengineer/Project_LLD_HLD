import { afterEach, describe, expect, it, vi } from "vitest";
import { CircuitBreaker } from "../src/breaker.js";
import { Bulkhead } from "../src/bulkhead.js";
import { BrokenCircuitError, BulkheadRejectedError, TimeoutError } from "../src/errors.js";
import type { ResilienceEvent } from "../src/events.js";
import { isRetryableHttp } from "../src/http.js";
import { RetryPolicy } from "../src/retry.js";
import { TimeoutPolicy } from "../src/timeout.js";
import { wrap } from "../src/wrap.js";

afterEach(() => {
  vi.useRealTimers();
});

const noWait = { sleep: async () => {} };

describe("wrap", () => {
  it("runs outermost first: wrap(a, b, c) = a(b(c(op)))", async () => {
    const log: string[] = [];
    const tracer = (name: string) => ({
      execute: async <T>(op: (s: AbortSignal) => Promise<T>, s?: AbortSignal) => {
        log.push(`${name} in`);
        const r = await op(s ?? new AbortController().signal);
        log.push(`${name} out`);
        return r;
      },
    });
    const r = await wrap(tracer("a"), tracer("b"), tracer("c")).execute(async () => (log.push("op"), 7));
    expect(r).toBe(7);
    expect(log).toEqual(["a in", "b in", "c in", "op", "c out", "b out", "a out"]);
  });

  it("passes the caller's signal down to the operation", async () => {
    const caller = new AbortController();
    let seen: AbortSignal | undefined;
    await wrap(new RetryPolicy(noWait)).execute(async (s) => void (seen = s), caller.signal);
    expect(seen).toBe(caller.signal);
  });

  it("the caller's abort reaches through every layer", async () => {
    const caller = new AbortController();
    const policy = wrap(new RetryPolicy(noWait), new CircuitBreaker(), new Bulkhead({ maxConcurrent: 1 }), new TimeoutPolicy({ ms: 10_000 }));
    let opSignal: AbortSignal | undefined;
    const p = policy.execute((s) => {
      opSignal = s;
      return new Promise<never>(() => {});
    }, caller.signal);
    await new Promise((r) => setImmediate(r));
    caller.abort(new Error("client gone"));
    await expect(p).rejects.toThrow("client gone");
    expect(opSignal!.aborted).toBe(true);
  });

  it("each layer's own signal reaches the operation: a timeout deep inside aborts the operation's signal", async () => {
    vi.useFakeTimers();
    let opSignal: AbortSignal | undefined;
    const p = wrap(new RetryPolicy({ maxAttempts: 1 }), new CircuitBreaker(), new TimeoutPolicy({ ms: 100 }))
      .execute((s) => {
        opSignal = s;
        return new Promise<never>(() => {});
      })
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(100);
    expect(await p).toBeInstanceOf(TimeoutError);
    expect(opSignal!.aborted).toBe(true);
    expect(opSignal!.reason).toBeInstanceOf(TimeoutError);
  });

  it("50 concurrent calls without a caller signal: no MaxListenersExceededWarning (no listeners on the shared signal)", async () => {
    const warnings: Error[] = [];
    const onWarning = (w: Error) => warnings.push(w);
    process.on("warning", onWarning);
    try {
      const bulkhead = new Bulkhead({ maxConcurrent: 5, maxQueue: 100 });
      const policy = wrap(new RetryPolicy({ maxAttempts: 1 }), bulkhead, new TimeoutPolicy({ ms: 50 }));
      const results = await Promise.all(
        Array.from({ length: 50 }, () => policy.execute(() => new Promise(() => {})).catch((e: unknown) => e)),
      );
      expect(results.every((e) => e instanceof TimeoutError)).toBe(true);
      await new Promise((r) => setTimeout(r, 20)); // warnings are emitted asynchronously
      expect(warnings.filter((w) => w.name === "MaxListenersExceededWarning")).toEqual([]);
    } finally {
      process.off("warning", onWarning);
    }
  });

  it("needs at least one policy", () => {
    expect(() => wrap()).toThrow(RangeError);
  });
});

describe("why the recommended order is retry -> breaker -> bulkhead -> timeout", () => {
  it("timeout INSIDE retry: every attempt gets its own deadline (hang, hang, ok -> ok)", async () => {
    vi.useFakeTimers();
    let n = 0;
    const op = () => (++n < 3 ? new Promise<string>(() => {}) : Promise.resolve("ok"));
    const p = wrap(new RetryPolicy({ backoff: { initialMs: 1, jitter: "none" } }), new TimeoutPolicy({ ms: 100 })).execute(op);
    await vi.advanceTimersByTimeAsync(300);
    expect(await p).toBe("ok");
  });

  it("timeout OUTSIDE retry: one deadline for all attempts and waits (the third attempt never happens)", async () => {
    vi.useFakeTimers();
    let n = 0;
    const op = () => (++n < 3 ? Promise.reject(new Error("fail")) : Promise.resolve("ok"));
    const p = wrap(new TimeoutPolicy({ ms: 150 }), new RetryPolicy({ backoff: { initialMs: 100, jitter: "none" } }))
      .execute(op)
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await p).toBeInstanceOf(TimeoutError);
    expect(n).toBe(2); // fail, wait 100, fail, wait 200 -> the 150 ms timeout fires during the second wait
  });

  it("breaker INSIDE retry sees every attempt: 4 calls x 3 attempts open it; outside it sees one outcome per call", async () => {
    const fail = async () => Promise.reject(new Error("down"));
    const inner = new CircuitBreaker({ windowSize: 10, minimumCalls: 10 });
    for (let i = 0; i < 4; i++) await wrap(new RetryPolicy(noWait), inner).execute(fail).catch(() => {});
    expect(inner.state).toBe("open"); // 10 attempts reached the window after 4 calls

    const outer = new CircuitBreaker({ windowSize: 10, minimumCalls: 10 });
    for (let i = 0; i < 4; i++) await wrap(outer, new RetryPolicy(noWait)).execute(fail).catch(() => {});
    expect(outer.state).toBe("closed"); // only 4 outcomes recorded
  });

  it("a half-open probe that hangs blocks the breaker forever; a timeout INSIDE the breaker turns it into a failure", async () => {
    vi.useFakeTimers();
    const hangs = () => new Promise<string>(() => {});
    const trip = async (b: CircuitBreaker) => b.execute(async () => Promise.reject(new Error("down"))).catch(() => {});

    const bare = new CircuitBreaker({ windowSize: 1, minimumCalls: 1, openMs: 1000 });
    await trip(bare);
    await vi.advanceTimersByTimeAsync(1000);
    void bare.execute(hangs); // the probe never answers
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await bare.execute(async () => "x").catch((e: unknown) => e)).toBeInstanceOf(BrokenCircuitError);
    expect(bare.state).toBe("half-open"); // stuck: the probe slot is never freed

    const guarded = new CircuitBreaker({ windowSize: 1, minimumCalls: 1, openMs: 1000 });
    const policy = wrap(guarded, new TimeoutPolicy({ ms: 200 }));
    await trip(guarded);
    await vi.advanceTimersByTimeAsync(1000);
    const probe = policy.execute(hangs).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(200);
    expect(await probe).toBeInstanceOf(TimeoutError);
    expect(guarded.state).toBe("open"); // the timed-out probe counted as a failure: open again, will retry later
  });

  it("an open breaker inside retry (with isRetryableHttp) stops the retry at once", async () => {
    const breaker = new CircuitBreaker({ windowSize: 1, minimumCalls: 1 });
    await breaker.execute(async () => Promise.reject(new Error("down"))).catch(() => {});
    let attempts = 0;
    const retry = new RetryPolicy({ ...noWait, shouldRetry: isRetryableHttp, onRetry: () => attempts++ });
    const e = await wrap(retry, breaker).execute(async () => "never").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(BrokenCircuitError);
    expect(attempts).toBe(0);
  });

  it("bulkhead OUTSIDE retry holds its slot during the backoff sleep; inside it does not", async () => {
    vi.useFakeTimers();
    const slowRetry = () => new RetryPolicy({ maxAttempts: 2, backoff: { initialMs: 1000, jitter: "none" } });
    const failOnce = () => {
      let n = 0;
      return async () => (n++ === 0 ? Promise.reject(new Error("blip")) : "ok");
    };

    const outside = new Bulkhead({ maxConcurrent: 1 });
    const a = wrap(outside, slowRetry()).execute(failOnce());
    await vi.advanceTimersByTimeAsync(10); // a failed once and is sleeping 1000 ms -- holding the slot
    expect(await wrap(outside, slowRetry()).execute(failOnce()).catch((e: unknown) => e)).toBeInstanceOf(BulkheadRejectedError);
    await vi.advanceTimersByTimeAsync(1000);
    await a;

    const inside = new Bulkhead({ maxConcurrent: 1 });
    const b = wrap(slowRetry(), inside).execute(failOnce());
    await vi.advanceTimersByTimeAsync(10); // b sleeps OUTSIDE the bulkhead: the slot is free
    expect(await wrap(slowRetry(), inside).execute(async () => "other")).toBe("other");
    await vi.advanceTimersByTimeAsync(1000);
    expect(await b).toBe("ok");
  });
});

describe("events: one handler for every policy", () => {
  it("timeout, retry, give-up, breaker-state, breaker-rejected, bulkhead-rejected -- with names", async () => {
    vi.useFakeTimers();
    const events: ResilienceEvent[] = [];
    const onEvent = (e: ResilienceEvent) => events.push(e);
    const breaker = new CircuitBreaker({ name: "sms-breaker", windowSize: 2, minimumCalls: 2, onEvent });
    const policy = wrap(
      new RetryPolicy({ name: "sms-retry", maxAttempts: 2, backoff: { initialMs: 5, jitter: "none" }, shouldRetry: isRetryableHttp, onEvent }),
      breaker,
      new TimeoutPolicy({ name: "sms-timeout", ms: 50, onEvent }),
    );
    const p = policy.execute(() => new Promise(() => {})).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(200);
    expect(await p).toBeInstanceOf(TimeoutError);
    expect(await policy.execute(async () => "x").catch((e: unknown) => e)).toBeInstanceOf(BrokenCircuitError);
    const bulkhead = new Bulkhead({ name: "sms-pool", maxConcurrent: 1, onEvent });
    const hold = bulkhead.execute(() => new Promise<void>(() => {}));
    await bulkhead.execute(async () => "x").catch(() => {});
    void hold;

    expect(events.map((e) => `${e.type}:${e.policy}`)).toEqual([
      "timeout:sms-timeout",
      "retry:sms-retry",
      "timeout:sms-timeout",
      "breaker-state:sms-breaker",
      "give-up:sms-retry",
      "breaker-rejected:sms-breaker",
      "give-up:sms-retry",
      "bulkhead-rejected:sms-pool",
    ]);
    expect(events[3]).toMatchObject({ from: "closed", to: "open" });
    expect(events[4]).toMatchObject({ attempts: 2, reason: "attempts" });
    expect(events[6]).toMatchObject({ attempts: 1, reason: "not-retryable" });
    expect(events[7]).toMatchObject({ running: 1, queued: 0 });
  });

  it("default policy names are their kinds", async () => {
    const events: ResilienceEvent[] = [];
    const onEvent = (e: ResilienceEvent) => events.push(e);
    await new RetryPolicy({ ...noWait, maxAttempts: 1, onEvent }).execute(async () => Promise.reject(new Error("x"))).catch(() => {});
    const b = new CircuitBreaker({ windowSize: 1, minimumCalls: 1, onEvent });
    await b.execute(async () => Promise.reject(new Error("x"))).catch(() => {});
    await b.execute(async () => 1).catch(() => {});
    const k = new Bulkhead({ maxConcurrent: 1, onEvent });
    void k.execute(() => new Promise(() => {}));
    await k.execute(async () => 1).catch(() => {});
    expect(new Set(events.map((e) => e.policy))).toEqual(new Set(["retry", "breaker", "bulkhead"]));
  });

  it("a throwing event handler changes nothing for the caller", async () => {
    const onEvent = () => {
      throw new Error("metrics down");
    };
    const n = { v: 0 };
    const r = await new RetryPolicy({ ...noWait, onEvent }).execute(async () => (n.v++ < 1 ? Promise.reject(new Error("blip")) : "ok"));
    expect(r).toBe("ok");
    const b = new CircuitBreaker({ windowSize: 1, minimumCalls: 1, onEvent });
    expect(await b.execute(async () => Promise.reject(new Error("down"))).catch((e: unknown) => e)).toMatchObject({ message: "down" });
    expect(await b.execute(async () => 1).catch((e: unknown) => e)).toBeInstanceOf(BrokenCircuitError);
    const k = new Bulkhead({ maxConcurrent: 1, onEvent });
    void k.execute(() => new Promise(() => {}));
    expect(await k.execute(async () => 1).catch((e: unknown) => e)).toBeInstanceOf(BulkheadRejectedError);
  });
});
