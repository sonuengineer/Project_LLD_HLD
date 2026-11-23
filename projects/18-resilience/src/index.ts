// Core entry point: no framework, no runtime dependency. Framework adapters are separate entry points
// (resilience-kit/express, resilience-kit/nestjs) so the core never pulls them in.
export { exponentialBackoff, type Backoff, type BackoffOptions, type Jitter } from "./backoff.js";
export { CircuitBreaker, type CircuitBreakerOptions, type CircuitState, type StateChange } from "./breaker.js";
export { RetryBudget, type RetryBudgetOptions } from "./budget.js";
export { Bulkhead, type BulkheadOptions } from "./bulkhead.js";
export { BrokenCircuitError, BulkheadRejectedError, ClientClosedError, TimeoutError } from "./errors.js";
export { type Observable, type ResilienceEvent, type ResilienceEventHandler } from "./events.js";
export { HttpError, isRetryableHttp, parseRetryAfter } from "./http.js";
export { RetryPolicy, type GiveUpEvent, type GiveUpReason, type RetryEvent, type RetryOptions } from "./retry.js";
export { sleep } from "./sleep.js";
export { TimeoutPolicy, type TimeoutOptions } from "./timeout.js";
export type { Operation, Policy } from "./types.js";
export { wrap } from "./wrap.js";
export { mapResilienceError, type MappedError } from "./adapters/http-status.js";
