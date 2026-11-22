import { ParkingError } from "./errors.js";
import type { ExitQuote, ParkingLot, Receipt, Ticket } from "./parking-lot.js";
import type { VehicleType } from "./types.js";

// The hardware at a gate. Both calls are async (a printer, a barrier motor) and may fail or hang. The signal is
// aborted when the gate gives up (timeout); a real device driver must stop, e.g. not open the barrier, when it is.
export interface EntryDevice {
  issue(ticket: Ticket, signal: AbortSignal): Promise<void>; // print the ticket, open the barrier
}

export interface ExitDevice {
  open(quote: ExitQuote, signal: AbortSignal): Promise<void>; // show the fee, open the barrier
}

export interface GateOptions {
  timeoutMs?: number; // default 10 s
}

const DEFAULT_TIMEOUT_MS = 10_000;

async function withTimeout(work: (signal: AbortSignal) => Promise<void>, timeoutMs: number): Promise<void> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`device did not answer within ${timeoutMs} ms`));
    }, timeoutMs);
  });
  try {
    // async wrapper: a device that throws synchronously becomes a rejection like any other failure.
    await Promise.race([(async () => work(controller.signal))(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// Entry: claim first (synchronous, atomic), then the slow device, then confirm. If the device fails or hangs, the
// claim is cancelled and the spot is free again. A second gate never sees the claimed spot as free, so it never
// prints a ticket for it.
export class EntryGate {
  private readonly timeoutMs: number;

  constructor(
    private readonly lot: ParkingLot,
    private readonly device: EntryDevice,
    options: GateOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async enter(plate: string, vehicle: VehicleType): Promise<Ticket> {
    const ticket = this.lot.reserve(plate, vehicle); // LOT_FULL etc. reject here, before the device is touched
    try {
      await withTimeout((signal) => this.device.issue(ticket, signal), this.timeoutMs);
    } catch (cause) {
      this.lot.cancel(ticket.id);
      throw new ParkingError("DEVICE_FAILED", "entry device failed; the reservation was cancelled", { cause });
    }
    return this.lot.confirm(ticket.id);
  }
}

// Exit: lock the ticket and fix the fee first, then the barrier, then commit. A copy of the same ticket at another
// exit gets TICKET_BUSY instead of a second open barrier. If the barrier fails, the exit is aborted and the ticket
// is valid again (the car is still inside).
export class ExitGate {
  private readonly timeoutMs: number;

  constructor(
    private readonly lot: ParkingLot,
    private readonly device: ExitDevice,
    options: GateOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async leave(ticketId: string): Promise<Receipt> {
    const quote = this.lot.beginExit(ticketId);
    try {
      await withTimeout((signal) => this.device.open(quote, signal), this.timeoutMs);
    } catch (cause) {
      this.lot.abortExit(ticketId);
      throw new ParkingError("DEVICE_FAILED", "exit device failed; the ticket is still valid", { cause });
    }
    return this.lot.commitExit(ticketId);
  }
}
