import { describe, expect, it } from "vitest";
import { nearestFirst, smallestFitFirst } from "../src/allocation.js";
import { ManualClock } from "../src/clock.js";
import { ParkingError } from "../src/errors.js";
import { ParkingLot, type Ticket } from "../src/parking-lot.js";
import { HourlyPricing, MINUTE_MS } from "../src/pricing.js";
import { VEHICLE_TYPES, fits } from "../src/types.js";

// Small seeded PRNG (mulberry32) so a failure is reproducible from the seed printed in the test name.
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

// After every step, compare the lot with an independent model and check the rules that must always hold.
function checkInvariants(lot: ParkingLot, model: Map<string, Ticket>) {
  const spots = lot.snapshot();
  const held = spots.filter((s) => s.heldBy !== null);
  // 1. Tickets inside == occupied spots == what the model says.
  expect(lot.activeTickets.length).toBe(model.size);
  expect(held.length).toBe(model.size);
  // 2. Every active ticket holds exactly its own spot, and the vehicle fits it.
  for (const t of lot.activeTickets) {
    const spot = spots.find((s) => s.id === t.spotId)!;
    expect(spot.heldBy).toBe(t.id);
    expect(fits(t.vehicle, spot.size)).toBe(true);
  }
  // 3. No plate twice.
  const plates = lot.activeTickets.map((t) => t.plate);
  expect(new Set(plates).size).toBe(plates.length);
  // 4. The board adds up.
  const free = lot.availability().reduce((n, r) => n + r.free, 0);
  expect(free).toBe(spots.length - held.length);
}

describe.each([
  ["smallest-fit-first", smallestFitFirst],
  ["nearest-first", nearestFirst],
])("random park/exit sequences (%s)", (_name, allocation) => {
  for (const seed of [1, 2, 3, 42, 2026]) {
    it(`seed ${seed}: 500 steps keep every invariant`, () => {
      const rand = rng(seed);
      const clock = new ManualClock(0);
      const lot = new ParkingLot({
        layout: [
          ["small", "small", "compact", "compact", "large"],
          ["compact", "compact", "large"],
        ],
        pricing: new HourlyPricing({ motorcycle: 1, car: 2, truck: 3 }),
        allocation,
        clock,
      });
      const model = new Map<string, Ticket>();
      let full = 0;

      for (let step = 0; step < 500; step++) {
        clock.advance(Math.floor(rand() * 90 * MINUTE_MS));
        const inside = [...model.values()];
        if (inside.length > 0 && rand() < 0.45) {
          const t = inside[Math.floor(rand() * inside.length)]!;
          const r = lot.exit(t.id);
          expect(r.feeMinor).toBeGreaterThanOrEqual(0);
          model.delete(t.id);
        } else {
          const vehicle = VEHICLE_TYPES[Math.floor(rand() * VEHICLE_TYPES.length)]!;
          // A small plate space makes "already parked" happen too.
          const plate = `P${Math.floor(rand() * 15)}`;
          try {
            const t = lot.park(plate, vehicle);
            model.set(t.id, t);
          } catch (e) {
            expect(e).toBeInstanceOf(ParkingError);
            const c = (e as ParkingError).code;
            expect(["LOT_FULL", "ALREADY_PARKED"]).toContain(c);
            if (c === "ALREADY_PARKED") expect([...model.values()].some((t) => t.plate === plate)).toBe(true);
            if (c === "LOT_FULL") {
              full++;
              expect(lot.snapshot().some((s) => s.heldBy === null && fits(vehicle, s.size))).toBe(false);
            }
          }
        }
        checkInvariants(lot, model);
      }
      // The sequence really did reach the interesting states.
      expect(full).toBeGreaterThan(0);
    });
  }
});
