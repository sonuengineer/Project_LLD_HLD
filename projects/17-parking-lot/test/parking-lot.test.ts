import { describe, expect, it } from "vitest";
import { nearestFirst, type AllocationStrategy } from "../src/allocation.js";
import { ManualClock } from "../src/clock.js";
import { ParkingLot, normalizePlate, type LotLayout } from "../src/parking-lot.js";
import { HOUR_MS, HourlyPricing, MINUTE_MS, type PricingStrategy } from "../src/pricing.js";

const T0 = Date.UTC(2026, 10, 22, 9, 0);
const pricing = new HourlyPricing({ motorcycle: 2000, car: 5000, truck: 10000 }, { graceMinutes: 10 });

function makeLot(layout: LotLayout, extra: { allocation?: AllocationStrategy; pricing?: PricingStrategy } = {}) {
  const clock = new ManualClock(T0);
  const lot = new ParkingLot({ layout, pricing: extra.pricing ?? pricing, allocation: extra.allocation, clock });
  return { lot, clock };
}

// Everything observable about the lot, to prove a failed call changed nothing.
function state(lot: ParkingLot) {
  return JSON.stringify({ spots: lot.snapshot(), tickets: lot.activeTickets, board: lot.availability() });
}

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return undefined;
}

describe("normalizePlate", () => {
  it("upper-cases and drops spaces and hyphens", () => {
    expect(normalizePlate(" mh 12-ab 1234 ")).toBe("MH12AB1234");
  });

  it.each(["", "   ", "MH12*AB", "ABCDEFGHIJKLM"])("rejects %j", (bad) => {
    expect(code(() => normalizePlate(bad))).toBe("INVALID_PLATE");
  });
});

describe("layout", () => {
  it("names spots L<level>-<position from 1>", () => {
    const { lot } = makeLot([["small", "compact"], ["large"]]);
    expect(lot.snapshot().map((s) => s.id)).toEqual(["L0-1", "L0-2", "L1-1"]);
  });

  it.each([
    ["no levels", []],
    ["an empty level", [["compact"], []]],
    ["an unknown size", [["compact", "huge"]]],
  ])("rejects %s", (_label, layout) => {
    expect(code(() => makeLot(layout as LotLayout))).toBe("INVALID_LAYOUT");
  });
});

