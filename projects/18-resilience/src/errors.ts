// Thrown by TimeoutPolicy, and also used as the AbortSignal's reason, so the operation can tell "my caller gave
// up because of time" from any other abort.
export class TimeoutError extends Error {
  override name = "TimeoutError";

  constructor(readonly timeoutMs: number) {
    super(`operation timed out after ${timeoutMs} ms`);
  }
}

// Thrown by CircuitBreaker without calling the operation: the dependency is considered down (open), or the
// half-open probe slots are taken. retryAfterMs = time until the breaker will let a probe through (0 when
// half-open).
export class BrokenCircuitError extends Error {
  override name = "BrokenCircuitError";

  constructor(
    readonly state: "open" | "half-open",
    readonly retryAfterMs: number,
  ) {
    super(state === "open" ? `circuit open; next probe in ${retryAfterMs} ms` : "circuit half-open; probe slots taken");
  }
}

// Thrown by Bulkhead without calling the operation: all slots busy and the queue is full.
export class BulkheadRejectedError extends Error {
  override name = "BulkheadRejectedError";

  constructor(
    readonly maxConcurrent: number,
    readonly maxQueue: number,
  ) {
    super(`bulkhead full: ${maxConcurrent} running, ${maxQueue} queued`);
  }
}
