import { afterEach, describe, expect, it, vi } from "vitest";
import { RetryBudget } from "../src/budget.js";
import { RetryPolicy, type GiveUpEvent, type RetryEvent, type RetryOptions } from "../src/retry.js";

afterEach(() => {
  vi.useRealTimers();
});

// An operation that fails `failures` times with numbered errors, then returns "ok".
function flaky(failures: number) {
  const errors: Error[] = [];
  let calls = 0;
  const op = async () => {
    calls++;
    if (calls <= failures) {
      const e = new Error(`fail ${calls}`);
      errors.push(e);
      throw e;
    }
    return "ok";
  };
  return { op, errors, calls: () => calls };
}

// Records the waits instead of waiting, and every event.
function recorder(extra: RetryOptions = {}) {
  const sleeps: number[] = [];
  const retries: RetryEvent[] = [];
  const giveUps: GiveUpEvent[] = [];
  const policy = new RetryPolicy({
    backoff: { initialMs: 100, multiplier: 2, maxMs: 10_000, jitter: "none" },
    sleep: async (ms) => void sleeps.push(ms),
    onRetry: (e) => retries.push(e),
    onGiveUp: (e) => giveUps.push(e),
    ...extra,
  });
  return { policy, sleeps, retries, giveUps };
}

describe("RetryPolicy", () => {
  it("returns at once on success, no waits", async () => {
    const { policy, sleeps } = recorder();
    expect(await policy.execute(async () => "first")).toBe("first");
    expect(sleeps).toEqual([]);
  });

  it("fail, fail, succeed: 3 calls, waits 100 and 200, an event per retry", async () => {
    const { policy, sleeps, retries } = recorder();
    const f = flaky(2);
    expect(await policy.execute(f.op)).toBe("ok");
    expect(f.calls()).toBe(3);
    expect(sleeps).toEqual([100, 200]);
    expect(retries).toEqual([
      { attempt: 1, delayMs: 100, error: f.errors[0] },
      { attempt: 2, delayMs: 200, error: f.errors[1] },
    ]);
  });

  it("out of attempts: rethrows the LAST error unchanged (same object, not a wrapper)", async () => {
    const { policy, giveUps } = recorder({ maxAttempts: 3 });
    const f = flaky(10);
    const e = await policy.execute(f.op).catch((x: unknown) => x);
    expect(e).toBe(f.errors[2]);
    expect(f.calls()).toBe(3);
    expect(giveUps).toEqual([{ attempts: 3, reason: "attempts", error: f.errors[2] }]);
  });

  it("maxAttempts 1 means no retry at all", async () => {
    const { policy, sleeps } = recorder({ maxAttempts: 1 });
    const f = flaky(1);
    await expect(policy.execute(f.op)).rejects.toThrow("fail 1");
    expect([f.calls(), sleeps]).toEqual([1, []]);
  });

  it("a non-retryable error is rethrown after one call and does not touch the budget", async () => {
    const budget = new RetryBudget();
    const { policy, giveUps } = recorder({ budget, shouldRetry: (e) => (e as Error).message !== "fail 1" });
    const f = flaky(5);
    await expect(policy.execute(f.op)).rejects.toThrow("fail 1");
    expect(f.calls()).toBe(1);
    expect(giveUps[0]!.reason).toBe("not-retryable");
    expect(budget.available).toBe(10);
  });

  it("shouldRetry sees the attempt number", async () => {
    const seen: number[] = [];
    const { policy } = recorder({ maxAttempts: 5, shouldRetry: (_e, attempt) => (seen.push(attempt), attempt < 2) });
    await expect(policy.execute(flaky(10).op)).rejects.toThrow("fail 2");
    expect(seen).toEqual([1, 2]);
  });

  it("Retry-After longer than the backoff is honoured; shorter is ignored", async () => {
    const asked = [5000, 10];
    const { policy, sleeps } = recorder({ retryAfterMs: () => asked.shift() });
    await policy.execute(flaky(2).op);
    expect(sleeps).toEqual([5000, 200]);
  });

  it("Retry-After longer than maxRetryAfterMs: gives up instead of waiting", async () => {
    const { policy, sleeps, giveUps } = recorder({ retryAfterMs: () => 3_600_000, maxRetryAfterMs: 60_000 });
    await expect(policy.execute(flaky(1).op)).rejects.toThrow("fail 1");
    expect(sleeps).toEqual([]);
    expect(giveUps[0]!.reason).toBe("retry-after-too-long");
  });

  it("an absurdly long Retry-After (Infinity, e.g. 400 digits) gives up too; NaN is ignored", async () => {
    const inf = recorder({ retryAfterMs: () => Infinity });
    await expect(inf.policy.execute(flaky(1).op)).rejects.toThrow("fail 1");
    expect(inf.giveUps[0]!.reason).toBe("retry-after-too-long");
    const nan = recorder({ retryAfterMs: () => Number.NaN });
    expect(await nan.policy.execute(flaky(1).op)).toBe("ok");
    expect(nan.sleeps).toEqual([100]);
  });

  it("a throwing onRetry / onGiveUp neither ends the retries nor replaces the caller's error", async () => {
    const boom = () => {
      throw new Error("logger down");
    };
    const ok = new RetryPolicy({ sleep: async () => {}, onRetry: boom });
    expect(await ok.execute(flaky(2).op)).toBe("ok");
    const f = flaky(10);
    const gaveUp = new RetryPolicy({ sleep: async () => {}, onGiveUp: boom });
    expect(await gaveUp.execute(f.op).catch((e: unknown) => e)).toBe(f.errors[2]);
  });

  it("deadline: no retry that would start after it", async () => {
    let t = 0;
    const { policy, sleeps, giveUps } = recorder({
      maxAttempts: 10,
      deadlineMs: 1000,
      now: () => t,
      sleep: async (ms) => {
        sleeps.push(ms);
        t += ms;
      },
    });
    await expect(policy.execute(flaky(10).op)).rejects.toThrow("fail 4");
    // waits 100, 200, 400 (t = 700); the next would be 800 -> 1500 >= 1000.
    expect(sleeps).toEqual([100, 200, 400]);
    expect(giveUps[0]!.reason).toBe("deadline");
  });

  it("budget: gives up with reason 'budget' when the shared bucket is at half", async () => {
    const budget = new RetryBudget({ maxTokens: 4 }); // retries only while tokens > 2
    const { policy, giveUps } = recorder({ budget, maxAttempts: 10 });
    const f = flaky(10);
    await expect(policy.execute(f.op)).rejects.toThrow("fail 2");
    expect(f.calls()).toBe(2); // 4 -> 3 (retry), 3 -> 2 (stop)
    expect(giveUps[0]!.reason).toBe("budget");
  });

  it("a success refills the budget", async () => {
    const budget = new RetryBudget({ maxTokens: 10, tokenRatio: 0.5 });
    const { policy } = recorder({ budget });
    await policy.execute(flaky(2).op);
    expect(budget.available).toBe(8.5);
  });

  it("the caller aborts during the operation: no retry, rejects with the caller's reason", async () => {
    const caller = new AbortController();
    const { policy, sleeps } = recorder({ maxAttempts: 5 });
    let calls = 0;
    const op = async (signal: AbortSignal) => {
      calls++;
      caller.abort(new Error("client gone"));
      throw new Error(signal.aborted ? "aborted fetch" : "other");
    };
    await expect(policy.execute(op, caller.signal)).rejects.toThrow("client gone");
    expect([calls, sleeps]).toEqual([1, []]);
  });

  it("the caller aborts during the wait: rejects at once, no further call (real sleep, fake timers)", async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const policy = new RetryPolicy({ maxAttempts: 5, backoff: { initialMs: 10_000, jitter: "none" } });
    const f = flaky(10);
    const p = policy.execute(f.op, caller.signal).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(5000);
    caller.abort(new Error("cancelled"));
    expect(await p).toMatchObject({ message: "cancelled" });
    expect(f.calls()).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("an already-aborted caller: the operation is never called", async () => {
    const f = flaky(0);
    await expect(new RetryPolicy().execute(f.op, AbortSignal.abort(new Error("no")))).rejects.toThrow("no");
    expect(f.calls()).toBe(0);
  });

  it("uses the default full jitter with the injected random", async () => {
    const sleeps: number[] = [];
    const policy = new RetryPolicy({ random: () => 0.5, sleep: async (ms) => void sleeps.push(ms) });
    await policy.execute(flaky(2).op);
    expect(sleeps).toEqual([50, 100]);
  });

  it("accepts a custom Backoff object", async () => {
    const sleeps: number[] = [];
    const policy = new RetryPolicy({ backoff: { delayMs: (n) => n * 7 }, sleep: async (ms) => void sleeps.push(ms) });
    await policy.execute(flaky(2).op);
    expect(sleeps).toEqual([7, 14]);
  });

  it("the real sleep really waits the backoff (fake timers)", async () => {
    vi.useFakeTimers();
    const f = flaky(1);
    const p = new RetryPolicy({ backoff: { initialMs: 300, jitter: "none" } }).execute(f.op);
    await vi.advanceTimersByTimeAsync(299);
    expect(f.calls()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await p).toBe("ok");
    expect(f.calls()).toBe(2);
  });

  it.each([[{ maxAttempts: 0 }], [{ maxAttempts: 1.5 }], [{ deadlineMs: 0 }]])("rejects %j", (opts) => {
    expect(() => new RetryPolicy(opts)).toThrow(RangeError);
  });
});
