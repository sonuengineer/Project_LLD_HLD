# resilience-kit (build your own)

A small TypeScript library that wraps ANY async call -- a payment gateway, an SMS or email API, another service --
with a timeout, retries with backoff and jitter, and a retry budget that switches retries off during an outage. The
core imports no framework, so the same code runs in an Express handler, a NestJS service, a worker or a script. No
runtime dependencies.

Status (2026-11-23): **stage 1 done** -- 86 tests pass (Windows, Node 20), including tests against a real HTTP
server on loopback; 32 deliberate breaks, all caught. Stage 2 (circuit breaker, bulkhead) and stage 3 (composition,
Express / NestJS adapters, interview bank) are planned in [PLAN.md](PLAN.md), not built.

## Use it

Everything wraps an `Operation<T> = (signal: AbortSignal) => Promise<T>`. Pass the signal on to whatever does the
work (fetch, a driver), so a timeout or a cancelled caller really stops it.

```ts
import { HttpError, isRetryableHttp, parseRetryAfter, RetryBudget, RetryPolicy, TimeoutPolicy } from "resilience-kit";

// One budget per dependency, shared by every call to it.
const smsBudget = new RetryBudget();
const timeout = new TimeoutPolicy({ ms: 2000 }); // per attempt
const retry = new RetryPolicy({
  maxAttempts: 3,
  shouldRetry: isRetryableHttp, // network errors, timeouts, 408, 429, 5xx except 501
  retryAfterMs: (e) => (e instanceof HttpError ? e.retryAfterMs : undefined),
  budget: smsBudget,
  deadlineMs: 8000, // the whole thing, all attempts and waits
  onGiveUp: (e) => console.warn("sms failed", e.reason, e.attempts),
});

async function sendSms(body: unknown, signal?: AbortSignal) {
  return retry.execute(
    (s) => timeout.execute(async (t) => {
      const res = await fetch("https://sms.example/send", { method: "POST", body: JSON.stringify(body), signal: t });
      if (!res.ok) throw new HttpError(res.status, parseRetryAfter(res.headers.get("retry-after")));
      return res.json();
    }, s),
    signal,
  );
}
```

The order is `retry( timeout( call ) )`: each attempt gets its own timeout, and the retry decides what to do about a
timed-out attempt. The other way round, one timeout would cover all attempts and the waits between them (that is
what `deadlineMs` is for).

**Express / NestJS (sketch, NOT tested in this repo yet -- the adapters are stage 3).** Nothing framework-specific is
needed to call it; to stop the work when the client disconnects, pass a signal tied to the request:

```ts
// Express
app.post("/notify", async (req, res, next) => {
  const ac = new AbortController();
  res.on("close", () => { if (!res.writableFinished) ac.abort(new Error("client went away")); });
  try { res.json(await sendSms(req.body, ac.signal)); } catch (e) { next(e); }
});

// NestJS: a singleton service wraps the call (the policies and budget above are module-level: one per process);
// controllers call smsService.send(dto)
@Injectable()
export class SmsService {
  send(dto: SmsDto, signal?: AbortSignal) { return sendSms(dto, signal); }
}
```

## What each policy does

**TimeoutPolicy({ ms })** -- on timeout it aborts the signal the operation was given (reason: a `TimeoutError`) AND
rejects at once with that `TimeoutError`, even if the operation ignores its signal. A caller's own signal is linked
in: the caller aborting aborts the operation and rejects with the caller's reason. Its timer and its listener on the
caller's signal are always removed (tested: no timer left, no listener leak).

**RetryPolicy(options)**

| Option | Default | Meaning |
|---|---|---|
| `maxAttempts` | 3 | including the first call |
| `backoff` | 100 ms, x2, max 10 s, full jitter | `{ initialMs, multiplier, maxMs, jitter: "full" \| "equal" \| "none" }` or your own `{ delayMs(n, random) }` |
| `shouldRetry(error, attempt)` | always | say no to errors that will not change (400, 401, 403, 404, 422) |
| `retryAfterMs(error)` | none | a delay the server asked for; used when longer than the backoff |
| `maxRetryAfterMs` | 60 s | asked to wait longer than this -> give up instead of parking the request |
| `budget` | none | a shared `RetryBudget` |
| `deadlineMs` | none | no retry that would START after this much total time |
| `onRetry`, `onGiveUp` | none | events for logs / metrics; `onGiveUp` gets `reason`: `attempts`, `not-retryable`, `budget`, `deadline`, `retry-after-too-long` |

Rules that are not options:
- A failure after the CALLER aborted is never retried; it rejects with the caller's reason. The backoff wait is
  cancellable too.