describe("park", () => {
  it("returns a ticket with the spot, level, normalised plate and entry time", () => {
    const { lot } = makeLot([["compact"]]);
    const t = lot.park("mh12 ab 1234", "car");
    expect(t).toMatchObject({ plate: "MH12AB1234", vehicle: "car", spotId: "L0-1", level: 0, entryAt: T0 });
    expect(t.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(lot.snapshot()[0]!.heldBy).toBe(t.id);
  });

  it("gives every ticket a different id", () => {
    const { lot } = makeLot([["compact", "compact", "compact"]]);
    const ids = new Set(["A1", "A2", "A3"].map((p) => lot.park(p, "car").id));
    expect(ids.size).toBe(3);
  });

  it("uses the default strategy smallest-fit-first: a car skips the near large spot", () => {
    const { lot } = makeLot([["large"], ["compact"]]);
    expect(lot.park("A1", "car").spotId).toBe("L1-1");
  });

  it("uses a plugged-in strategy: nearest-first puts the car in the large spot", () => {
    const { lot } = makeLot([["large"], ["compact"]], { allocation: nearestFirst });
    expect(lot.park("A1", "car").spotId).toBe("L0-1");
  });

  it("only offers fitting spots: a truck never gets a compact spot", () => {
    const { lot } = makeLot([["compact", "compact", "large"]], { allocation: nearestFirst });
    expect(lot.park("T1", "truck").spotId).toBe("L0-3");
  });

  it("is full for trucks while compact spots are still free, and that changes nothing", () => {
    const { lot } = makeLot([["compact", "large"]]);
    lot.park("T1", "truck");
    const before = state(lot);
    expect(code(() => lot.park("T2", "truck"))).toBe("LOT_FULL");
    expect(state(lot)).toBe(before);
    expect(lot.park("C1", "car").spotId).toBe("L0-1"); // the compact spot was still there
  });

  it("refuses the same plate twice, in any spelling, and that changes nothing", () => {
    const { lot } = makeLot([["compact", "compact"]]);
    lot.park("MH12AB1234", "car");
    const before = state(lot);
    expect(code(() => lot.park("mh-12-ab-1234", "car"))).toBe("ALREADY_PARKED");
    expect(code(() => lot.park("MH12AB1234", "motorcycle"))).toBe("ALREADY_PARKED");
    expect(state(lot)).toBe(before);
  });

  it("rejects an unknown vehicle type and an invalid plate, changing nothing", () => {
    const { lot } = makeLot([["compact"]]);
    const before = state(lot);
    expect(code(() => lot.park("A1", "bus" as never))).toBe("INVALID_VEHICLE");
    expect(code(() => lot.park("??", "car"))).toBe("INVALID_PLATE");
    expect(state(lot)).toBe(before);
  });

  it.each([
    ["undefined", () => undefined],
    ["a spot that does not fit", (_v: unknown, _c: unknown) => "not-a-spot"],
  ])("rejects a strategy that returns %s, changing nothing", (_label, choose) => {
    const bad = { name: "bad", choose } as unknown as AllocationStrategy;
    const { lot } = makeLot([["compact"]], { allocation: bad });
    const before = state(lot);
    expect(code(() => lot.park("A1", "car"))).toBe("STRATEGY_BUG");
    expect(state(lot)).toBe(before);
  });

  it("rejects a strategy that returns an occupied spot, changing nothing", () => {
    // The strategy remembers a spot it saw earlier and returns it again after it was taken.
    let remembered: unknown;
    const sticky: AllocationStrategy = {
      name: "sticky",
      choose: (_v, c) => (remembered ??= c[0]) as never,
    };
    const { lot } = makeLot([["compact", "compact"]], { allocation: sticky });
    lot.park("A1", "car");
    const before = state(lot);
    expect(code(() => lot.park("A2", "car"))).toBe("STRATEGY_BUG");
    expect(state(lot)).toBe(before);
  });
});

describe("exit", () => {
  it("charges by the clock, frees the spot, and the spot can be used again", () => {
    const { lot, clock } = makeLot([["compact"]]);
    const t = lot.park("A1", "car");
    clock.advance(2 * HOUR_MS + 8 * MINUTE_MS);
    const r = lot.exit(t.id);
    expect(r).toMatchObject({ exitAt: T0 + 128 * MINUTE_MS, durationMs: 128 * MINUTE_MS, feeMinor: 15000 });
    expect(r.ticket).toBe(t);
    expect(lot.snapshot()[0]!.heldBy).toBeNull();
    expect(lot.findByPlate("A1")).toBeUndefined();
    expect(lot.park("A1", "car").spotId).toBe("L0-1"); // same plate may come back
  });

  it("is free inside the grace period", () => {
    const { lot, clock } = makeLot([["compact"]]);
    const t = lot.park("A1", "car");
    clock.advance(10 * MINUTE_MS);
    expect(lot.exit(t.id).feeMinor).toBe(0);
  });

  it("refuses a ticket used twice and an unknown ticket", () => {
    const { lot } = makeLot([["compact"]]);
    const t = lot.park("A1", "car");
    lot.exit(t.id);
    expect(code(() => lot.exit(t.id))).toBe("TICKET_NOT_ACTIVE");
    expect(code(() => lot.exit("no-such-ticket"))).toBe("TICKET_NOT_ACTIVE");
  });

  it("keeps the car parked when the clock went backwards", () => {
    const { lot, clock } = makeLot([["compact"]]);
    const t = lot.park("A1", "car");
    clock.set(T0 - 1);
    const before = state(lot);
    expect(code(() => lot.exit(t.id))).toBe("INVALID_TIME");
    expect(state(lot)).toBe(before);
    clock.set(T0 + HOUR_MS);
    expect(lot.exit(t.id).feeMinor).toBe(5000); // the ticket still works once time is sane
  });

  it.each([
    ["a fraction", 12.5],
    ["a negative number", -1],
    ["NaN", Number.NaN],
  ])("rejects a pricing strategy that returns %s, keeping the car parked", (_label, fee) => {
    const { lot } = makeLot([["compact"]], { pricing: { name: "bad", fee: () => fee } });
    const t = lot.park("A1", "car");
    const before = state(lot);
    expect(code(() => lot.exit(t.id))).toBe("STRATEGY_BUG");
    expect(code(() => lot.quote(t.id))).toBe("STRATEGY_BUG");
    expect(state(lot)).toBe(before);
  });
});

describe("quote", () => {
  it("returns what exit would charge now and changes nothing", () => {
    const { lot, clock } = makeLot([["compact"]]);
    const t = lot.park("A1", "car");
    clock.advance(61 * MINUTE_MS);
    const before = state(lot);
    expect(lot.quote(t.id)).toBe(10000);
    expect(state(lot)).toBe(before);
    expect(lot.exit(t.id).feeMinor).toBe(10000);
  });

  it("refuses an unknown ticket", () => {
    const { lot } = makeLot([["compact"]]);
    expect(code(() => lot.quote("nope"))).toBe("TICKET_NOT_ACTIVE");
  });
});

describe("lookups", () => {
  it("availability: one row per level and size that exists, updated by park and exit", () => {
    const { lot } = makeLot([["small", "compact", "compact"], ["large"]]);
    const t = lot.park("A1", "car");
    expect(lot.availability()).toEqual([
      { level: 0, size: "small", free: 1, total: 1 },
      { level: 0, size: "compact", free: 1, total: 2 },
      { level: 1, size: "large", free: 1, total: 1 },
    ]);
    lot.exit(t.id);
    expect(lot.availability()[1]).toEqual({ level: 0, size: "compact", free: 2, total: 2 });
  });

  it("findByPlate accepts any spelling of the plate", () => {
    const { lot } = makeLot([["compact"]]);
    const t = lot.park("MH12AB1234", "car");
    expect(lot.findByPlate("mh 12 ab 1234")).toBe(t);
    expect(lot.findByPlate("OTHER1")).toBeUndefined();
  });

  it("tickets are frozen: a caller cannot move its car to another spot", () => {
    const { lot } = makeLot([["compact", "compact"]]);
    const t = lot.park("A1", "car");
    expect(() => {
      (t as { spotId: string }).spotId = "L0-2";
    }).toThrow(TypeError);
    expect(lot.findByPlate("A1")!.spotId).toBe("L0-1");
  });
});
