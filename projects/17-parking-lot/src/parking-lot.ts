import { randomUUID } from "node:crypto";
import { fittingSizes, smallestFitFirst, type AllocationStrategy } from "./allocation.js";
import { systemClock, type Clock } from "./clock.js";
import { ParkingError } from "./errors.js";
import { EventQueue, type Listener } from "./events.js";
import { FreeSpotIndex } from "./free-index.js";
import { MINUTE_MS, type PricingStrategy } from "./pricing.js";
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
  readonly replaces?: string; // set on a replacement for a lost ticket
}

// "reserved": a gate claimed the spot, the car is not through the barrier yet. "active": parked.
// "paying": a pay station locked the ticket and fixed the amount. "exiting": an exit gate locked it.
export type TicketStatus = "reserved" | "active" | "paying" | "exiting";

export interface Payment {
  readonly paymentId: string; // the provider's id ("cash-..." for the attendant booth)
  readonly amountMinor: number;
  readonly at: number; // when the amount was fixed; the exit window counts from here
}

// What is owed at a moment: total fee so far (incl. a lost-ticket penalty), already paid, still due.
export interface Bill {
  readonly feeMinor: number;
  readonly paidMinor: number;
  readonly dueMinor: number;
}

export interface PaymentQuote extends Bill {
  readonly ticket: Ticket;
  readonly at: number;
  readonly paymentKey: string; // idempotency key for this payment attempt (retries reuse it)
}

export interface ExitQuote extends Bill {
  readonly ticket: Ticket;
  readonly exitAt: number;
  readonly paymentKey: string;
}

export interface Receipt {
  readonly ticket: Ticket;
  readonly exitAt: number;
  readonly durationMs: number;
  readonly feeMinor: number;
  readonly paidMinor: number; // always == feeMinor: commitExit refuses while anything is due
  readonly payments: readonly Payment[];
}

export interface Availability {
  readonly level: number;
  readonly size: SpotSize;
  readonly free: number;
  readonly total: number;
}

// Observer event: one (level, size) row of the board after a change. Emitted when a spot is reserved, a
// reservation is cancelled, or a car leaves. Nothing else changes a count, so nothing else emits.
export type AvailabilityChanged = Availability;

export interface ParkingLotOptions {
  layout: LotLayout;
  pricing: PricingStrategy;
  allocation?: AllocationStrategy; // default smallestFitFirst
  clock?: Clock; // default systemClock
  onListenerError?: (error: unknown, event: AvailabilityChanged) => void; // default console.error
  exitWindowMinutes?: number; // after paying, leave within this many minutes at no extra cost; default 15
  lostTicketPenaltyMinor?: number; // added to the fee when a ticket is reported lost; default 0
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

// A lock taken by beginPayment or beginExit: the moment and the amounts are fixed while the slow part runs.
interface Lock {
  readonly kind: "paying" | "exiting";
  readonly at: number;
  readonly feeMinor: number;
  readonly paidMinor: number;
  dueMinor: number; // set to 0 once the payment for it is recorded
  readonly paymentKey: string;
}

interface Entry {
  readonly ticket: Ticket;
  status: TicketStatus;
  lock?: Lock;
  readonly payments: Payment[];
  readonly penaltyMinor: number;
}

interface Row {
  readonly level: number;
  readonly size: SpotSize;
  free: number;
  readonly total: number;
}

const rowKey = (level: number, size: SpotSize) => `${level}:${size}`;

function nonNegativeInt(value: number | undefined, fallback: number, name: string): number {
  const v = value ?? fallback;
  if (!Number.isSafeInteger(v) || v < 0) throw new ParkingError("INVALID_OPTION", `${name} must be a non-negative integer`);
  return v;
}

// The lot. Every public method is synchronous and checks everything that can fail BEFORE it changes any state, so
// (1) a thrown ParkingError always means "nothing happened", and (2) no other code can run between a check and the
// change it guards: JavaScript runs one synchronous block at a time. Gates and pay stations do their async work
// (devices, payment provider) BETWEEN two such calls while holding a claim or lock, never between a check and its
// change.
export class ParkingLot {
  private readonly spots: ParkingSpot[] = []; // nearest first: level, then position
  private readonly spotsById = new Map<string, ParkingSpot>();
  private readonly index: FreeSpotIndex;
  private readonly entries = new Map<string, Entry>(); // reserved, active, paying and exiting tickets
  private readonly ticketIdByPlate = new Map<string, string>();
  private readonly replaced = new Set<string>(); // ids of tickets reported lost
  private readonly rows = new Map<string, Row>(); // insertion order = board order
  private readonly events: EventQueue<AvailabilityChanged>;
  private readonly pricing: PricingStrategy;
  private readonly allocation: AllocationStrategy;
  private readonly clock: Clock;
  private readonly exitWindowMs: number;
  private readonly lostPenaltyMinor: number;

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
    this.exitWindowMs = nonNegativeInt(options.exitWindowMinutes, 15, "exitWindowMinutes") * MINUTE_MS;
    this.lostPenaltyMinor = nonNegativeInt(options.lostTicketPenaltyMinor, 0, "lostTicketPenaltyMinor");
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
    this.entries.set(ticket.id, { ticket, status: "reserved", payments: [], penaltyMinor: 0 });
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

