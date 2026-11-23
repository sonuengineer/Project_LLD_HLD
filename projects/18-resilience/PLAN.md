# A19 (build your own) -- resilience-kit: plan

Status (2026-11-23): stage 1 DONE (timeout, retry with backoff and jitter, retry budget, HTTP helpers; 86 tests incl.
a real loopback HTTP server; 32 mutation checks all caught). Stage 2 DONE (circuit breaker with generations, bulkhead
with direct hand-off; 130 tests; 27 new mutation checks, 1 survivor closed with a test). Stage 3 DONE (wrap and the
order experiments, one event stream, Express and NestJS adapters tested against real apps, overhead measured vs
cockatiel; 172 tests).

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
- **Stage 2: count-based sliding window for the breaker** (last N calls, ring buffer), with a minimum number of
  calls before any decision. Simpler than time buckets and the usual default (resilience4j's is count-based);
  the cost is that at low traffic the window can hold old outcomes -- `minimumCalls` and a sensible `windowSize`
  limit that. Time-based windows are not built.
- **Stage 2: open -> half-open is checked lazily on the next call, no timer.** Nothing runs in the background, and an
  idle breaker costs nothing.
- **Stage 2: generations instead of trusting every late result.** A state change bumps a counter; a call records its
  outcome only in the generation it started in. Without it, a slow failure from before the breaker opened pushes the
  open timer back, or a slow success from the closed state closes a half-open breaker without a real probe.
- **Stage 2: errors that are not failures count as successes** (the dependency answered). Recommended over ignoring
  them: a service answering 404 to everything is healthy, and ignoring those calls would let a few 5xx decide alone.
- **Stage 2: the bulkhead hands a slot directly to the next waiter.** Releasing the slot and letting the waiter take
  it when it wakes up lets a newcomer barge in between; the hand-off keeps the queue fair (tested with a newcomer
  scheduled exactly in that gap).
- **Stage 3: `wrap` is plain function composition, outermost first, with a RECOMMENDED order rather than an
  enforced one** (retry -> breaker -> bulkhead -> timeout). Every placement claim is a test that also shows what
  the wrong order does, so the recommendation is evidence, not folklore.
- **Stage 3: adapters are separate entry points** (`resilience-kit/express`, `resilience-kit/nestjs`); the core
  imports neither. The Express adapter is written against Node's http types, so it does not import Express at all;
  the NestJS one needs `@nestjs/common` (optional peer dependency). Recommended over one package that imports both
  frameworks, which would force them on every user.
- **Stage 3: response bodies are generic** and never carry the dependency's error text (internal hostnames, tokens).
- **Stage 3: `HttpError.upstreamStatus`, not `status`** -- found by the Express test (Express sends `err.status` to
  the client).
- **Test hooks instead of global fake time where possible:** `sleep`, `random` and `now` can be injected, so retry
  tests record waits instead of waiting. Fake timers are used where the real timer behaviour is the point.

## Stages

| Stage | What | Status |
|---|---|---|
| 1 | TimeoutPolicy, RetryPolicy (exponential backoff, full/equal/no jitter, shouldRetry, Retry-After, deadline, events), RetryBudget, HTTP helpers (parseRetryAfter, HttpError, isRetryableHttp) | DONE 2026-11-23 |
| 2 | Circuit breaker (closed -> open -> half-open, failure rate over a count-based sliding window, minimum calls, probe calls in half-open, generations against stale results, BrokenCircuitError), bulkhead (max concurrent + bounded FIFO queue, direct hand-off, reject when full, cancellable waiting) | DONE 2026-11-23 |
| 3 | Composition (`wrap`, order experiments), one event stream, Express adapter (request signal, error middleware, load shedding) and NestJS adapter (`@RequestSignal()`, exception filter) tested with real apps, overhead measured vs cockatiel, interview bank, portfolio page | DONE 2026-11-23 |

## Not in scope

Distributed state (a breaker shared between processes through Redis), hedged requests, adaptive concurrency
limits, caching / fallback values.
