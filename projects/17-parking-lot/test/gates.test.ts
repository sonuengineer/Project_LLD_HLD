import { afterEach, describe, expect, it, vi } from "vitest";
import { ManualClock } from "../src/clock.js";
import { ParkingError } from "../src/errors.js";
import { EntryGate, ExitGate, type EntryDevice, type ExitDevice } from "../src/gates.js";
import { ParkingLot, type ExitQuote, type Ticket } from "../src/parking-lot.js";
import { HOUR_MS, HourlyPricing } from "../src/pricing.js";
import { FakePaymentGateway } from "../src/fake-gateway.js";
import { fits, type VehicleType } from "../src/types.js";

const T0 = Date.UTC(2026, 10, 22, 9, 0);

function makeLot(layout: ("small" | "compact" | "large")[][] = [["compact"]]) {
  const clock = new ManualClock(T0);
  return { lot: new ParkingLot({ layout, pricing: new HourlyPricing({ motorcycle: 1, car: 5000, truck: 1 }), clock }), clock };
}

// A device whose calls stay pending until the test settles them, so the test decides the interleaving.
class FakeDevice implements EntryDevice, ExitDevice {
  calls: { arg: Ticket | ExitQuote; signal: AbortSignal; resolve: () => void; reject: (e: Error) => void }[] = [];

  issue(ticket: Ticket, signal: AbortSignal): Promise<void> {
    return this.pending(ticket, signal);
  }

  open(quote: ExitQuote, signal: AbortSignal): Promise<void> {
    return this.pending(quote, signal);
  }

  private pending(arg: Ticket | ExitQuote, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => this.calls.push({ arg, signal, resolve: () => resolve(), reject }));
  }
}

const flush = () => new Promise((r) => setImmediate(r));
const codeOf = (e: unknown) => (e instanceof ParkingError ? e.code : String(e));

// ---- The bug this stage is about, reproduced with gates written the obvious way ----

// Check, then await the device, then act. Between the check and the act, other code runs.
class NaiveEntryGate {
  constructor(
    private readonly lot: ParkingLot,
    private readonly device: FakeDevice,
  ) {}

  async enter(plate: string, vehicle: VehicleType): Promise<Ticket> {
    const anyFree = this.lot.availability().some((r) => r.free > 0 && fits(vehicle, r.size));
    if (!anyFree) throw new ParkingError("LOT_FULL", "full");
    await this.device.issue({ plate } as Ticket, new AbortController().signal); // ticket printed, barrier opens
    return this.lot.park(plate, vehicle);
  }
}

class NaiveExitGate {
  constructor(
    private readonly lot: ParkingLot,
    private readonly device: FakeDevice,
  ) {}

  async leave(ticketId: string) {
    this.lot.quote(ticketId); // "is the ticket valid?"
    await this.device.open({} as ExitQuote, new AbortController().signal); // barrier opens
    return this.lot.exit(ticketId);
  }
}