- When it gives up it rethrows the **last error unchanged**, not a wrapper, so existing `catch` code keeps working.
- A non-retryable error does not touch the budget (it says nothing about the dependency's health).

**Backoff and jitter.** Wait before retry n: `min(maxMs, initialMs x multiplier^(n-1))`, then
- `full` (default): random in [0, value) -- spreads clients that failed together the most;
- `equal`: value/2 + random in [0, value/2) -- never retries almost at once;
- `none`: exactly the value -- deterministic, fine for one client, a thundering herd for a fleet.

**RetryBudget({ maxTokens = 10, tokenRatio = 0.1 })** -- gRPC's retry throttling. Starts full; each failed attempt
costs 1 token, each success adds `tokenRatio`; retries are allowed only while tokens > maxTokens / 2. Counted in
thousandths, so 50 x 0.1 is exactly 5 (tested). The failing attempt pays BEFORE the check, so a retry needs more than
threshold + 1 tokens: right after `canRetry()` turns true again, the next single failure is still not retried (found
by a test that expected otherwise; the test now states it).

**HTTP helpers.** `parseRetryAfter(header)` reads both forms (seconds, HTTP-date; a past date = 0; `-5`, `1.5`,
garbage = undefined). `HttpError(status, retryAfterMs)`. `isRetryableHttp(error)`: true for non-HTTP errors (network,
timeout), 408, 429 and 5xx except 501.

## What the tests show

`npm test` -- 86 tests in `test/`:

| File | Proves |
|---|---|
| `timeout.test.ts` | sleep (waits, cancellable, no timer left); timeout: result, error pass-through (incl. a sync throw), TimeoutError AND the signal aborted with it, rejects even if the operation ignores the signal, a late answer changes nothing, caller abort (reason, signal, no timer), already-aborted caller never calls the operation, listener removed on every call, invalid ms (15) |
| `backoff.test.ts` | none / full / equal values, defaults and the cap at retry 50 (no overflow), 10 000 random draws stay in range and are integers, invalid options (9) |
| `budget.test.ts` | token arithmetic, the half threshold, never below 0, no float drift; a 1000-call simulation and recovery (see below) (10) |
| `retry.test.ts` | success, fail-fail-succeed with waits 100 and 200, the last error unchanged, maxAttempts 1, non-retryable (no budget change), attempt numbers, Retry-After longer / shorter / too long, deadline, budget give-up and refill, caller abort during the call and during the wait (fake timers, no timer left), defaults with an injected random, a custom Backoff, the real sleep, invalid options (20) |
| `http.test.ts` | parseRetryAfter (11 cases), isRetryableHttp (13); against a real `node:http` server on 127.0.0.1 with `fetch`: 503-503-200, 404 not retried, 429 + `Retry-After: 1` waits 1000 ms, all 503 -> the HttpError, a hanging server -> TimeoutError AND the server sees the connection close, hang-hang-200, caller abort mid-request (server sees the close, no retry), connection refused with a budget (32) |

**Retry storm, measured in a simulation (deterministic, no timers; `budget.test.ts`):** 1000 calls with 3
attempts each to a dependency that is down.

| | Attempts sent to the dead dependency |
|---|---|
| no budget | 3000 |
| with `RetryBudget()` (defaults) | 1003 (3 + 2 + 998 x 1) |

The same shape over real sockets: 20 calls to a closed port with a budget made 23 connection attempts
(`http.test.ts`). After recovery, 51 successes make `canRetry()` true again, and 72 in total make a single failure
retried again.

### Mutation checks (2026-11-23)

Each row: one deliberate bug, applied alone, full suite run, reverted (runner kept outside the repo). All 32 caught;
the number is how many of the 86 tests failed.

| # | Break | Failed |
|---|---|---|
| R1 | timeout aborts without the TimeoutError reason | 4 |
| R2 | timeout timer not cleared | 2 |
| R3 | listener on the caller's signal not removed | 1 |
| R4 | caller abort not linked to the operation | 2 |
| R5 | no race: waits for an operation that ignores its signal | 4 |
| R6 | timeout ignores an already-aborted caller | 1 |
| R7 | sleep ignores abort | 2 |
| R8 | sleep leaves its timer on abort | 2 |
| R9 | backoff exponent off by one | 10 |
| R10 | backoff not capped | 3 |
| R11 | full jitter missing | 4 |
| R12 | equal jitter is full jitter | 1 |
| R13 | budget threshold inclusive | 4 |
| R14 | budget refill not capped | 1 |
| R15 | budget goes negative | 2 |
| R16 | retries after the caller aborted | 1 |
| R17 | non-retryable errors drain the budget | 1 |
| R18 | one attempt too many | 4 |
| R19 | budget not checked | 4 |
| R20 | success not reported to the budget | 2 |
| R21 | Retry-After ignored | 3 |
| R22 | Retry-After cap ignored | 1 |
| R23 | deadline ignored | 1 |
| R24 | backoff wait not cancellable | 1 |
| R25 | gives up with a wrapper instead of the last error | 11 |
| R26 | retry ignores an already-aborted caller | 1 |
| R27 | every 4xx retried | 7 |
| R28 | 501 retried | 1 |
| R29 | Retry-After seconds read as ms | 3 |
| R30 | a Retry-After date in the past gives a negative delay | 1 |
| R31 | `-5` and `1.5` accepted as Retry-After dates | 2 |
| R32 | a shorter Retry-After overrides the backoff | 1 |

Caught by exactly one test (deleting that test would hide them): R3, R6, R12, R14, R16, R17, R22, R23, R24, R26,
R28, R30, R32.

## NOT implemented (after stage 1)

- Circuit breaker and bulkhead (stage 2); composition helper, one event stream, Express / NestJS adapters (stage 3).
  The framework snippets above are sketches, not tested here.
- Anything shared between processes: a budget lives in one process's memory. Three API replicas have three budgets.
- Hedged requests, adaptive concurrency, fallbacks, caching.
- Not benchmarked: the overhead of a policy per call has not been measured.
- Not published to npm; use it from this repo (copy or a local path dependency).

## Run it

```bash
cd projects/18-resilience
npm ci
npm test
npm run build   # dist/
```

## Files

| File | What |
|---|---|
| `src/types.ts` | `Operation`, `Policy` |
| `src/timeout.ts` | `TimeoutPolicy` |
| `src/retry.ts` | `RetryPolicy`, events, give-up reasons |
| `src/backoff.ts` | `exponentialBackoff`, jitter modes |
| `src/budget.ts` | `RetryBudget` |
| `src/sleep.ts` | cancellable `sleep` |
| `src/errors.ts` | `TimeoutError` |
| `src/http.ts` | `parseRetryAfter`, `HttpError`, `isRetryableHttp` |
