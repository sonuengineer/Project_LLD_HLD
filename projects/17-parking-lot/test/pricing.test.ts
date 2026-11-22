import { describe, expect, it } from "vitest";
import { HOUR_MS, HourlyPricing, MINUTE_MS } from "../src/pricing.js";

const rates = { motorcycle: 2000, car: 5000, truck: 10000 };
const T0 = Date.UTC(2026, 10, 22, 9, 0);

describe("HourlyPricing", () => {
  const p = new HourlyPricing(rates);

  it("charges each started hour", () => {
    expect(p.fee("car", T0, T0 + 1)).toBe(5000);
    expect(p.fee("car", T0, T0 + HOUR_MS)).toBe(5000);
    expect(p.fee("car", T0, T0 + HOUR_MS + 1)).toBe(10000);
    expect(p.fee("car", T0, T0 + 3 * HOUR_MS)).toBe(15000);
  });

  it("uses the rate of the vehicle type", () => {
    expect(p.fee("motorcycle", T0, T0 + HOUR_MS)).toBe(2000);
    expect(p.fee("truck", T0, T0 + HOUR_MS)).toBe(10000);
  });

  it("is free for a zero-length stay", () => {
    expect(p.fee("car", T0, T0)).toBe(0);
  });

  it("rejects an exit before the entry", () => {
    expect(() => p.fee("car", T0, T0 - 1)).toThrow(expect.objectContaining({ code: "INVALID_TIME" }));
  });

  it("rejects NaN times", () => {
    expect(() => p.fee("car", T0, Number.NaN)).toThrow(expect.objectContaining({ code: "INVALID_TIME" }));
  });
});

describe("HourlyPricing grace period", () => {
  const p = new HourlyPricing(rates, { graceMinutes: 10 });

  it("is free up to and including the grace period", () => {
    expect(p.fee("car", T0, T0 + 10 * MINUTE_MS)).toBe(0);
  });

  it("charges the whole stay, from entry, once over the grace period", () => {
    expect(p.fee("car", T0, T0 + 10 * MINUTE_MS + 1)).toBe(5000);
    // 70 minutes is 2 started hours; it is NOT 60 billable minutes (= 1 hour) after subtracting the grace.
    expect(p.fee("car", T0, T0 + 70 * MINUTE_MS)).toBe(10000);
  });
});

describe("HourlyPricing validation", () => {
  it.each([
    ["negative", -1],
    ["fractional", 49.5],
    ["NaN", Number.NaN],
  ])("rejects a %s rate", (_label, bad) => {
    expect(() => new HourlyPricing({ ...rates, car: bad })).toThrow(expect.objectContaining({ code: "INVALID_RATE" }));
  });

  it("rejects a missing rate", () => {
    const missing = { motorcycle: 1, car: 1 } as unknown as typeof rates;
    expect(() => new HourlyPricing(missing)).toThrow(expect.objectContaining({ code: "INVALID_RATE" }));
  });

  it("rejects a negative grace period", () => {
    expect(() => new HourlyPricing(rates, { graceMinutes: -5 })).toThrow(expect.objectContaining({ code: "INVALID_RATE" }));
  });

  it("copies the rates, so changing the caller's object later changes nothing", () => {
    const mine = { ...rates };
    const p = new HourlyPricing(mine);
    mine.car = 1;
    expect(p.fee("car", T0, T0 + HOUR_MS)).toBe(5000);
  });

  it("accepts a zero rate (free parking for a type)", () => {
    expect(new HourlyPricing({ ...rates, motorcycle: 0 }).fee("motorcycle", T0, T0 + 5 * HOUR_MS)).toBe(0);
  });
});
