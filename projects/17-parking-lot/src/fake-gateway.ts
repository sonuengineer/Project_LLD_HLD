import { randomUUID } from "node:crypto";
import { PaymentDeclinedError, type PaymentGateway, type PaymentRequest } from "./payment.js";

// What the next NEW charge does (an idempotent replay of an earlier successful key ignores the script):
//   approve        charge, answer with the payment id
//   decline        no charge, PaymentDeclinedError
//   fail           no charge, a plain error (looks like "outcome unknown" to the caller)
//   lose-response  CHARGE, then a plain error: the money is taken but the caller does not know
//   hang           no answer until the caller aborts; no charge
export type FakeOutcome = "approve" | "decline" | "fail" | "lose-response" | "hang";

export interface FakeCharge {
  readonly paymentId: string;
  readonly idempotencyKey: string;
  readonly amountMinor: number;
  readonly reference: string;
}

// An in-memory stand-in for a payment provider, for tests and the demo. Moves no money.
export class FakePaymentGateway implements PaymentGateway {
  private readonly byKey = new Map<string, FakeCharge>();
  private readonly script: FakeOutcome[];
  calls = 0;

  constructor(script: FakeOutcome[] = []) {
    this.script = [...script];
  }

  enqueue(...outcomes: FakeOutcome[]): void {
    this.script.push(...outcomes);
  }

  get charges(): readonly FakeCharge[] {
    return [...this.byKey.values()];
  }

  totalChargedMinor(): number {
    return this.charges.reduce((n, c) => n + c.amountMinor, 0);
  }

  async charge(request: PaymentRequest, signal: AbortSignal): Promise<{ paymentId: string }> {
    this.calls++;
    if (!Number.isSafeInteger(request.amountMinor) || request.amountMinor <= 0) {
      throw new Error(`invalid amount ${request.amountMinor}`);
    }
    const earlier = this.byKey.get(request.idempotencyKey);
    if (earlier !== undefined) {
      // Real providers refuse a reused key with different parameters instead of guessing.
      if (earlier.amountMinor !== request.amountMinor || earlier.reference !== request.reference) {
        throw new Error("idempotency key reused with a different request");
      }
      return { paymentId: earlier.paymentId };
    }
    const outcome = this.script.shift() ?? "approve";
    switch (outcome) {
      case "approve":
        return { paymentId: this.record(request).paymentId };
      case "decline":
        throw new PaymentDeclinedError("card declined");
      case "fail":
        throw new Error("gateway unavailable");
      case "lose-response":
        this.record(request);
        throw new Error("connection reset after the charge");
      case "hang":
        return new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted by caller")), { once: true });
        });
    }
  }

  private record(request: PaymentRequest): FakeCharge {
    const charge: FakeCharge = Object.freeze({
      paymentId: `fake_${randomUUID()}`,
      idempotencyKey: request.idempotencyKey,
      amountMinor: request.amountMinor,
      reference: request.reference,
    });
    this.byKey.set(request.idempotencyKey, charge);
    return charge;
  }
}
