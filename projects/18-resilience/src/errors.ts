// Thrown by TimeoutPolicy, and also used as the AbortSignal's reason, so the operation can tell "my caller gave
// up because of time" from any other abort.
export class TimeoutError extends Error {
  override name = "TimeoutError";

  constructor(readonly timeoutMs: number) {
    super(`operation timed out after ${timeoutMs} ms`);
  }
}
