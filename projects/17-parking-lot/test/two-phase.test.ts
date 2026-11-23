import { describe, expect, it } from "vitest";
import { ManualClock } from "../src/clock.js";
import { ParkingLot, type AvailabilityChanged, type LotLayout } from "../src/parking-lot.js";
import { HOUR_MS, HourlyPricing } from "../src/pricing.js";

const T0 = Date.UTC(2026, 10, 22, 9, 0);

function makeLot(layout: LotLayout = [["compact", "compact"]]) {
  const clock = new ManualClock(T0);
  const lot = new ParkingLot({ layout, pricing: new HourlyPricing({ motorcycle: 1, car: 5000, truck: 3 }), clock });
  const events: AvailabilityChanged[] = [];
  lot.subscribe((e) => events.push(e));
  return { lot, clock, events };
}

const state = (lot: ParkingLot) => JSON.stringify({ s: lot.snapshot(), t: lot.activeTickets, b: lot.availability() });
function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return undefined;
}

describe("reserve / confirm / cancel", () => {
  it("reserve holds the spot and the plate, but the car is not parked yet", () => {
    const { lot } = makeLot();
    const t = lot.reserve("A1", "car");
    expect(lot.statusOf(t.id)).toBe("reserved");
    expect(lot.snapshot()[0]).toMatchObject({ state: "reserved", heldBy: t.id });
    expect(lot.availability()[0]!.free).toBe(1);
    expect(lot.activeTickets).toEqual([]);
    expect(lot.findByPlate("A1")).toBeUndefined();
    expect(code(() => lot.reserve("A1", "car"))).toBe("ALREADY_PARKED"); // same plate at another gate
    expect(code(() => lot.quote(t.id))).toBe("TICKET_NOT_ACTIVE");
    expect(code(() => lot.exit(t.id))).toBe("TICKET_NOT_ACTIVE");
  });

  it("a reserved spot is not offered to the next car", () => {
    const { lot } = makeLot([["compact"]]);
    lot.reserve("A1", "car");
    expect(code(() => lot.reserve("A2", "car"))).toBe("LOT_FULL");
  });

  it("confirm parks the car with the same ticket", () => {
    const { lot } = makeLot();
    const t = lot.reserve("A1", "car");
    expect(lot.confirm(t.id)).toBe(t);
    expect(lot.statusOf(t.id)).toBe("active");
    expect(lot.snapshot()[0]!.state).toBe("occupied");
    expect(lot.findByPlate("A1")).toBe(t);
  });

  it("cancel frees the spot and the plate; the spot is offered again first", () => {
    const { lot } = makeLot();
    const t = lot.reserve("A1", "car");
    lot.cancel(t.id);
    expect(lot.statusOf(t.id)).toBeUndefined();
    expect(lot.availability()[0]!.free).toBe(2);
    expect(lot.reserve("A1", "car").spotId).toBe("L0-1");
  });

  it("confirm and cancel only accept a pending reservation, changing nothing otherwise", () => {
    const { lot } = makeLot();
    const t = lot.park("A1", "car");
    const before = state(lot);
    expect(code(() => lot.confirm(t.id))).toBe("RESERVATION_NOT_FOUND");
    expect(code(() => lot.cancel(t.id))).toBe("RESERVATION_NOT_FOUND");
    expect(code(() => lot.cancel("nope"))).toBe("RESERVATION_NOT_FOUND");
    expect(state(lot)).toBe(before);
    const r = lot.reserve("A2", "car");
    lot.cancel(r.id);
    expect(code(() => lot.cancel(r.id))).toBe("RESERVATION_NOT_FOUND");
    expect(code(() => lot.confirm(r.id))).toBe("RESERVATION_NOT_FOUND");
  });

  it("entry time is the reservation time (what the printed ticket shows)", () => {
    const { lot, clock } = makeLot();
    const t = lot.reserve("A1", "car");
    clock.advance(5000);
    expect(lot.confirm(t.id).entryAt).toBe(T0);
  });
});

