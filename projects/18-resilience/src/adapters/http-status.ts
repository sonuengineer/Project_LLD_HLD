import { BrokenCircuitError, BulkheadRejectedError, TimeoutError } from "../errors.js";

export interface MappedError {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: { readonly error: string; readonly message: string };
}

// How a resilience error should look to YOUR API's client. Shared by the Express and NestJS adapters.
//   BrokenCircuitError    -> 503 + Retry-After (seconds until the breaker lets a probe through, at least 1)
//   BulkheadRejectedError -> 503 (we are at capacity; try again soon)
//   TimeoutError          -> 504 (a dependency did not answer in time)
// Anything else -> undefined: not ours to map, the framework's normal error handling decides.
// The body never contains the dependency's error details (they may hold internal hostnames or tokens).
export function mapResilienceError(error: unknown): MappedError | undefined {
  if (error instanceof BrokenCircuitError) {
    const seconds = Math.max(1, Math.ceil(error.retryAfterMs / 1000));
    return {
      status: 503,
      headers: { "retry-after": String(seconds) },
      body: { error: "dependency_unavailable", message: "A service we depend on is unavailable. Try again later." },
    };
  }
  if (error instanceof BulkheadRejectedError) {
    return {
      status: 503,
      headers: { "retry-after": "1" },
      body: { error: "overloaded", message: "Too many requests in progress. Try again shortly." },
    };
  }
  if (error instanceof TimeoutError) {
    return {
      status: 504,
      headers: {},
      body: { error: "dependency_timeout", message: "A service we depend on did not answer in time." },
    };
  }
  return undefined;
}
