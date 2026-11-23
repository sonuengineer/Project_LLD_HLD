import { describe, expect, it } from "vitest";
import { RetryBudget } from "../src/budget.js";
import { RetryPolicy } from "../src/retry.js";

describe("RetryBudget", () => {
  it("starts full; a failure costs 1, a success refills tokenRatio, capped at max", () => {
    const b = new RetryBudget({ maxTokens: 10, tokenRatio: 0.1 });
    expect(b.available).toBe(10);
    b.onFailure();
    expect(b.available).toBe(9);
    b.onSuccess();
    expect(b.available).toBe(9.1);
    for (let i = 0; i < 100; i++) b.onSuccess();
    expect(b.available).toBe(10);
  });

  it("allows retries only above half: 10 -> 5 tokens stops retries", () => {
    const b = new RetryBudget({ maxTokens: 10 });
    for (let i = 0; i < 4; i++) b.onFailure();
    expect([b.available, b.canRetry()]).toEqual([6, true]);
    b.onFailure();
    expect([b.available, b.canRetry()]).toEqual([5, false]);
  });

  it("never goes below 0", () => {
    const b = new RetryBudget({ maxTokens: 2 });
    for (let i = 0; i < 10; i++) b.onFailure();
    expect(b.available).toBe(0);
  });

  it("no drift: 10 000 x (+0.1) from 0 is exactly back at the cap, and 1000 x 0.001 is exactly 1", () => {
    const b = new RetryBudget({ maxTokens: 10, tokenRatio: 0.1 });
    for (let i = 0; i < 10; i++) b.onFailure();
    for (let i = 0; i < 50; i++) b.onSuccess();
    expect(b.available).toBe(5); // 50 x 0.1 with floats would be 5.000000000000002
    const c = new RetryBudget({ maxTokens: 1, tokenRatio: 0.001 });
    c.onFailure();
    for (let i = 0; i < 1000; i++) c.onSuccess();
    expect(c.available).toBe(1);
  });

  it.each([
    [{ maxTokens: 0 }],
    [{ tokenRatio: 0 }],
    [{ tokenRatio: 0.0001 }],
  ])("rejects %j", (opts) => {
    expect(() => new RetryBudget(opts)).toThrow(RangeError);
  });
});

// `calls` calls through a 3-attempt retry policy; isUp(call) decides whether the dependency answers. No real waits.
async function simulate(budget: RetryBudget | undefined, calls: number, isUp: (call: number) => boolean) {
  let attempts = 0;
  let succeeded = 0;
  const policy = new RetryPolicy({ maxAttempts: 3, budget, sleep: async () => {} });
  for (let call = 0; call < calls; call++) {
    try {
      await policy.execute(async () => {
        attempts++;
        if (!isUp(call)) throw new Error("down");
      });
      succeeded++;
    } catch {
      // gave up
    }
  }
  return { attempts, succeeded };
}

describe("retry storm: 1000 calls to a dependency that is down (simulation, no timers)", () => {
  it("without a budget every call makes 3 attempts: 3000", async () => {
    expect(await simulate(undefined, 1000, () => false)).toEqual({ attempts: 3000, succeeded: 0 });
  });

  it("with a budget the extra load stops after a few retries: 1003 attempts", async () => {
    // Call 1: fail (9), retry, fail (8), retry, fail (7) -> 3 attempts. Call 2: fail (6), retry, fail (5): no more
    // retries (5 is not above half) -> 2 attempts. The other 998 calls: 1 attempt each. 3 + 2 + 998 = 1003.
    const r = await simulate(new RetryBudget(), 1000, () => false);
    expect(r).toEqual({ attempts: 1003, succeeded: 0 });
  });

  it("retries come back by themselves once the dependency recovers", async () => {
    const budget = new RetryBudget();
    await simulate(budget, 100, () => false); // drained to 0
    expect(budget.canRetry()).toBe(false);
    await simulate(budget, 51, () => true); // 51 successes x 0.1 = 5.1 tokens
    expect(budget.canRetry()).toBe(true);
    // But the failing attempt itself costs a token BEFORE the check: 5.1 - 1 = 4.1, so a blip is still not retried.
    const blipOnce = () => {
      let n = 0;
      return async () => {
        if (n++ === 0) throw new Error("blip");
        return "ok";
      };
    };
    const policy = new RetryPolicy({ budget, sleep: async () => {} });
    await expect(policy.execute(blipOnce())).rejects.toThrow("blip");
    // 4.1 tokens now; 21 more successes -> 6.2: a blip costs 1 (5.2 > 5) and is retried.
    await simulate(budget, 21, () => true);
    expect(budget.available).toBeCloseTo(6.2, 10);
    expect(await policy.execute(blipOnce())).toBe("ok");
  });
});
