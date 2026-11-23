import { ParkingError } from "./errors.js";
import type { ExitQuote, ParkingLot, Receipt, Ticket } from "./parking-lot.js";
import { chargeWithRetry, type PaymentGateway, type RetryOptions } from "./payment.js";
import { withTimeout } from "./timeout.js";
import type { VehicleType } from "./types.js";

// The hardware at a gate. Both calls are async (a printer, a barrier motor) and may fail or hang. The signal is
// aborted when the gate gives up (timeout); a real device driver must stop, e.g. not open the barrier, when it is.
export interface EntryDevice {
  issue(ticket: Ticket, signal: AbortSignal): Promise<void>; // print the ticket, open the barrier
}

export interface ExitDevice {
  open(quote: ExitQuote, signal: AbortSignal): Promise<void>; // show the receipt, open the barrier
}

export interface GateOptions {
  timeoutMs?: number; // device timeout, default 10 s
}

export interface ExitGateOptions extends GateOptions {
  gateway?: PaymentGateway; // card reader at the gate; without one, only paid (or free) tickets can leave
  payment?: RetryOptions;
}

const DEFAULT_TIMEOUT_MS = 10_000;

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

// Exit: lock the ticket and fix the bill, charge what is due (same idempotency key on every retry), open the
// barrier, commit. A copy of the same ticket at another exit gets TICKET_BUSY. On any failure the exit is aborted
// and the car is still inside; a payment that already went through stays recorded, so the next try owes nothing.
export class ExitGate {
  private readonly timeoutMs: number;

  constructor(
    private readonly lot: ParkingLot,
    private readonly device: ExitDevice,
    private readonly options: ExitGateOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async leave(ticketId: string): Promise<Receipt> {
    const quote = this.lot.beginExit(ticketId);
    try {
      if (quote.dueMinor > 0) {
        if (this.options.gateway === undefined) {
          throw new ParkingError("PAYMENT_REQUIRED", `${quote.dueMinor} due; pay at a pay station first`);
        }
        const paymentId = await chargeWithRetry(
          this.options.gateway,
          { idempotencyKey: quote.paymentKey, amountMinor: quote.dueMinor, reference: quote.ticket.id },
          this.options.payment,
        );
        this.lot.recordPayment(ticketId, paymentId);
      }
      await withTimeout((signal) => this.device.open(quote, signal), this.timeoutMs);
    } catch (cause) {
      this.lot.abortExit(ticketId);
      if (cause instanceof ParkingError) throw cause; // PAYMENT_REQUIRED / _DECLINED / _UNKNOWN
      throw new ParkingError("DEVICE_FAILED", "exit device failed; the ticket is still valid", { cause });
    }
    return this.lot.commitExit(ticketId);
  }
}
