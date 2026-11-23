import { ParkingError } from "./errors.js";
import { sleep, withTimeout } from "./timeout.js";

// The payment provider, as the lot sees it. No real provider is integrated in this project: the only
// implementation is FakePaymentGateway (fake-gateway.ts). No real money, no real credentials.
export interface PaymentRequest {
  // Same key = same payment. A provider that sees a key again returns the first result instead of charging again.
  // This is what makes a retry after a lost response safe.
  readonly idempotencyKey: string;
  readonly amountMinor: number;
  readonly reference: string; // the ticket id
}

export interface PaymentGateway {
  // Resolves with the provider's payment id, or rejects. PaymentDeclinedError = a definite "no" (do not retry);
  // any other error = outcome unknown (the charge may or may not have happened).
  charge(request: PaymentRequest, signal: AbortSignal): Promise<{ paymentId: string }>;
}

export class PaymentDeclinedError extends Error {
  override name = "PaymentDeclinedError";
}

export interface RetryOptions {
  attempts?: number; // default 3
  timeoutMs?: number; // per attempt, default 10 s
  retryDelayMs?: number; // between attempts, default 200 ms
}

// Charge, retrying with the SAME idempotency key on any error except a decline.
// Declined -> PAYMENT_DECLINED. Still failing after the last attempt -> PAYMENT_UNKNOWN: the money may have been
// taken; finding out needs the provider's records (reconciliation, NOT built here).
export async function chargeWithRetry(gateway: PaymentGateway, request: PaymentRequest, options: RetryOptions = {}): Promise<string> {
  const attempts = options.attempts ?? 3;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const retryDelayMs = options.retryDelayMs ?? 200;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (attempt > 1 && retryDelayMs > 0) await sleep(retryDelayMs);
    try {
      const result = await withTimeout((signal) => gateway.charge(request, signal), timeoutMs);
      if (typeof result?.paymentId !== "string" || result.paymentId === "") {
        throw new Error("gateway answered without a payment id");
      }
      return result.paymentId;
    } catch (error) {
      if (error instanceof PaymentDeclinedError) {
        throw new ParkingError("PAYMENT_DECLINED", "the payment was declined", { cause: error });
      }
      lastError = error;
    }
  }
  throw new ParkingError("PAYMENT_UNKNOWN", `payment failed ${attempts} times; outcome unknown`, { cause: lastError });
}