  // ---- money ----

  // What is due right now (or the fixed amount, while a payment or exit is in progress). Changes nothing.
  quote(ticketId: string): number {
    const entry = this.parked(ticketId);
    return entry.lock !== undefined ? entry.lock.dueMinor : this.bill(entry, this.clock.now()).dueMinor;
  }

  // The whole bill right now. Changes nothing.
  billFor(ticketId: string): Bill {
    const entry = this.parked(ticketId);
    if (entry.lock !== undefined) {
      const { feeMinor, paidMinor, dueMinor } = entry.lock;
      return { feeMinor, paidMinor, dueMinor };
    }
    return this.bill(entry, this.clock.now());
  }

  // Pay station: lock the ticket and fix the amount; then charge; then recordPayment (or abortPayment).
  beginPayment(ticketId: string): PaymentQuote {
    const entry = this.unlocked(ticketId);
    const at = this.clock.now();
    const bill = this.bill(entry, at); // may throw INVALID_TIME / STRATEGY_BUG: nothing changed yet
    if (bill.dueMinor === 0) throw new ParkingError("NOTHING_DUE", "nothing to pay");
    const lock = this.lockEntry(entry, "paying", at, bill);
    return Object.freeze({ ticket: entry.ticket, at, ...bill, paymentKey: lock.paymentKey });
  }

  // Record that the locked amount was paid (pay station, or exit gate before commitExit). The amount is the one
  // fixed by the lock, never a caller's number. A pay station's lock ends here; an exit gate's lock stays.
  recordPayment(ticketId: string, paymentId: string): Payment {
    const entry = this.parked(ticketId);
    const lock = entry.lock;
    if (lock === undefined) throw new ParkingError("PAYMENT_NOT_STARTED", "beginPayment or beginExit was not called");
    if (lock.dueMinor === 0) throw new ParkingError("NOTHING_DUE", "the locked amount is already paid");
    if (typeof paymentId !== "string" || paymentId === "" || entry.payments.some((p) => p.paymentId === paymentId)) {
      throw new ParkingError("INVALID_PAYMENT_ID", "payment id is empty or already recorded");
    }
    const payment: Payment = Object.freeze({ paymentId, amountMinor: lock.dueMinor, at: lock.at });
    entry.payments.push(payment);
    if (lock.kind === "paying") {
      entry.status = "active";
      delete entry.lock;
    } else {
      lock.dueMinor = 0;
    }
    return payment;
  }

  abortPayment(ticketId: string): void {
    const entry = this.parked(ticketId);
    if (entry.status !== "paying") throw new ParkingError("PAYMENT_NOT_STARTED", "no payment in progress");
    entry.status = "active";
    delete entry.lock;
  }

  // ---- exit: beginExit (locks, fixes the bill), [recordPayment], then commitExit or abortExit ----

  beginExit(ticketId: string): ExitQuote {
    const entry = this.unlocked(ticketId);
    const exitAt = this.clock.now();
    const bill = this.bill(entry, exitAt); // may throw INVALID_TIME: nothing changed yet
    this.spotOf(entry); // bookkeeping check before the state change
    const lock = this.lockEntry(entry, "exiting", exitAt, bill);
    return Object.freeze({ ticket: entry.ticket, exitAt, ...bill, paymentKey: lock.paymentKey });
  }

  // The barrier rule lives here, not in the gate: no car leaves while money is due.
  commitExit(ticketId: string): Receipt {
    const entry = this.exiting(ticketId);
    const lock = entry.lock!;
    if (lock.dueMinor > 0) throw new ParkingError("PAYMENT_REQUIRED", `${lock.dueMinor} still due`);
    const spot = this.spotOf(entry);
    this.forget(entry, spot);
    const paidMinor = entry.payments.reduce((n, p) => n + p.amountMinor, 0);
    return Object.freeze({
      ticket: entry.ticket,
      exitAt: lock.at,
      durationMs: lock.at - entry.ticket.entryAt,
      feeMinor: lock.feeMinor,
      paidMinor,
      payments: Object.freeze([...entry.payments]),
    });
  }

