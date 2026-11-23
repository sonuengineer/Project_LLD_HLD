import { BrokenCircuitError, BulkheadRejectedError } from "./errors.js";

// Helpers for the most common use: calling an HTTP API with fetch.

// HTTP Retry-After is either delay-seconds ("120") or an HTTP-date ("Wed, 21 Oct 2026 07:28:00 GMT").
// Returns milliseconds from `nowMs`, or undefined if the header is missing or not understood. A date in the past
// means "now" (0).
export function parseRetryAfter(header: string | null | undefined, nowMs: number = Date.now()): number | undefined {
  if (header === null || header === undefined) return undefined;
  const value = header.trim();
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  if (!/[a-z]/i.test(value)) return undefined; // "-5", "1.5", "": not a valid header
  const at = Date.parse(value);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - nowMs);
}

// A non-2xx answer FROM A DEPENDENCY, as an error the retry policy can decide on.
//
// The field is `upstreamStatus`, deliberately NOT `status` / `statusCode`: Express's default error handler (and
// many others) send `err.status` to YOUR client. With `status`, a dependency's 401 would tell your client that THEY
// are unauthorized, and its 404 that YOUR route does not exist (found by test/express.test.ts).
export class HttpError extends Error {
  override name = "HttpError";

  constructor(
    readonly upstreamStatus: number,
    readonly retryAfterMs: number | undefined,
  ) {
    super(`upstream answered HTTP ${upstreamStatus}`);
  }
}

// Worth retrying: no answer at all (network error, timeout), 408, 429 and 5xx except 501. NOT 4xx in general: the
// same request will fail the same way. NOT a circuit-breaker or bulkhead rejection either: failing fast is their
// whole point, and an immediate retry would only hit the same open breaker / full bulkhead.
export function isRetryableHttp(error: unknown): boolean {
  if (error instanceof BrokenCircuitError || error instanceof BulkheadRejectedError) return false;
  if (!(error instanceof HttpError)) return true;
  const s = error.upstreamStatus;
  return s === 408 || s === 429 || (s >= 500 && s !== 501);
}
