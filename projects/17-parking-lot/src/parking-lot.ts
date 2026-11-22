import { randomUUID } from "node:crypto";
import { smallestFitFirst, type AllocationStrategy } from "./allocation.js";
import { systemClock, type Clock } from "./clock.js";
import { ParkingError } from "./errors.js";
import type { PricingStrategy } from "./pricing.js";
import { ParkingSpot } from "./spot.js";
import { SPOT_SIZES, fits, isSpotSize, isVehicleType, type SpotSize, type VehicleType } from "./types.js";

// layout[level][position] = size of that spot. Level 0 is the one nearest the entrance.
export type LotLayout = readonly (readonly SpotSize[])[];

export interface Ticket {
  readonly id: string;
  readonly plate: string; // normalised (see normalizePlate)
  readonly vehicle: VehicleType;
  readonly spotId: string;
  readonly level: number;
  readonly entryAt: number;
}

export interface Receipt {
  readonly ticket: Ticket;
  readonly exitAt: number;
  readonly durationMs: number;
  readonly feeMinor: number;
}

export interface Availability {
  readonly level: number;
  readonly size: SpotSize;
  readonly free: number;
  readonly total: number;
}

export interface ParkingLotOptions {
  layout: LotLayout;
  pricing: PricingStrategy;
  allocation?: AllocationStrategy; // default smallestFitFirst
  clock?: Clock; // default systemClock
}

const PLATE_RE = /^[A-Z0-9]{1,12}$/;

// "mh 12-ab 1234" and "MH12AB1234" are the same car. Without this, one car could hold two tickets.
export function normalizePlate(raw: string): string {
  const plate = typeof raw === "string" ? raw.toUpperCase().replace(/[\s-]/g, "") : "";
  if (!PLATE_RE.test(plate)) {
    throw new ParkingError("INVALID_PLATE", "plate must be 1-12 letters or digits (spaces and '-' are ignored)");
  }
  return plate;
}

// The lot. Every public method checks everything that can fail BEFORE it changes any state, so a thrown
// ParkingError always means "nothing happened" (tested for each error).
export class ParkingLot {
  private readonly spots: ParkingSpot[] = []; // nearest first: level, then position
  private readonly spotsById = new Map<string, ParkingSpot>();
  private readonly tickets = new Map<string, Ticket>(); // active tickets only
  private readonly ticketIdByPlate = new Map<string, string>();
  private readonly pricing: PricingStrategy;
  private readonly allocation: AllocationStrategy;
  private readonly clock: Clock;

  constructor(options: ParkingLotOptions) {
    const { layout } = options;
    if (!Array.isArray(layout) || layout.length === 0) {
      throw new ParkingError("INVALID_LAYOUT", "a lot needs at least one level");
    }
    layout.forEach((level, levelNo) => {
      if (!Array.isArray(level) || level.length === 0) {
        throw new ParkingError("INVALID_LAYOUT", `level ${levelNo} has no spots`);
      }
      level.forEach((size, position) => {
        if (!isSpotSize(size)) {
          throw new ParkingError("INVALID_LAYOUT", `level ${levelNo} spot ${position + 1}: unknown size ${String(size)}`);
        }
        const spot = new ParkingSpot(`L${levelNo}-${position + 1}`, levelNo, position, size);
        this.spots.push(spot);
        this.spotsById.set(spot.id, spot);
      });
    });
    this.pricing = options.pricing;
    this.allocation = options.allocation ?? smallestFitFirst;
    this.clock = options.clock ?? systemClock;
  }