describe("the race, with naive gates (documents the bug; not used by the lot)", () => {
  it("two naive entry gates, one free spot: both barriers open, the second car has no spot", async () => {
    const { lot } = makeLot([["compact"]]);
    const device = new FakeDevice();
    const g1 = new NaiveEntryGate(lot, device);
    const g2 = new NaiveEntryGate(lot, device);
    const p1 = g1.enter("A1", "car");
    const p2 = g2.enter("A2", "car");
    await flush();
    expect(device.calls).toHaveLength(2); // both checks passed: two tickets printed
    device.calls.forEach((c) => c.resolve());
    const results = await Promise.allSettled([p1, p2]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected"]);
    expect(codeOf((results[1] as PromiseRejectedResult).reason)).toBe("LOT_FULL"); // ...after its barrier opened
  });

  it("one ticket at two naive exit gates: both barriers open", async () => {
    const { lot } = makeLot([["compact"]]);
    const t = lot.park("A1", "car");
    const device = new FakeDevice();
    const p1 = new NaiveExitGate(lot, device).leave(t.id);
    const p2 = new NaiveExitGate(lot, device).leave(t.id);
    await flush();
    expect(device.calls).toHaveLength(2); // a second car drives out on the copy
    device.calls.forEach((c) => c.resolve());
    const results = await Promise.allSettled([p1, p2]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected"]);
  });
});

// ---- The fix ----

describe("EntryGate", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("two gates, one free spot: only one ticket is printed, the other car is refused before its device runs", async () => {
    const { lot } = makeLot([["compact"]]);
    const device = new FakeDevice();
    const p1 = new EntryGate(lot, device).enter("A1", "car");
    const p2 = new EntryGate(lot, device).enter("A2", "car");
    await expect(p2).rejects.toMatchObject({ code: "LOT_FULL" });
    expect(device.calls).toHaveLength(1);
    device.calls[0]!.resolve();
    const t = await p1;
    expect(lot.statusOf(t.id)).toBe("active");
  });

  it("the same plate at two gates at once gets one ticket", async () => {
    const { lot } = makeLot([["compact", "compact"]]);
    const device = new FakeDevice();
    const p1 = new EntryGate(lot, device).enter("MH12AB1234", "car");
    const p2 = new EntryGate(lot, device).enter("mh 12 ab 1234", "car");
    await expect(p2).rejects.toMatchObject({ code: "ALREADY_PARKED" });
    device.calls[0]!.resolve();
    await p1;
    expect(lot.activeTickets).toHaveLength(1);
  });

  it("while the device runs, the spot is reserved, not free and not parked", async () => {
    const { lot } = makeLot([["compact"]]);
    const device = new FakeDevice();
    const p = new EntryGate(lot, device).enter("A1", "car");
    await flush();
    expect(lot.snapshot()[0]!.state).toBe("reserved");
    expect(lot.availability()[0]!.free).toBe(0);
    expect(lot.activeTickets).toEqual([]);
    device.calls[0]!.resolve();
    await p;
    expect(lot.snapshot()[0]!.state).toBe("occupied");
  });

  it("device failure: DEVICE_FAILED with the cause, reservation cancelled, spot and plate free again", async () => {
    const { lot } = makeLot([["compact"]]);
    const device = new FakeDevice();
    const p = new EntryGate(lot, device).enter("A1", "car");
    await flush();
    const ticketId = (device.calls[0]!.arg as Ticket).id;
    device.calls[0]!.reject(new Error("paper jam"));
    const e = await p.catch((x: unknown) => x);
    expect(e).toMatchObject({ code: "DEVICE_FAILED" });
    expect((e as Error).cause).toMatchObject({ message: "paper jam" });
    expect(lot.statusOf(ticketId)).toBeUndefined();
    expect(lot.snapshot()[0]!.state).toBe("free");
    expect(lot.park("A1", "car").spotId).toBe("L0-1");
  });

  it("a device that throws synchronously is handled like a failed one", async () => {
    const { lot } = makeLot([["compact"]]);
    const broken: EntryDevice = {
      issue: () => {
        throw new Error("driver crashed");
      },
    };
    await expect(new EntryGate(lot, broken).enter("A1", "car")).rejects.toMatchObject({ code: "DEVICE_FAILED" });
    expect(lot.snapshot()[0]!.state).toBe("free");
  });

  it("a device that hangs: timeout aborts the signal, cancels the reservation; a late success changes nothing", async () => {
    vi.useFakeTimers();
    const { lot } = makeLot([["compact"]]);
    const device = new FakeDevice();
    const p = new EntryGate(lot, device, { timeoutMs: 5000 }).enter("A1", "car");
    const settled = p.catch((x: unknown) => x);
    await vi.advanceTimersByTimeAsync(4999);
    expect(lot.snapshot()[0]!.state).toBe("reserved");
    await vi.advanceTimersByTimeAsync(1);
    expect(await settled).toMatchObject({ code: "DEVICE_FAILED" });
    expect(device.calls[0]!.signal.aborted).toBe(true);
    expect(lot.snapshot()[0]!.state).toBe("free");
    const before = JSON.stringify(lot.snapshot());
    device.calls[0]!.resolve(); // the printer finally answers
    await vi.advanceTimersByTimeAsync(0);
    expect(JSON.stringify(lot.snapshot())).toBe(before);
  });

  it("a fast device clears its timer (no timer left behind)", async () => {
    vi.useFakeTimers();
    const { lot } = makeLot([["compact"]]);
    const ok: EntryDevice = { issue: async () => {} };
    await new EntryGate(lot, ok, { timeoutMs: 5000 }).enter("A1", "car");
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("ExitGate", () => {
  it("one ticket at two exit gates: one barrier opens, the other gets TICKET_BUSY", async () => {
    const { lot, clock } = makeLot([["compact"]]);
    const t = lot.park("A1", "car");
    clock.advance(HOUR_MS);
    const device = new FakeDevice();
    const gateway = new FakePaymentGateway();
    const p1 = new ExitGate(lot, device, { gateway }).leave(t.id);
    const p2 = new ExitGate(lot, device, { gateway }).leave(t.id);
    await expect(p2).rejects.toMatchObject({ code: "TICKET_BUSY" });
    await flush();
    expect(device.calls).toHaveLength(1);
    expect((device.calls[0]!.arg as ExitQuote).feeMinor).toBe(5000); // the device shows the fee
    device.calls[0]!.resolve();
    expect((await p1).feeMinor).toBe(5000);
    expect(lot.statusOf(t.id)).toBeUndefined();
    expect(gateway.totalChargedMinor()).toBe(5000); // charged once
  });

  it("barrier failure: the car is still inside and the ticket works again", async () => {
    const { lot } = makeLot([["compact"]]);
    const t = lot.park("A1", "car");
    const device = new FakeDevice();
    const p = new ExitGate(lot, device).leave(t.id);
    await flush();
    device.calls[0]!.reject(new Error("barrier stuck"));
    await expect(p).rejects.toMatchObject({ code: "DEVICE_FAILED" });
    expect(lot.statusOf(t.id)).toBe("active");
    expect(lot.snapshot()[0]!.state).toBe("occupied");
    const ok: ExitDevice = { open: async () => {} };
    await new ExitGate(lot, ok).leave(t.id);
    expect(lot.statusOf(t.id)).toBeUndefined();
  });

  it("an unknown ticket is refused before the barrier is touched", async () => {
    const { lot } = makeLot([["compact"]]);
    const device = new FakeDevice();
    await expect(new ExitGate(lot, device).leave("nope")).rejects.toMatchObject({ code: "TICKET_NOT_ACTIVE" });
    expect(device.calls).toHaveLength(0);
  });
});
