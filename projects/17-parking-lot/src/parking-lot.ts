import { randomUUID } from "node:crypto";
import { fittingSizes, smallestFitFirst, type AllocationStrategy } from "./allocation.js";
import { systemClock, type Clock } from "./clock.js";
import { ParkingError } from "./errors.js";
import { EventQueue, type Listener } from "./events.js";
import { FreeSpotIndex } from "./free-index.js";
import type { PricingStrategy } from "./pricing.js";
import { ParkingSpot, type SpotState } from "./spot.js";
import { SPOT_SIZES, fits, isSpotSize, isVehicleType, type SpotSize, type VehicleType } from "./types.js";

// layout[level][position] = size of that spot. Level 0 is the one nearest the entrance.
export type LotLayout = readonly (readonly SpotSize[])[];

export interface Ticket {
  readonly id: string;
  readonly plate: string; // normalised (see normalizePlate)
  readonly vehicle: VehicleType;
  readonly spotId: string;
  readonly level: number;
  readonly entryAt: number; // time of reserve(): what the printed ticket shows
}

// "reserved": a gate claimed the spot, the car is not through the barrier yet. "active": parked.
// "exiting": an exit gate locked the ticket and fixed the fee, the barrier is not open yet.
export type TicketStatus = "reserved" | "active" | "exiting";

export interface ExitQuote {
  readonly ticket: Ticket;
  readonly exitAt: number;
  readonly feeMinor: number;
}

export interface Receipt extends ExitQuote {
  readonly durationMs: number;
}

export interface Availability {
  readonly level: number;
  readonly size: SpotSize;
  readonly free: number;
  readonly total: number;
}

// Observer event: one (level, size) row of the board after a change. Emitted when a spot is reserved, a
// reservation is cancelled, or a car leaves. Confirming a reservation changes no count, so it emits nothing.
export type AvailabilityChanged = Availability;

