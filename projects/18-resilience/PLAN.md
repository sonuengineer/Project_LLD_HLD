# A19 (build your own) -- resilience-kit: plan

Status (2026-11-23): stage 1 DONE (timeout, retry with backoff and jitter, retry budget, HTTP helpers; 86 tests incl.
a real loopback HTTP server; 32 mutation checks all caught). Stages 2 and 3 not started.

## Why this project

Every backend calls something it does not control: a payment gateway, SMS, email, another team's API, a database
over the network. Those calls fail, hang and slow down, and the naive fixes make it worse (no timeout: requests pile
up; retry without backoff: a retry storm against a service that is already down). This is a small library to wrap
ANY such call, usable in the owner's own projects -- Express, NestJS, workers or scripts -- because the core knows
nothing about any framework.

Established libraries exist (`cockatiel`, `opossum`, `p-retry`). Building one by hand is about understanding exactly
what each policy does and where it fails; stage 3 compares against one of them.

## Decisions (one recommendation each)

- **TypeScript, zero runtime dependencies, Node 20.3+.** Same toolchain as the other TS projects.
- **Framework-free core: a policy wraps `(signal: AbortSignal) => Promise<T>`.** That is the shape of
  `fetch(url, { signal })` and of most modern drivers. Express and NestJS adapters (stage 3) are thin files on top;
  nothing in the core imports a framework.
- **Timeout aborts the operation's signal, not just the promise.** A timeout that only stops WAITING leaves the
  request running (socket open, query still executing). The test proves the server sees the connection close.
- **The caller's signal is honoured everywhere.** A client that went away should stop the work, the retries and the
  backoff wait at once.
- **Retry rethrows the last error unchanged.** Callers keep their existing error handling (`instanceof HttpError`);
  attempts and the reason go to `onGiveUp`. Chosen over a `RetriesExhaustedError` wrapper, which forces every caller
  to unwrap.
- **Full jitter by default** (the AWS "Exponential Backoff And Jitter" recommendation): many clients that failed
  together must not come back together.
- **Retry budget = gRPC retry throttling** (tokens, -1 per failure, +ratio per success, retry only above half),
  counted in thousandths like gRPC so it does not drift. Chosen over a fixed "max retries per second" because it
  adapts to the success rate. Non-retryable errors (a 404) do not count: they say nothing about the dependency's
  health.
- **Retry-After is honoured when longer than the backoff; a request to wait longer than `maxRetryAfterMs`
  (default 60 s) gives up** instead of parking the request.
- **Test hooks instead of global fake time where possible:** `sleep`, `random` and `now` can be injected, so retry
  tests record waits instead of waiting. Fake timers are used where the real timer behaviour is the point.

## Stages

| Stage | What | Status |
|---|---|---|
| 1 | TimeoutPolicy, RetryPolicy (exponential backoff, full/equal/no jitter, shouldRetry, Retry-After, deadline, events), RetryBudget, HTTP helpers (parseRetryAfter, HttpError, isRetryableHttp) | DONE 2026-11-23 |
| 2 | Circuit breaker (closed -> open -> half-open, failure rate over a sliding window, minimum calls, probe calls in half-open, BrokenCircuitError), bulkhead (max concurrent + bounded queue, reject when full) | not started |
| 3 | Composition (`wrap(retry, breaker, timeout)` and why the order matters), one event stream for logs/metrics, Express middleware and NestJS interceptor adapters (tested with each framework), comparison with an established library, interview bank, portfolio page | not started |

## Not in scope

Distributed state (a breaker shared between processes through Redis), hedged requests, adaptive concurrency
limits, caching / fallback values.
