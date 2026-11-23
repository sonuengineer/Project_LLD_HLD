import { describe, expect, it } from "vitest";
import { exponentialBackoff } from "../src/backoff.js";

const low = () => 0;
const high = () => 0.999999;

describe("exponentialBackoff", () => {
  it("none: initial x multiplier^(n-1), capped at maxMs", () => {
    const b = exponentialBackoff({ initialMs: 100, multiplier: 2, maxMs: 1000, jitter: "none" });
    expect([1, 2, 3, 4, 5, 6].map((n) => b.delayMs(n, low))).toEqual([100, 200, 400, 800, 1000, 1000]);
  });

  it("full: between 0 and the exponential value", () => {
    const b = exponentialBackoff({ initialMs: 100, maxMs: 10_000, jitter: "full" });
    expect(b.delayMs(3, low)).toBe(0);
    expect(b.delayMs(3, high)).toBe(399);
    expect(b.delayMs(3, () => 0.5)).toBe(200);
  });

  it("equal: between half and the whole exponential value", () => {
    const b = exponentialBackoff({ initialMs: 100, maxMs: 10_000, jitter: "equal" });
    expect(b.delayMs(3, low)).toBe(200);
    expect(b.delayMs(3, high)).toBe(399);
  });

  it("is the default: full jitter, 100 ms, x2, 10 s cap", () => {
    const b = exponentialBackoff();
    expect(b.delayMs(1, high)).toBe(99);
    expect(b.delayMs(50, high)).toBe(9999); // capped, and no overflow
  });

  it("stays within its range for 10 000 random draws and every retry number up to 40", () => {
    const b = exponentialBackoff({ initialMs: 50, maxMs: 5000, jitter: "full" });
    for (let n = 1; n <= 40; n++) {
      const ceiling = Math.min(5000, 50 * 2 ** (n - 1));
      for (let i = 0; i < 250; i++) {
        const d = b.delayMs(n, Math.random);
        expect(d).toBeGreaterThanOrEqual(0);
        expect(d).toBeLessThan(ceiling);
        expect(Number.isInteger(d)).toBe(true);
      }
    }
  });

  it.each([
    [{ initialMs: -1 }],
    [{ initialMs: 200, maxMs: 100 }],
    [{ multiplier: 0.5 }],
    [{ jitter: "random" as never }],
  ])("rejects bad options %j", (opts) => {
    expect(() => exponentialBackoff(opts)).toThrow(RangeError);
  });
});