export interface ParkingLotOptions {
  layout: LotLayout;
  pricing: PricingStrategy;
  allocation?: AllocationStrategy; // default smallestFitFirst
  clock?: Clock; // default systemClock
  onListenerError?: (error: unknown, event: AvailabilityChanged) => void; // default console.error
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

interface Entry {
  readonly ticket: Ticket;
  status: TicketStatus;
  exit?: { exitAt: number; feeMinor: number };
}

interface Row {
  readonly level: number;
  readonly size: SpotSize;
  free: number;
  readonly total: number;
}

const rowKey = (level: number, size: SpotSize) => `${level}:${size}`;

// The lot. Every public method is synchronous and checks everything that can fail BEFORE it changes any state, so
// (1) a thrown ParkingError always means "nothing happened", and (2) no other code can run between a check and the
// change it guards: JavaScript runs one synchronous block at a time. Gates (gates.ts) do their async device work
// BETWEEN two such calls (reserve ... confirm/cancel), holding a claim, never between a check and its change.
export class ParkingLot {
  private readonly spots: ParkingSpot[] = []; // nearest first: level, then position
  private readonly spotsById = new Map<string, ParkingSpot>();
  private readonly index: FreeSpotIndex;
  private readonly entries = new Map<string, Entry>(); // reserved, active and exiting tickets
  private readonly ticketIdByPlate = new Map<string, string>();
  private readonly rows = new Map<string, Row>(); // insertion order = board order
  private readonly events: EventQueue<AvailabilityChanged>;
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
      for (const size of SPOT_SIZES) {
        const total = level.filter((s) => s === size).length;
        if (total > 0) this.rows.set(rowKey(levelNo, size), { level: levelNo, size, free: total, total });
      }
    });
    this.index = new FreeSpotIndex(this.spots);
    this.pricing = options.pricing;
    this.allocation = options.allocation ?? smallestFitFirst;
    this.clock = options.clock ?? systemClock;
    const onError = options.onListenerError ?? ((e: unknown) => console.error("parking lot listener failed:", e));
    this.events = new EventQueue(onError);
  }

  // ---- entry: reserve, then confirm (car is in) or cancel (gate failed) ----

  reserve(rawPlate: string, vehicle: VehicleType): Ticket {
    const plate = normalizePlate(rawPlate);
    if (!isVehicleType(vehicle)) {
      throw new ParkingError("INVALID_VEHICLE", `unknown vehicle type ${String(vehicle)}`);
    }
    if (this.ticketIdByPlate.has(plate)) {
      throw new ParkingError("ALREADY_PARKED", `${plate} is already inside or entering`);
    }
    if (!fittingSizes(vehicle).some((size) => this.index.nearest(size) !== undefined)) {
      throw new ParkingError("LOT_FULL", `no free spot for a ${vehicle}`);
    }
    const spot = this.allocation.choose(vehicle, this.index);
    if (spot === undefined || this.spotsById.get(spot.id) !== spot || !spot.isFree || !fits(vehicle, spot.size)) {
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
    spot.reserve(ticket.id);
    this.entries.set(ticket.id, { ticket, status: "reserved" });
    this.ticketIdByPlate.set(plate, ticket.id);
    this.changeFree(spot, -1); // last: listeners see the finished change
    return ticket;
  }

  confirm(ticketId: string): Ticket {
    const entry = this.reservation(ticketId);
    this.spotOf(entry).confirm(ticketId);
    entry.status = "active";
    return entry.ticket;
  }

  cancel(ticketId: string): void {
    const entry = this.reservation(ticketId);
    const spot = this.spotOf(entry);
    this.forget(entry, spot);
  }

  // Synchronous one-step entry (no device): reserve + confirm.
  park(rawPlate: string, vehicle: VehicleType): Ticket {
    return this.confirm(this.reserve(rawPlate, vehicle).id);
  }

  // ---- exit: beginExit (locks the ticket, fixes the fee), then commitExit or abortExit ----

  // What exit would charge right now (or the fixed fee, while an exit is in progress). Changes nothing.
  quote(ticketId: string): number {
    const entry = this.parked(ticketId);
    if (entry.exit !== undefined) return entry.exit.feeMinor;
    return this.checkedFee(entry.ticket, this.clock.now());
  }

  beginExit(ticketId: string): ExitQuote {
    const entry = this.parked(ticketId);
    if (entry.status === "exiting") {
      throw new ParkingError("TICKET_BUSY", "an exit with this ticket is already in progress");
    }
    const exitAt = this.clock.now();
    const feeMinor = this.checkedFee(entry.ticket, exitAt); // may throw INVALID_TIME: nothing changed yet
    this.spotOf(entry); // bookkeeping check before the state change
    entry.status = "exiting";
    entry.exit = { exitAt, feeMinor };
    return Object.freeze({ ticket: entry.ticket, exitAt, feeMinor });
  }

  commitExit(ticketId: string): Receipt {
    const entry = this.exiting(ticketId);
    const spot = this.spotOf(entry);
    const { exitAt, feeMinor } = entry.exit!;
    this.forget(entry, spot);
    return Object.freeze({ ticket: entry.ticket, exitAt, feeMinor, durationMs: exitAt - entry.ticket.entryAt });
  }

  abortExit(ticketId: string): void {
    const entry = this.exiting(ticketId);
    entry.status = "active";
    delete entry.exit;
  }

  // Synchronous one-step exit (no device): beginExit + commitExit.
  exit(ticketId: string): Receipt {
    this.beginExit(ticketId);
    return this.commitExit(ticketId);
  }

  // ---- lookups ----

  statusOf(ticketId: string): TicketStatus | undefined {
    return this.entries.get(ticketId)?.status;
  }

  // Parked cars only (active or exiting), not reservations.
  findByPlate(rawPlate: string): Ticket | undefined {
    const id = this.ticketIdByPlate.get(normalizePlate(rawPlate));
    const entry = id === undefined ? undefined : this.entries.get(id);
    return entry !== undefined && entry.status !== "reserved" ? entry.ticket : undefined;
  }

  get activeTickets(): readonly Ticket[] {
    return [...this.entries.values()].filter((e) => e.status !== "reserved").map((e) => e.ticket);
  }

  // For a display board: one row per (level, size) that exists, level 0 first, small to large. O(rows).
  availability(): Availability[] {
    return [...this.rows.values()].map((r) => ({ ...r }));
  }

  subscribe(listener: Listener<AvailabilityChanged>): () => void {
    return this.events.subscribe(listener);
  }

  // Read-only view of every spot, for tests and debugging.
  snapshot(): { id: string; level: number; size: SpotSize; state: SpotState; heldBy: string | null }[] {
    return this.spots.map((s) => ({ id: s.id, level: s.level, size: s.size, state: s.state, heldBy: s.heldBy }));
  }

  // ---- internals ----

  private forget(entry: Entry, spot: ParkingSpot): void {
    spot.release(entry.ticket.id);
    this.index.released(spot);
    this.entries.delete(entry.ticket.id);
    this.ticketIdByPlate.delete(entry.ticket.plate);
    this.changeFree(spot, +1); // last
  }

  private changeFree(spot: ParkingSpot, delta: number): void {
    const row = this.rows.get(rowKey(spot.level, spot.size))!;
    row.free += delta;
    this.events.emit(Object.freeze({ ...row }));
  }

  private reservation(ticketId: string): Entry {
    const entry = this.entries.get(ticketId);
    if (entry === undefined || entry.status !== "reserved") {
      throw new ParkingError("RESERVATION_NOT_FOUND", "no pending reservation with this id");
    }
    return entry;
  }

  private parked(ticketId: string): Entry {
    const entry = this.entries.get(ticketId);
    if (entry === undefined || entry.status === "reserved") {
      throw new ParkingError("TICKET_NOT_ACTIVE", "unknown ticket, already used to exit, or the car is not in yet");
    }
    return entry;
  }

  private exiting(ticketId: string): Entry {
    const entry = this.parked(ticketId);
    if (entry.status !== "exiting") {
      throw new ParkingError("EXIT_NOT_STARTED", "beginExit was not called for this ticket");
    }
    return entry;
  }

  private spotOf(entry: Entry): ParkingSpot {
    const spot = this.spotsById.get(entry.ticket.spotId);
    if (spot === undefined || spot.heldBy !== entry.ticket.id) {
      // Unreachable unless the lot's own bookkeeping is broken; checked so a ticket is not lost half-way.
      throw new ParkingError("SPOT_STATE", `ticket ${entry.ticket.id} does not hold spot ${entry.ticket.spotId}`);
    }
    return spot;
  }

  private checkedFee(ticket: Ticket, exitAt: number): number {
    const fee = this.pricing.fee(ticket.vehicle, ticket.entryAt, exitAt);
    if (!Number.isSafeInteger(fee) || fee < 0) {
      throw new ParkingError("STRATEGY_BUG", `pricing strategy ${this.pricing.name} returned ${fee}, not a non-negative integer`);
    }
    return fee;
  }
}
