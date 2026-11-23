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

describe("HourlyPricing daily cap", () => {
  const p = new HourlyPricing(rates, { dailyCapHours: 8 });
  const DAY = 24 * HOUR_MS;

  it("charges hourly up to the cap, then the cap for the rest of the day", () => {
    expect(p.fee("car", T0, T0 + 7 * HOUR_MS + 1)).toBe(8 * 5000);
    expect(p.fee("car", T0, T0 + 8 * HOUR_MS)).toBe(8 * 5000);
    expect(p.fee("car", T0, T0 + DAY)).toBe(8 * 5000);
  });

  it("starts counting again after each full day from entry", () => {
    expect(p.fee("car", T0, T0 + DAY + 1)).toBe(9 * 5000);
    expect(p.fee("car", T0, T0 + DAY + 3 * HOUR_MS)).toBe(11 * 5000);
    expect(p.fee("car", T0, T0 + 2 * DAY + 10 * HOUR_MS)).toBe(24 * 5000);
  });

  it("never charges less for a longer stay (checked every 7 minutes over 3 days, with and without a cap)", () => {
    for (const pricing of [p, new HourlyPricing(rates, { graceMinutes: 10 }), new HourlyPricing(rates, { graceMinutes: 30, dailyCapHours: 1 })]) {
      let last = 0;
      for (let ms = 0; ms <= 3 * DAY; ms += 7 * MINUTE_MS) {
        const fee = pricing.fee("car", T0, T0 + ms);
        expect(fee).toBeGreaterThanOrEqual(last);
        last = fee;
      }
    }
  });

  it.each([0, 25, 2.5])("rejects dailyCapHours %s", (bad) => {
    expect(() => new HourlyPricing(rates, { dailyCapHours: bad })).toThrow(expect.objectContaining({ code: "INVALID_RATE" }));
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
