import { describe, expect, it, vi } from "vitest";
import { BreachChecker, DEFAULT_BREACH_CHECK_TIMEOUT_MS } from "../src/breach-checker.js";
import { FakeBreachProvider } from "../src/breach.js";
import { CircuitBreaker } from "../src/circuit-breaker.js";

describe("BreachChecker", () => {
  it(`defaults to ${DEFAULT_BREACH_CHECK_TIMEOUT_MS}ms when no timeoutMs is given`, async () => {
    vi.useFakeTimers();
    try {
      const neverRespondingProvider = {
        lookupPrefix: (_prefix: string, signal: AbortSignal) =>
          new Promise<string[]>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          }),
      };
      const checker = new BreachChecker({ provider: neverRespondingProvider }); // no timeoutMs override
      let settled = false;
      const result = checker.check("x").then((v) => {
        settled = true;
        return v;
      });

      await vi.advanceTimersByTimeAsync(DEFAULT_BREACH_CHECK_TIMEOUT_MS - 100);
      expect(settled).toBe(false); // proves the default is not ~0ms

      await vi.advanceTimersByTimeAsync(100);
      expect(await result).toBeNull();
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("true for a breached password, false for a clean one, using the real k-anonymity provider call", async () => {
    const checker = new BreachChecker({ provider: new FakeBreachProvider(["password123"]) });
    expect(await checker.check("password123")).toBe(true);
    expect(await checker.check("a-totally-different-and-strong-password")).toBe(false);
  });

  it("a provider that throws degrades to null -- it never rejects, so it can never block a save", async () => {
    const throwingProvider = { lookupPrefix: () => Promise.reject(new Error("provider down")) };
    const checker = new BreachChecker({ provider: throwingProvider });
    expect(await checker.check("anything")).toBeNull();
  });

  it("a provider that never responds times out and degrades to null instead of hanging forever", async () => {
    vi.useFakeTimers();
    try {
      // A realistic provider still has to cooperate with the AbortSignal (same contract fetch() uses) --
      // one that ignores it entirely could never be stopped by any caller, timeout or not.
      const neverRespondingProvider = {
        lookupPrefix: (_prefix: string, signal: AbortSignal) =>
          new Promise<string[]>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          }),
      };
      const checker = new BreachChecker({ provider: neverRespondingProvider, timeoutMs: 500 });
      const result = checker.check("anything");
      await vi.advanceTimersByTimeAsync(500);
      expect(await result).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("after enough consecutive provider failures, the circuit opens and check() fails fast (not waiting out the timeout)", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const throwingProvider = {
        lookupPrefix: () => {
          calls++;
          return Promise.reject(new Error("provider down"));
        },
      };
      const breaker = new CircuitBreaker({ failureThreshold: 2 });
      const checker = new BreachChecker({ provider: throwingProvider, breaker, timeoutMs: 10_000 });

      expect(await checker.check("a")).toBeNull();
      expect(await checker.check("b")).toBeNull();
      expect(checker.getCircuitState()).toBe("open");

      calls = 0;
      const result = checker.check("c");
      await vi.advanceTimersByTimeAsync(0); // no real timer should even be needed -- the circuit rejects immediately
      expect(await result).toBeNull();
      expect(calls).toBe(0); // the provider was never called a third time
    } finally {
      vi.useRealTimers();
    }
  });
});
