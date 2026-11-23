import type { ParkingLot, Payment } from "./parking-lot.js";
import { chargeWithRetry, type PaymentGateway, type RetryOptions } from "./payment.js";

// A pay machine in the lobby: pay first, then walk to the car and leave within the exit window for free.
// Same shape as the gates: lock (beginPayment) -> slow part (charge) -> record, or abort on failure.
export class PayStation {
  constructor(
    private readonly lot: ParkingLot,
    private readonly gateway: PaymentGateway,
    private readonly options: RetryOptions = {},
  ) {}

  async pay(ticketId: string): Promise<Payment> {
    const quote = this.lot.beginPayment(ticketId); // NOTHING_DUE, TICKET_BUSY ... reject before any charge
    let paymentId: string;
    try {
      paymentId = await chargeWithRetry(
        this.gateway,
        { idempotencyKey: quote.paymentKey, amountMinor: quote.dueMinor, reference: quote.ticket.id },
        this.options,
      );
    } catch (error) {
      this.lot.abortPayment(ticketId);
      throw error; // PAYMENT_DECLINED or PAYMENT_UNKNOWN
    }
    return this.lot.recordPayment(ticketId, paymentId);
  }
}
