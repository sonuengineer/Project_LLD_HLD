import { describe, expect, it } from "vitest";
import { ManualClock } from "../src/clock.js";
import { FakePaymentGateway } from "../src/fake-gateway.js";
import { ExitGate, type ExitDevice } from "../src/gates.js";
import { ParkingLot, type ParkingLotOptions } from "../src/parking-lot.js";
import { PayStation } from "../src/pay-station.js";
import { HOUR_MS, HourlyPricing, MINUTE_MS } from "../src/pricing.js";

const T0 = Date.UTC(2026, 10, 23, 9, 0);
const fast = { retryDelayMs: 0 };
const openBarrier: ExitDevice = { open: async () => {} };

function makeLot(extra: Partial<ParkingLotOptions> = {}) {
  const clock = new ManualClock(T0);
  const lot = new ParkingLot({
    layout: [["compact", "compact"]],
    pricing: new HourlyPricing({ motorcycle: 1000, car: 5000, truck: 9000 }),
    clock,
    ...extra,
  });
  return { lot, clock, gateway: new FakePaymentGateway() };
}

const state = (lot: ParkingLot) => JSON.stringify({ s: lot.snapshot(), t: lot.activeTickets });
function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return undefined;
}

describe("lot: beginPayment / recordPayment / abortPayment", () => {
  it("locks the ticket and fixes the amount; recording it ends the lock", () => {
    const { lot, clock } = makeLot();
    const t = lot.park("A1", "car");
    clock.advance(90 * MINUTE_MS);
    const q = lot.beginPayment(t.id);
    expect(q).toMatchObject({ feeMinor: 10000, paidMinor: 0, dueMinor: 10000, at: T0 + 90 * MINUTE_MS });
    expect(q.paymentKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(lot.statusOf(t.id)).toBe("paying");
    expect(code(() => lot.beginPayment(t.id))).toBe("TICKET_BUSY");
    expect(code(() => lot.beginExit(t.id))).toBe("TICKET_BUSY");
    clock.advance(HOUR_MS); // slow card reader: the amount does not change
    expect(lot.quote(t.id)).toBe(10000);
    const p = lot.recordPayment(t.id, "pay_1");
    expect(p).toEqual({ paymentId: "pay_1", amountMinor: 10000, at: q.at });
    expect(lot.statusOf(t.id)).toBe("active");
  });

  it("abortPayment unlocks without recording anything", () => {
    const { lot, clock } = makeLot();
    const t = lot.park("A1", "car");
    clock.advance(HOUR_MS);
    lot.beginPayment(t.id);
    lot.abortPayment(t.id);
    expect(lot.statusOf(t.id)).toBe("active");
    expect(lot.paymentsFor(t.id)).toEqual([]);
    expect(lot.quote(t.id)).toBe(5000);
  });

  it("refuses: nothing due, record without a lock, abort without a payment, empty or repeated payment id", () => {
    const { lot, clock } = makeLot();
    const t = lot.park("A1", "car");
    expect(code(() => lot.beginPayment(t.id))).toBe("NOTHING_DUE"); // zero-length stay costs 0
    expect(code(() => lot.recordPayment(t.id, "p"))).toBe("PAYMENT_NOT_STARTED");
    expect(code(() => lot.abortPayment(t.id))).toBe("PAYMENT_NOT_STARTED");
    clock.advance(HOUR_MS);
    lot.beginPayment(t.id);
    const before = state(lot);
    expect(code(() => lot.recordPayment(t.id, ""))).toBe("INVALID_PAYMENT_ID");
    expect(state(lot)).toBe(before);
    lot.recordPayment(t.id, "p1");
    clock.advance(HOUR_MS); // after the window: more is due
    lot.beginPayment(t.id);
    expect(code(() => lot.recordPayment(t.id, "p1"))).toBe("INVALID_PAYMENT_ID");
    expect(lot.statusOf(t.id)).toBe("paying");
  });

  it("abortPayment is refused during an exit (it would release the exit lock)", () => {
    const { lot } = makeLot();
    const t = lot.park("A1", "car");
    lot.beginExit(t.id);
    expect(code(() => lot.abortPayment(t.id))).toBe("PAYMENT_NOT_STARTED");
    expect(lot.statusOf(t.id)).toBe("exiting");
  });

  it("an exit lock with nothing due cannot record a payment", () => {
    const { lot } = makeLot();
    const t = lot.park("A1", "car");
    lot.beginExit(t.id);
    expect(code(() => lot.recordPayment(t.id, "p"))).toBe("NOTHING_DUE");
  });
});

describe("pay, then leave within the exit window", () => {
  it("paid at the station: leaving within the window owes nothing", () => {
    const { lot, clock } = makeLot({ exitWindowMinutes: 15 });
    const t = lot.park("A1", "car");
    clock.advance(90 * MINUTE_MS);
    lot.beginPayment(t.id);
    lot.recordPayment(t.id, "p1");
    clock.advance(15 * MINUTE_MS); // exactly at the end of the window
    expect(lot.quote(t.id)).toBe(0);
    const q = lot.beginExit(t.id);
    expect(q).toMatchObject({ feeMinor: 10000, paidMinor: 10000, dueMinor: 0 });
    expect(lot.commitExit(t.id)).toMatchObject({ feeMinor: 10000, paidMinor: 10000 });
  });

  it("after the window, only the extra time is charged, never the first part again", () => {
    const { lot, clock } = makeLot({ exitWindowMinutes: 15 });
    const t = lot.park("A1", "car");
    clock.advance(90 * MINUTE_MS); // 2 started hours
    lot.beginPayment(t.id);
    lot.recordPayment(t.id, "p1");
    clock.advance(15 * MINUTE_MS + 1); // 105 min + 1 ms: still 2 started hours
    expect(lot.quote(t.id)).toBe(0);
    clock.advance(20 * MINUTE_MS); // 125 min: 3 started hours
    expect(lot.billFor(t.id)).toEqual({ feeMinor: 15000, paidMinor: 10000, dueMinor: 5000 });
  });

  it("a second payment opens a new window from its own time", () => {
    const { lot, clock } = makeLot({ exitWindowMinutes: 10 });
    const t = lot.park("A1", "car");
    clock.advance(HOUR_MS);
    lot.beginPayment(t.id);
    lot.recordPayment(t.id, "p1");
    clock.advance(2 * HOUR_MS);
    lot.beginPayment(t.id);
    lot.recordPayment(t.id, "p2");
    clock.advance(10 * MINUTE_MS);
    expect(lot.quote(t.id)).toBe(0);
    expect(lot.exit(t.id)).toMatchObject({ feeMinor: 15000, paidMinor: 15000, payments: [{ paymentId: "p1" }, { paymentId: "p2" }] });
  });

  it("the window option is validated", () => {
    expect(code(() => makeLot({ exitWindowMinutes: -1 }))).toBe("INVALID_OPTION");
    expect(code(() => makeLot({ lostTicketPenaltyMinor: 1.5 }))).toBe("INVALID_OPTION");
  });
});

describe("commitExit and the booth", () => {
  it("commitExit refuses while money is due, and nothing changes", () => {
    const { lot, clock } = makeLot();
    const t = lot.park("A1", "car");
    clock.advance(HOUR_MS);
    lot.beginExit(t.id);
    const before = state(lot);
    expect(code(() => lot.commitExit(t.id))).toBe("PAYMENT_REQUIRED");
    expect(state(lot)).toBe(before);
  });

  it("exit() (attendant booth) collects the due amount in cash and lists it on the receipt", () => {
    const { lot, clock } = makeLot();
    const t = lot.park("A1", "car");
    clock.advance(HOUR_MS);
    const r = lot.exit(t.id);
    expect(r.payments).toEqual([expect.objectContaining({ amountMinor: 5000 })]);
    expect(r.payments[0]!.paymentId).toMatch(/^cash-/);
  });

  it("a free stay leaves with no payment at all", () => {
    const { lot } = makeLot();
    const t = lot.park("A1", "car");
    expect(lot.exit(t.id)).toMatchObject({ feeMinor: 0, paidMinor: 0, payments: [] });
  });
});

describe("PayStation", () => {
  it("charges the due amount once with the lot's key and records it", async () => {
    const { lot, clock, gateway } = makeLot();
    const t = lot.park("A1", "car");
    clock.advance(HOUR_MS);
    const p = await new PayStation(lot, gateway, fast).pay(t.id);
    expect(p.amountMinor).toBe(5000);
    expect(gateway.charges).toEqual([expect.objectContaining({ paymentId: p.paymentId, amountMinor: 5000, reference: t.id })]);
    expect(lot.quote(t.id)).toBe(0);
  });

  it("lost response: the retry gets the same payment; charged once, recorded once", async () => {
    const { lot, clock, gateway } = makeLot();
    gateway.enqueue("lose-response");
    const t = lot.park("A1", "car");
    clock.advance(HOUR_MS);
    await new PayStation(lot, gateway, fast).pay(t.id);
    expect(gateway.calls).toBe(2);
    expect(gateway.totalChargedMinor()).toBe(5000);
    expect(lot.paymentsFor(t.id)).toHaveLength(1);
  });

  it("declined: nothing charged, nothing recorded, the ticket is unlocked", async () => {
    const { lot, clock, gateway } = makeLot();
    gateway.enqueue("decline");
    const t = lot.park("A1", "car");
    clock.advance(HOUR_MS);
    await expect(new PayStation(lot, gateway, fast).pay(t.id)).rejects.toMatchObject({ code: "PAYMENT_DECLINED" });
    expect(lot.statusOf(t.id)).toBe("active");
    expect(lot.quote(t.id)).toBe(5000);
  });

  it("outcome unknown: PAYMENT_UNKNOWN, ticket unlocked, nothing recorded", async () => {
    const { lot, clock, gateway } = makeLot();
    gateway.enqueue("fail", "fail", "fail");
    const t = lot.park("A1", "car");
    clock.advance(HOUR_MS);
    await expect(new PayStation(lot, gateway, fast).pay(t.id)).rejects.toMatchObject({ code: "PAYMENT_UNKNOWN" });
    expect(lot.statusOf(t.id)).toBe("active");
    expect(lot.paymentsFor(t.id)).toEqual([]);
  });

  it("two stations with the same ticket at once: one charge", async () => {
    const { lot, clock, gateway } = makeLot();
    const t = lot.park("A1", "car");
    clock.advance(HOUR_MS);
    const results = await Promise.allSettled([new PayStation(lot, gateway, fast).pay(t.id), new PayStation(lot, gateway, fast).pay(t.id)]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected"]);
    expect((results[1] as PromiseRejectedResult).reason).toMatchObject({ code: "TICKET_BUSY" });
    expect(gateway.totalChargedMinor()).toBe(5000);
  });

  it("nothing due: refused before the gateway is called", async () => {
    const { lot, gateway } = makeLot();
    const t = lot.park("A1", "car");
    await expect(new PayStation(lot, gateway, fast).pay(t.id)).rejects.toMatchObject({ code: "NOTHING_DUE" });
    expect(gateway.calls).toBe(0);
  });
});

describe("ExitGate with a card reader", () => {
  it("charges at the gate, then opens; the receipt shows the payment", async () => {
    const { lot, clock, gateway } = makeLot();
    const t = lot.park("A1", "car");
    clock.advance(HOUR_MS);
    const r = await new ExitGate(lot, openBarrier, { gateway, payment: fast }).leave(t.id);
    expect(r).toMatchObject({ feeMinor: 5000, paidMinor: 5000 });
    expect(r.payments[0]!.paymentId).toBe(gateway.charges[0]!.paymentId);
  });

  it("without a card reader, an unpaid ticket gets PAYMENT_REQUIRED and the barrier stays shut", async () => {
    const { lot, clock } = makeLot();
    const t = lot.park("A1", "car");
    clock.advance(HOUR_MS);
    let opened = 0;
    const device: ExitDevice = { open: async () => void opened++ };
    await expect(new ExitGate(lot, device).leave(t.id)).rejects.toMatchObject({ code: "PAYMENT_REQUIRED" });
    expect(opened).toBe(0);
    expect(lot.statusOf(t.id)).toBe("active");
  });

  it("without a card reader, a ticket paid at the station leaves", async () => {
    const { lot, clock, gateway } = makeLot();
    const t = lot.park("A1", "car");
    clock.advance(HOUR_MS);
    await new PayStation(lot, gateway, fast).pay(t.id);
    clock.advance(5 * MINUTE_MS);
    expect(await new ExitGate(lot, openBarrier).leave(t.id)).toMatchObject({ feeMinor: 5000, paidMinor: 5000 });
  });

  it("declined at the gate: barrier shut, car inside, nothing charged", async () => {
    const { lot, clock, gateway } = makeLot();
    gateway.enqueue("decline");
    const t = lot.park("A1", "car");
    clock.advance(HOUR_MS);
    await expect(new ExitGate(lot, openBarrier, { gateway, payment: fast }).leave(t.id)).rejects.toMatchObject({ code: "PAYMENT_DECLINED" });
    expect(lot.statusOf(t.id)).toBe("active");
    expect(gateway.totalChargedMinor()).toBe(0);
  });

  it("paid at the gate, then the barrier failed: the next try does not charge again", async () => {
    const { lot, clock, gateway } = makeLot();
    const t = lot.park("A1", "car");
    clock.advance(HOUR_MS);
    const stuck: ExitDevice = {
      open: async () => {
        throw new Error("barrier stuck");
      },
    };
    await expect(new ExitGate(lot, stuck, { gateway, payment: fast }).leave(t.id)).rejects.toMatchObject({ code: "DEVICE_FAILED" });
    expect(lot.paymentsFor(t.id)).toHaveLength(1);
    clock.advance(MINUTE_MS);
    const r = await new ExitGate(lot, openBarrier, { gateway, payment: fast }).leave(t.id);
    expect(r).toMatchObject({ feeMinor: 5000, paidMinor: 5000 });
    expect(gateway.calls).toBe(1);
    expect(gateway.totalChargedMinor()).toBe(5000);
  });
});

describe("lost ticket", () => {
  it("issues a replacement for the same stay with the penalty, and kills the old ticket", () => {
    const { lot, clock } = makeLot({ lostTicketPenaltyMinor: 20000 });
    const old = lot.park("MH12AB1234", "car");
    clock.advance(HOUR_MS);
    const fresh = lot.reportLost("mh 12 ab 1234");
    expect(fresh).toMatchObject({ plate: old.plate, spotId: old.spotId, entryAt: old.entryAt, replaces: old.id });
    expect(fresh.id).not.toBe(old.id);
    expect(lot.snapshot()[0]!.heldBy).toBe(fresh.id);
    expect(lot.findByPlate("MH12AB1234")).toBe(fresh);
    expect(lot.billFor(fresh.id)).toEqual({ feeMinor: 25000, paidMinor: 0, dueMinor: 25000 });
    // Whoever holds the old ticket cannot use it any more.
    expect(code(() => lot.beginExit(old.id))).toBe("TICKET_REPLACED");
    expect(code(() => lot.quote(old.id))).toBe("TICKET_REPLACED");
    expect(lot.exit(fresh.id).feeMinor).toBe(25000);
  });

  it("keeps payments made before the loss", () => {
    const { lot, clock } = makeLot({ lostTicketPenaltyMinor: 20000 });
    const old = lot.park("A1", "car");
    clock.advance(HOUR_MS);
    lot.beginPayment(old.id);
    lot.recordPayment(old.id, "p1");
    const fresh = lot.reportLost("A1");
    expect(lot.billFor(fresh.id)).toEqual({ feeMinor: 25000, paidMinor: 5000, dueMinor: 20000 });
  });

  it("refuses an unknown plate, a car still entering, and a ticket in the middle of a payment, changing nothing", () => {
    const { lot, clock } = makeLot();
    expect(code(() => lot.reportLost("NOPE1"))).toBe("TICKET_NOT_ACTIVE");
    lot.reserve("R1", "car");
    expect(code(() => lot.reportLost("R1"))).toBe("TICKET_NOT_ACTIVE");
    const t = lot.park("A1", "car");
    clock.advance(HOUR_MS);
    lot.beginPayment(t.id);
    const before = state(lot);
    expect(code(() => lot.reportLost("A1"))).toBe("TICKET_BUSY");
    expect(state(lot)).toBe(before);
  });
});
