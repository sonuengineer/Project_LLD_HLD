import { describe, expect, it } from "vitest";
import { CircuitBreaker } from "../src/circuit-breaker.js";
import { ManualClock } from "../src/clock.js";

function fail(): Promise<never> {
  return Promise.reject(new Error("boom"));
}

describe("CircuitBreaker", () => {
  it("starts closed, and a successful call just succeeds", async () => {
    const breaker = new CircuitBreaker();
    expect(breaker.getState()).toBe("closed");
    expect(await breaker.run(() => Promise.resolve(42))).toBe(42);
    expect(breaker.getState()).toBe("closed");
  });

  it("opens after the failure threshold, and a call made while open never even invokes fn()", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3 });
    for (let i = 0; i < 3; i++) {
      await expect(breaker.run(fail)).rejects.toThrow("boom");
    }
    expect(breaker.getState()).toBe("open");

    let called = false;
    await expect(breaker.run(async () => { called = true; return 1; })).rejects.toThrow("CIRCUIT_OPEN");
    expect(called).toBe(false);
  });

  it("fewer than the threshold's worth of failures never opens the circuit", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3 });
    await expect(breaker.run(fail)).rejects.toThrow("boom");
    await expect(breaker.run(fail)).rejects.toThrow("boom");
    expect(breaker.getState()).toBe("closed");
    expect(await breaker.run(() => Promise.resolve("ok"))).toBe("ok"); // a success before the 3rd failure
  });

  it("a success resets the failure counter -- an unrelated earlier near-threshold run does not carry over", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3 });
    await expect(breaker.run(fail)).rejects.toThrow("boom");
    await expect(breaker.run(fail)).rejects.toThrow("boom");
    expect(await breaker.run(() => Promise.resolve("ok"))).toBe("ok"); // resets the counter to 0
    await expect(breaker.run(fail)).rejects.toThrow("boom"); // only the 1st failure since the reset
    expect(breaker.getState()).toBe("closed"); // would be "open" (2+1=3) if the reset had not happened
  });

  it("after the cooldown, a single half-open trial is allowed; success closes the circuit", async () => {
    const clock = new ManualClock(0);
    const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 10_000, clock });
    await expect(breaker.run(fail)).rejects.toThrow("boom");
    expect(breaker.getState()).toBe("open");

    clock.advance(9_999);
    await expect(breaker.run(() => Promise.resolve("ok"))).rejects.toThrow("CIRCUIT_OPEN"); // cooldown not elapsed

    clock.advance(1);
    expect(await breaker.run(() => Promise.resolve("ok"))).toBe("ok"); // cooldown elapsed -> half-open trial
    expect(breaker.getState()).toBe("closed");
  });

  it("a failed half-open trial re-opens immediately, starting a fresh cooldown", async () => {
    const clock = new ManualClock(0);
    const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 10_000, clock });
    await expect(breaker.run(fail)).rejects.toThrow("boom");
    clock.advance(10_000);

    await expect(breaker.run(fail)).rejects.toThrow("boom"); // the half-open trial itself fails
    expect(breaker.getState()).toBe("open");

    clock.advance(9_999);
    await expect(breaker.run(fail)).rejects.toThrow("CIRCUIT_OPEN"); // still within the NEW cooldown
  });
});