  // Payments recorded during the exit stay recorded: the next exit within the window owes nothing.
  abortExit(ticketId: string): void {
    const entry = this.exiting(ticketId);
    entry.status = "active";
    delete entry.lock;
  }

  // Attendant booth, synchronous: whatever is due is collected in cash, and the car leaves.
  exit(ticketId: string): Receipt {
    const quote = this.beginExit(ticketId);
    if (quote.dueMinor > 0) this.recordPayment(ticketId, `cash-${randomUUID()}`);
    return this.commitExit(ticketId);
  }

  // ---- lost ticket ----

  // The attendant has checked that the person owns the car (NOT modelled). Issues a replacement ticket for the
  // same stay, adds the penalty, and kills the old ticket id: whoever holds the "lost" ticket can no longer use it.
  reportLost(rawPlate: string): Ticket {
    const id = this.ticketIdByPlate.get(normalizePlate(rawPlate));
    const entry = id === undefined ? undefined : this.entries.get(id);
    if (entry === undefined || entry.status === "reserved") {
      throw new ParkingError("TICKET_NOT_ACTIVE", "no parked car with this plate");
    }
    if (entry.status !== "active") throw new ParkingError("TICKET_BUSY", "a payment or exit is in progress");
    const spot = this.spotOf(entry);
    const old = entry.ticket;
    const ticket: Ticket = Object.freeze({ ...old, id: randomUUID(), replaces: old.id });
    spot.transfer(old.id, ticket.id);
    this.entries.delete(old.id);
    this.entries.set(ticket.id, {
      ticket,
      status: "active",
      payments: entry.payments,
      penaltyMinor: entry.penaltyMinor + this.lostPenaltyMinor,
    });
    this.ticketIdByPlate.set(old.plate, ticket.id);
    this.replaced.add(old.id);
    return ticket;
  }

  // ---- lookups ----

  statusOf(ticketId: string): TicketStatus | undefined {
    return this.entries.get(ticketId)?.status;
  }

  // Parked cars only (not reservations).
  findByPlate(rawPlate: string): Ticket | undefined {
    const id = this.ticketIdByPlate.get(normalizePlate(rawPlate));
    const entry = id === undefined ? undefined : this.entries.get(id);
    return entry !== undefined && entry.status !== "reserved" ? entry.ticket : undefined;
  }

  get activeTickets(): readonly Ticket[] {
    return [...this.entries.values()].filter((e) => e.status !== "reserved").map((e) => e.ticket);
  }

  paymentsFor(ticketId: string): readonly Payment[] {
    return [...this.parked(ticketId).payments];
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

  // Fee for the stay so far, minus what was paid. Within the exit window after the last payment, the stay is
  // priced as of that payment, so a car that paid and walks to its car owes nothing; after the window, only the
  // difference to the longer stay. Pricing never goes down with a longer stay, so the difference is never negative
  // (and is clamped to 0 anyway).
  private bill(entry: Entry, now: number): Bill {
    const paidMinor = entry.payments.reduce((n, p) => n + p.amountMinor, 0);
    const lastPaidAt = entry.payments.at(-1)?.at;
    const priceAt = lastPaidAt !== undefined && now <= lastPaidAt + this.exitWindowMs ? Math.max(lastPaidAt, entry.ticket.entryAt) : now;
    const feeMinor = this.checkedFee(entry.ticket, priceAt) + entry.penaltyMinor;
    return { feeMinor, paidMinor, dueMinor: Math.max(0, feeMinor - paidMinor) };
  }

  private lockEntry(entry: Entry, kind: Lock["kind"], at: number, bill: Bill): Lock {
    const lock: Lock = { kind, at, ...bill, paymentKey: randomUUID() };
    entry.status = kind;
    entry.lock = lock;
    return lock;
  }

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
    if (entry === undefined && this.replaced.has(ticketId)) {
      throw new ParkingError("TICKET_REPLACED", "this ticket was reported lost and replaced");
    }
    if (entry === undefined || entry.status === "reserved") {
      throw new ParkingError("TICKET_NOT_ACTIVE", "unknown ticket, already used to exit, or the car is not in yet");
    }
    return entry;
  }

  private unlocked(ticketId: string): Entry {
    const entry = this.parked(ticketId);
    if (entry.status !== "active") {
      throw new ParkingError("TICKET_BUSY", `a ${entry.status === "paying" ? "payment" : "exit"} with this ticket is already in progress`);
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