describe("beginExit / commitExit / abortExit", () => {
  it("beginExit fixes the fee and locks the ticket; commit uses that fee", () => {
    const { lot, clock } = makeLot();
    const t = lot.park("A1", "car");
    clock.advance(HOUR_MS);
    const q = lot.beginExit(t.id);
    expect(q).toMatchObject({ exitAt: T0 + HOUR_MS, feeMinor: 5000 });
    expect(lot.statusOf(t.id)).toBe("exiting");
    clock.advance(HOUR_MS); // the barrier is slow; the price does not change
    expect(lot.quote(t.id)).toBe(5000);
    expect(code(() => lot.beginExit(t.id))).toBe("TICKET_BUSY");
    expect(code(() => lot.exit(t.id))).toBe("TICKET_BUSY");
    expect(code(() => lot.commitExit(t.id))).toBe("PAYMENT_REQUIRED"); // the barrier rule
    expect(lot.statusOf(t.id)).toBe("exiting");
    lot.recordPayment(t.id, "pay_1");
    const r = lot.commitExit(t.id);
    expect(r).toMatchObject({ exitAt: T0 + HOUR_MS, feeMinor: 5000, paidMinor: 5000, durationMs: HOUR_MS });
    expect(lot.statusOf(t.id)).toBeUndefined();
    expect(lot.availability()[0]!.free).toBe(2);
  });

  it("abortExit makes the ticket usable again and the fee is re-computed later", () => {
    const { lot, clock } = makeLot();
    const t = lot.park("A1", "car");
    clock.advance(HOUR_MS);
    lot.beginExit(t.id);
    lot.abortExit(t.id);
    expect(lot.statusOf(t.id)).toBe("active");
    expect(lot.snapshot()[0]!.state).toBe("occupied");
    clock.advance(HOUR_MS);
    expect(lot.exit(t.id).feeMinor).toBe(10000);
  });

  it("commit and abort need a started exit, changing nothing otherwise", () => {
    const { lot } = makeLot();
    const t = lot.park("A1", "car");
    const before = state(lot);
    expect(code(() => lot.commitExit(t.id))).toBe("EXIT_NOT_STARTED");
    expect(code(() => lot.abortExit(t.id))).toBe("EXIT_NOT_STARTED");
    expect(code(() => lot.commitExit("nope"))).toBe("TICKET_NOT_ACTIVE");
    expect(state(lot)).toBe(before);
  });

  it("beginExit with the clock backwards changes nothing", () => {
    const { lot, clock } = makeLot();
    const t = lot.park("A1", "car");
    clock.set(T0 - 1);
    const before = state(lot);
    expect(code(() => lot.beginExit(t.id))).toBe("INVALID_TIME");
    expect(lot.statusOf(t.id)).toBe("active");
    expect(state(lot)).toBe(before);
  });
});

describe("availability events", () => {
  it("one event per count change, with the new count; confirm and beginExit emit none", () => {
    const { lot, events } = makeLot();
    const a = lot.reserve("A1", "car");
    lot.confirm(a.id);
    const b = lot.reserve("A2", "car");
    lot.cancel(b.id);
    lot.beginExit(a.id);
    lot.commitExit(a.id);
    expect(events.map((e) => e.free)).toEqual([1, 0, 1, 2]);
    expect(events.every((e) => e.level === 0 && e.size === "compact" && e.total === 2)).toBe(true);
  });

  it("failed calls emit nothing", () => {
    const { lot, events } = makeLot([["compact"]]);
    lot.park("A1", "car");
    events.length = 0;
    code(() => lot.park("A2", "car"));
    code(() => lot.park("A1", "car"));
    code(() => lot.cancel("nope"));
    expect(events).toEqual([]);
  });

  it("events are frozen copies: a listener cannot change the lot's counts", () => {
    const { lot } = makeLot();
    lot.subscribe((e) => {
      expect(() => ((e as { free: number }).free = 99)).toThrow(TypeError);
    });
    lot.park("A1", "car");
    expect(lot.availability()[0]!.free).toBe(1);
  });

  it("a listener that throws is reported, the change still happened, other listeners still ran", () => {
    const errors: unknown[] = [];
    const lot = new ParkingLot({
      layout: [["compact"]],
      pricing: new HourlyPricing({ motorcycle: 1, car: 1, truck: 1 }),
      onListenerError: (e) => errors.push(e),
    });
    const seen: number[] = [];
    lot.subscribe(() => {
      throw new Error("board offline");
    });
    lot.subscribe((e) => seen.push(e.free));
    const t = lot.park("A1", "car");
    expect(lot.statusOf(t.id)).toBe("active");
    expect(seen).toEqual([0]);
    expect(errors).toHaveLength(1);
  });

  it("an error handler that throws does not break the lot", () => {
    const lot = new ParkingLot({
      layout: [["compact"]],
      pricing: new HourlyPricing({ motorcycle: 1, car: 1, truck: 1 }),
      onListenerError: () => {
        throw new Error("logger down");
      },
    });
    lot.subscribe(() => {
      throw new Error("board offline");
    });
    const t = lot.park("A1", "car");
    expect(lot.statusOf(t.id)).toBe("active");
  });
});
