import { exponentialBackoff, type Backoff, type BackoffOptions } from "./backoff.js";
import type { RetryBudget } from "./budget.js";
import { emit, type Observable } from "./events.js";
import { sleep as realSleep } from "./sleep.js";
import type { Operation, Policy } from "./types.js";

export type GiveUpReason = "attempts" | "not-retryable" | "budget" | "deadline" | "retry-after-too-long";

export interface RetryEvent {
  readonly attempt: number; // the attempt that just failed (1 = the first call)
  readonly delayMs: number; // wait before the next attempt
  readonly error: unknown;
}

export interface GiveUpEvent {
  readonly attempts: number;
  readonly reason: GiveUpReason;
  readonly error: unknown;
}

export interface RetryOptions extends Observable {
  maxAttempts?: number; // including the first call; default 3
  backoff?: BackoffOptions | Backoff; // default exponentialBackoff() (100 ms, x2, max 10 s, full jitter)
  // Is this error worth another try? Default: yes for every error. In real use say no to errors that will not
  // change (HTTP 400/401/403/404/422, validation errors): retrying them only adds load.
  shouldRetry?: (error: unknown, attempt: number) => boolean;
  // A delay the server asked for (HTTP Retry-After on 429/503). Used when it is longer than the backoff.
  retryAfterMs?: (error: unknown) => number | undefined;
  // A server asking for longer than this (e.g. "Retry-After: 3600") is not waited for: give up instead. Retrying
  // EARLIER than asked would just get another 429. Default 60 s.
  maxRetryAfterMs?: number;
  budget?: RetryBudget; // shared per dependency; see budget.ts
  deadlineMs?: number; // total time for all attempts and waits; a retry that would start after it is not made
  onRetry?: (event: RetryEvent) => void;
  onGiveUp?: (event: GiveUpEvent) => void;
  // Test hooks. Defaults: Math.random, a cancellable setTimeout sleep, Date.now.
  random?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}

const NEVER = new AbortController().signal;

// Runs an operation again after a failure, with growing, jittered waits.
//
// Never retried, whatever shouldRetry says: a failure after the CALLER aborted (they no longer want the result).
// When it gives up, it rethrows the LAST error unchanged (not a wrapper), so code that already handles, say, an
// HttpError keeps working; the attempt count and reason go to onGiveUp.
export class RetryPolicy implements Policy {
  private readonly maxAttempts: number;
  private readonly backoff: Backoff;

  constructor(private readonly options: RetryOptions = {}) {
    const max = options.maxAttempts ?? 3;
    if (!Number.isSafeInteger(max) || max < 1) throw new RangeError("maxAttempts must be an integer >= 1");
    if (options.deadlineMs !== undefined && (!Number.isFinite(options.deadlineMs) || options.deadlineMs <= 0)) {
      throw new RangeError("deadlineMs must be a positive number");
    }
    this.maxAttempts = max;
    const b = options.backoff;
    this.backoff = b !== undefined && "delayMs" in b ? b : exponentialBackoff(b);
  }

  async execute<T>(operation: Operation<T>, signal?: AbortSignal): Promise<T> {
    const o = this.options;
    const random = o.random ?? Math.random;
    const sleep = o.sleep ?? realSleep;
    const now = o.now ?? Date.now;
    const startedAt = now();

    for (let attempt = 1; ; attempt++) {
      signal?.throwIfAborted();
      try {
        const result = await operation(signal ?? NEVER);
        o.budget?.onSuccess();
        return result;
      } catch (error) {
        if (signal?.aborted) throw signal.reason; // the caller gave up: stop, do not count it against the budget

        const giveUp = (reason: GiveUpReason): never => {
          o.onGiveUp?.({ attempts: attempt, reason, error });
          emit(o.onEvent, { type: "give-up", policy: o.name ?? "retry", attempts: attempt, reason, error });
          throw error;
        };
        // A non-retryable error (e.g. 404) says nothing about the dependency's health: no budget change.
        if (o.shouldRetry !== undefined && !o.shouldRetry(error, attempt)) giveUp("not-retryable");
        o.budget?.onFailure();
        if (attempt >= this.maxAttempts) giveUp("attempts");
        if (o.budget !== undefined && !o.budget.canRetry()) giveUp("budget");

        let delayMs = this.backoff.delayMs(attempt, random);
        const asked = o.retryAfterMs?.(error);
        if (asked !== undefined && Number.isFinite(asked) && asked > delayMs) {
          if (asked > (o.maxRetryAfterMs ?? 60_000)) giveUp("retry-after-too-long");
          delayMs = Math.ceil(asked);
        }
        if (o.deadlineMs !== undefined && now() + delayMs - startedAt >= o.deadlineMs) giveUp("deadline");

        o.onRetry?.({ attempt, delayMs, error });
        emit(o.onEvent, { type: "retry", policy: o.name ?? "retry", attempt, delayMs, error });
        await sleep(delayMs, signal); // rejects at once if the caller aborts while we wait
      }
    }
  }
}
