import { describe, expect, it } from "vitest";
import { fittingSizes, nearestFirst, smallestFitFirst, type AllocationStrategy } from "../src/allocation.js";
import { ManualClock } from "../src/clock.js";
import { DisplayBoard } from "../src/display-board.js";
import { ParkingError } from "../src/errors.js";
import { EntryGate, ExitGate, type EntryDevice, type ExitDevice } from "../src/gates.js";
import { ParkingLot, type LotLayout, type Receipt, type Ticket } from "../src/parking-lot.js";
import { FakePaymentGateway } from "../src/fake-gateway.js";
import type { PaymentGateway } from "../src/payment.js";
import { HourlyPricing, MINUTE_MS } from "../src/pricing.js";
import { VEHICLE_TYPES, fits, type VehicleType } from "../src/types.js";

// Small seeded PRNG (mulberry32) so a failure is reproducible from the seed in the test name.
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T>(rand: () => number, xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;

const LAYOUT: LotLayout = [
  ["small", "small", "compact", "compact", "large"],
  ["compact", "compact", "large"],
];

// The stage 1 algorithm (scan every spot), kept here as the oracle for the index.
function expectedSpot(lot: ParkingLot, vehicle: VehicleType, strategy: AllocationStrategy): string | undefined {
  const free = lot.snapshot().filter((s) => s.state === "free");
  if (strategy === nearestFirst) return free.find((s) => fits(vehicle, s.size))?.id;
  for (const size of fittingSizes(vehicle)) {
    const s = free.find((x) => x.size === size);
    if (s) return s.id;
  }
  return undefined;
}

// Rules that must hold after every step, whatever happened.
function checkInvariants(lot: ParkingLot, board: DisplayBoard) {
  const spots = lot.snapshot();
  for (const s of spots) {
    if (s.state === "free") {
      expect(s.heldBy).toBeNull();
      continue;
    }
    const status = lot.statusOf(s.heldBy!);
    if (s.state === "reserved") expect(status).toBe("reserved");
    else expect(["active", "exiting"]).toContain(status);
  }
  for (const t of lot.activeTickets) {
    const spot = spots.find((s) => s.id === t.spotId)!;
    expect(spot.heldBy).toBe(t.id);
    expect(spot.state).toBe("occupied");
    expect(fits(t.vehicle, spot.size)).toBe(true);
  }
  const plates = lot.activeTickets.map((t) => t.plate);
  expect(new Set(plates).size).toBe(plates.length);
  const freeOnBoard = lot.availability().reduce((n, r) => n + r.free, 0);
  expect(freeOnBoard).toBe(spots.filter((s) => s.state === "free").length);
  expect(board.rows()).toEqual(lot.availability()); // the Observer never drifted
}

describe.each([
  ["smallest-fit-first", smallestFitFirst],
  ["nearest-first", nearestFirst],
])("random synchronous park/exit (%s)", (_name, allocation) => {
  for (const seed of [1, 2, 3, 42, 2026]) {
    it(`seed ${seed}: 500 steps, index agrees with a full scan every time`, () => {
      const rand = rng(seed);
      const clock = new ManualClock(0);
      const lot = new ParkingLot({ layout: LAYOUT, pricing: new HourlyPricing({ motorcycle: 1, car: 2, truck: 3 }), allocation, clock });
      const board = new DisplayBoard(lot);
      const model = new Map<string, Ticket>();
      let full = 0;

      for (let step = 0; step < 500; step++) {
        clock.advance(Math.floor(rand() * 90 * MINUTE_MS));
        const inside = [...model.values()];
        if (inside.length > 0 && rand() < 0.45) {
          const t = pick(rand, inside);
          expect(lot.exit(t.id).feeMinor).toBeGreaterThanOrEqual(0);
          model.delete(t.id);
        } else {
          const vehicle = pick(rand, VEHICLE_TYPES);
          const plate = `P${Math.floor(rand() * 15)}`; // small plate space: "already parked" happens too
          const expected = expectedSpot(lot, vehicle, allocation);
          try {
            const t = lot.park(plate, vehicle);
            expect(t.spotId).toBe(expected);
            model.set(t.id, t);
          } catch (e) {
            expect(e).toBeInstanceOf(ParkingError);
            const c = (e as ParkingError).code;
            expect(["LOT_FULL", "ALREADY_PARKED"]).toContain(c);
            if (c === "ALREADY_PARKED") expect(inside.some((t) => t.plate === plate)).toBe(true);
            if (c === "LOT_FULL") {
              full++;
              expect(expected).toBeUndefined();
            }
          }
        }
        expect(lot.activeTickets.length).toBe(model.size);
        checkInvariants(lot, board);
      }
      expect(full).toBeGreaterThan(0); // the run really reached a full lot
    });
  }
});

// Devices whose calls stay pending until the test settles them, in random order.
interface Call {
  kind: "entry" | "exit";
  ticketId: string;
  resolve: () => void;
  reject: (e: Error) => void;
}

describe("random concurrent gates", () => {
  for (const seed of [5, 6, 7, 8, 9]) {
    it(`seed ${seed}: 3 entry + 2 exit gates, devices settle in random order, 15% fail`, async () => {
      const rand = rng(seed);
      const clock = new ManualClock(0);
      const lot = new ParkingLot({ layout: LAYOUT, pricing: new HourlyPricing({ motorcycle: 1, car: 2, truck: 3 }), clock });
      const board = new DisplayBoard(lot);
      const pending: Call[] = [];
      const pendingCall = (kind: Call["kind"], ticketId: string) =>
        new Promise<void>((resolve, reject) => pending.push({ kind, ticketId, resolve: () => resolve(), reject }));
      const entryDevice: EntryDevice = { issue: (t) => pendingCall("entry", t.id) };
      // Counted inside the device: an exit's device call comes after the payment's await, not at leave() time.
      const exitDevice: ExitDevice = {
        open: (q) => {
          exitCalls++;
          return pendingCall("exit", q.ticket.id);
        },
      };
      // Card readers at the exits: mostly approve; sometimes decline, fail, or charge and lose the answer.
      const fake = new FakePaymentGateway();
      const gateway: PaymentGateway = {
        charge: (req, signal) => {
          const r = rand();
          fake.enqueue(r < 0.75 ? "approve" : r < 0.85 ? "decline" : r < 0.93 ? "lose-response" : "fail");
          return fake.charge(req, signal);
        },
      };
      const entries = [0, 1, 2].map(() => new EntryGate(lot, entryDevice));
      const exits = [0, 1].map(() => new ExitGate(lot, exitDevice, { gateway, payment: { retryDelayMs: 0 } }));
      const receipts: Receipt[] = [];

      let exitCalls = 0;
      const ops: Promise<{ kind: string; ok: boolean; code?: string }>[] = [];
      const track = (kind: string, p: Promise<unknown>) =>
        ops.push(p.then(() => ({ kind, ok: true }), (e: unknown) => ({ kind, ok: false, code: (e as ParkingError).code })));
      let entryCalls = 0;

      for (let step = 0; step < 400; step++) {
        clock.advance(Math.floor(rand() * 30 * MINUTE_MS));
        const r = rand();
        if (r < 0.35) {
          const before = pending.length;
          track("entry", pick(rand, entries).enter(`P${Math.floor(rand() * 12)}`, pick(rand, VEHICLE_TYPES)));
          entryCalls += pending.length - before;
        } else if (r < 0.55 && lot.activeTickets.length > 0) {
          track("exit", pick(rand, exits).leave(pick(rand, lot.activeTickets).id).then((rc) => receipts.push(rc)));
        } else if (pending.length > 0) {
          const call = pending.splice(Math.floor(rand() * pending.length), 1)[0]!;
          if (rand() < 0.15) call.reject(new Error("device fault"));
          else call.resolve();
        }
        await new Promise((res) => setImmediate(res));
        // Every outstanding device call is backed by a claim: a reserved spot or a locked ticket.
        for (const call of pending) {
          expect(lot.statusOf(call.ticketId)).toBe(call.kind === "entry" ? "reserved" : "exiting");
        }
        checkInvariants(lot, board);
      }

      while (pending.length > 0) pending.shift()!.resolve();
      const results = await Promise.all(ops);
      await new Promise((res) => setImmediate(res));
      checkInvariants(lot, board);

      for (const res of results) {
        if (!res.ok) {
          expect(["LOT_FULL", "ALREADY_PARKED", "DEVICE_FAILED", "TICKET_BUSY", "PAYMENT_DECLINED", "PAYMENT_UNKNOWN"]).toContain(res.code);
        }
      }
      // Money: every charge the provider made is recorded on a ticket exactly once (no double charge, nothing
      // charged without the lot knowing), and every car that left paid its full fee.
      const recorded = [...receipts.flatMap((rc) => rc.payments), ...lot.activeTickets.flatMap((t) => lot.paymentsFor(t.id))];
      expect(recorded.reduce((n, p) => n + p.amountMinor, 0)).toBe(fake.totalChargedMinor());
      expect(new Set(recorded.map((p) => p.paymentId)).size).toBe(recorded.length);
      for (const rc of receipts) expect(rc.paidMinor).toBe(rc.feeMinor);
      // A device ran exactly for the operations that got a claim and paid: successes and device failures.
      const ran = (kind: string) => results.filter((x) => x.kind === kind && (x.ok || x.code === "DEVICE_FAILED")).length;
      expect(ran("entry")).toBe(entryCalls);
      expect(ran("exit")).toBe(exitCalls);
      // The run reached the interesting cases.
      const codes = new Set(results.map((x) => x.code));
      expect(codes.has("LOT_FULL") && codes.has("DEVICE_FAILED") && codes.has("PAYMENT_DECLINED")).toBe(true);
      expect(receipts.some((rc) => rc.paidMinor > 0)).toBe(true);
    });
  }
});