  park(rawPlate: string, vehicle: VehicleType): Ticket {
    const plate = normalizePlate(rawPlate);
    if (!isVehicleType(vehicle)) {
      throw new ParkingError("INVALID_VEHICLE", `unknown vehicle type ${String(vehicle)}`);
    }
    if (this.ticketIdByPlate.has(plate)) {
      throw new ParkingError("ALREADY_PARKED", `${plate} is already parked`);
    }

    // O(number of spots) per park. Fine for a few hundred spots; an index per size is a later stage (PLAN.md).
    const candidates = this.spots.filter((s) => s.isFree && fits(vehicle, s.size));
    if (candidates.length === 0) {
      throw new ParkingError("LOT_FULL", `no free spot for a ${vehicle}`);
    }
    const spot = this.allocation.choose(vehicle, candidates);
    if (spot === undefined || !candidates.includes(spot)) {
      throw new ParkingError("STRATEGY_BUG", `allocation strategy ${this.allocation.name} returned a spot that is not a free fitting one`);
    }

    // All checks passed; from here on nothing can fail.
    const ticket: Ticket = Object.freeze({
      id: randomUUID(), // unguessable: a ticket id is what lets a car out
      plate,
      vehicle,
      spotId: spot.id,
      level: spot.level,
      entryAt: this.clock.now(),
    });
    spot.occupy(ticket.id);
    this.tickets.set(ticket.id, ticket);
    this.ticketIdByPlate.set(plate, ticket.id);
    return ticket;
  }

  // What exit() would charge right now. Changes nothing.
  quote(ticketId: string): number {
    const ticket = this.activeTicket(ticketId);
    return this.checkedFee(ticket, this.clock.now());
  }

  exit(ticketId: string): Receipt {
    const ticket = this.activeTicket(ticketId);
    const exitAt = this.clock.now();
    const feeMinor = this.checkedFee(ticket, exitAt); // may throw INVALID_TIME: nothing changed yet
    const spot = this.spotsById.get(ticket.spotId);
    if (spot === undefined || spot.heldBy !== ticket.id) {
      // Unreachable unless the lot's own bookkeeping is broken; checked so the ticket is not lost half-way.
      throw new ParkingError("SPOT_STATE", `ticket ${ticket.id} does not hold spot ${ticket.spotId}`);
    }

    spot.release(ticket.id);
    this.tickets.delete(ticket.id);
    this.ticketIdByPlate.delete(ticket.plate);
    return Object.freeze({ ticket, exitAt, durationMs: exitAt - ticket.entryAt, feeMinor });
  }

  findByPlate(rawPlate: string): Ticket | undefined {
    const id = this.ticketIdByPlate.get(normalizePlate(rawPlate));
    return id === undefined ? undefined : this.tickets.get(id);
  }

  get activeTickets(): readonly Ticket[] {
    return [...this.tickets.values()];
  }

  // For a display board: one row per (level, size) that exists, level 0 first, small to large.
  availability(): Availability[] {
    const rows: Availability[] = [];
    const levels = new Set(this.spots.map((s) => s.level));
    for (const level of levels) {
      for (const size of SPOT_SIZES) {
        const here = this.spots.filter((s) => s.level === level && s.size === size);
        if (here.length === 0) continue;
        rows.push({ level, size, free: here.filter((s) => s.isFree).length, total: here.length });
      }
    }
    return rows;
  }

  // Read-only view of every spot, for tests and debugging.
  snapshot(): { id: string; level: number; size: SpotSize; heldBy: string | null }[] {
    return this.spots.map((s) => ({ id: s.id, level: s.level, size: s.size, heldBy: s.heldBy }));
  }

  private activeTicket(ticketId: string): Ticket {
    const ticket = this.tickets.get(ticketId);
    if (ticket === undefined) {
      throw new ParkingError("TICKET_NOT_ACTIVE", "unknown ticket, or it was already used to exit");
    }
    return ticket;
  }

  private checkedFee(ticket: Ticket, exitAt: number): number {
    const fee = this.pricing.fee(ticket.vehicle, ticket.entryAt, exitAt);
    if (!Number.isSafeInteger(fee) || fee < 0) {
      throw new ParkingError("STRATEGY_BUG", `pricing strategy ${this.pricing.name} returned ${fee}, not a non-negative integer`);
    }
    return fee;
  }
}
