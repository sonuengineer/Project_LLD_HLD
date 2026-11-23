# resilience-kit (build your own)

A small TypeScript library that wraps ANY async call -- a payment gateway, an SMS or email API, another service --
with a timeout, retries with backoff and jitter, a retry budget that switches retries off during an outage, a
circuit breaker that stops calling a dependency that is down, and a bulkhead that caps how many calls to it run at
once. The core imports no framework, so the same code runs in an Express handler, a NestJS service, a worker or a
script. No runtime dependencies.

Status (2026-11-23): **stages 1 and 2 done** -- 130 tests pass (Windows, Node 20), including tests against a real
HTTP server on loopback; 59 deliberate breaks, all caught (one only after a test was added, see "Mutation checks").
Stage 3 (composition, Express / NestJS adapters, interview bank) is planned in [PLAN.md](PLAN.md), not built.

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
timeout), 408, 429 and 5xx except 501; false for `BrokenCircuitError` and `BulkheadRejectedError` (failing fast is
their point; an immediate retry would hit the same open breaker or full bulkhead). It doubles as a breaker's
`isFailure`: a 404 is the service answering correctly, not a sign it is down.

**CircuitBreaker(options)** (stage 2)

```
 closed --(failure rate >= threshold over the last windowSize calls, at least minimumCalls)--> open
 open   --(openMs passed; checked on the next call, no timer)-------------------------------> half-open
 half-open --(halfOpenMaxCalls probes all succeed)--> closed (empty window)
 half-open --(any probe fails)----------------------> open (a new openMs)
```

| Option | Default | Meaning |
|---|---|---|
| `failureRateThreshold` | 0.5 | open when failures / calls in the window reach this |
| `windowSize` | 20 | count-based sliding window: the last N recorded calls |
| `minimumCalls` | 10 | no decision before this many calls (1 failure of 1 call must not open it) |
| `openMs` | 30 s | fail fast for this long, then let a probe through |
| `halfOpenMaxCalls` | 1 | probes allowed at once AND successes needed to close; a finished probe's slot is not reused |
| `isFailure(error)` | every error | false = the dependency answered correctly (404, validation): counts as a SUCCESS |
| `onStateChange` | none | `{ from, to }`; a callback that throws is ignored, it cannot turn a finished call into an error |

- Open: `BrokenCircuitError { state: "open", retryAfterMs }` at once, the operation is NOT called. Half-open with
  the probe slots taken: `BrokenCircuitError { state: "half-open", retryAfterMs: 0 }`.
- **Generations.** Every state change starts a new generation, and a call only records its outcome if the breaker
  is still in the generation the call started in. A slow call that started while closed and fails after the breaker
  opened must not push the open timer back; one that succeeds during half-open must not count as the probe; one
  that fails during half-open must not reopen it (three tests, mutation B9).
- A call whose caller aborted is not recorded at all; an aborted probe frees its slot without deciding anything.
- A probe that never finishes keeps its slot forever: put a `TimeoutPolicy` inside the breaker.

**Bulkhead({ maxConcurrent, maxQueue = 0 })** (stage 2) -- at most `maxConcurrent` calls run at once, up to
`maxQueue` wait in FIFO order, the rest get `BulkheadRejectedError` without running. So a dependency that hangs can
hold at most its own slots, not every socket in the process (tested over HTTP: 6 calls to a hanging server, 2 reach
it and time out, 4 are refused at once).
- A finishing call hands its slot DIRECTLY to the oldest waiter; the running count never drops in between, so a
  newcomer arriving at that moment cannot start ahead of someone who waited (test "no barging", mutation K4).
- A waiter whose caller aborts leaves the queue and rejects with the caller's reason; a waiter that gets its slot
  removes its abort listener (mutation K7).
- `running` and `queued` for metrics.

## What the tests show

`npm test` -- 130 tests in `test/`:

| File | Proves |
|---|---|
| `timeout.test.ts` | sleep (waits, cancellable, no timer left); timeout: result, error pass-through (incl. a sync throw), TimeoutError AND the signal aborted with it, rejects even if the operation ignores the signal, a late answer changes nothing, caller abort (reason, signal, no timer), already-aborted caller never calls the operation, listener removed on every call, invalid ms (15) |
| `backoff.test.ts` | none / full / equal values, defaults and the cap at retry 50 (no overflow), 10 000 random draws stay in range and are integers, invalid options (9) |
| `budget.test.ts` | token arithmetic, the half threshold, never below 0, no float drift; a 1000-call simulation and recovery (see below) (10) |
| `retry.test.ts` | success, fail-fail-succeed with waits 100 and 200, the last error unchanged, maxAttempts 1, non-retryable (no budget change), attempt numbers, Retry-After longer / shorter / too long, deadline, budget give-up and refill, caller abort during the call and during the wait (fake timers, no timer left), defaults with an injected random, a custom Backoff, the real sleep, invalid options (20) |
| `breaker.test.ts` | closed: pass-through, minimumCalls, exactly at the threshold, below it, the window slides, non-failures count as success, aborted calls not recorded; open: no call, retryAfterMs; lazy half-open; one probe vs a second call; probe success -> empty window; probe failure -> a new openMs; 3 probes needed and slots not reused; aborted probe frees its slot; stale results from earlier generations (3 cases); throwing onStateChange; sync throw; defaults; invalid options (28) |
| `bulkhead.test.ts` | limit and immediate rejection, FIFO queue then rejection, slot freed on failure and sync throw, no barging, aborted waiter leaves the queue, abort listener removed at hand-off, already-aborted caller, the caller's signal passed on, 400 random steps (never above the limit, every accepted call runs exactly once), invalid options (12) |
| `http.test.ts` | parseRetryAfter (11 cases), isRetryableHttp (14, incl. breaker / bulkhead rejections); against a real `node:http` server on 127.0.0.1 with `fetch`: 503-503-200, 404 not retried, 429 + `Retry-After: 1` waits 1000 ms, all 503 -> the HttpError, a hanging server -> TimeoutError AND the server sees the connection close, hang-hang-200, caller abort mid-request (server sees the close, no retry), a breaker opened by 503s (20 calls while open reach the server 0 times; after openMs one probe closes it), 404s do not open a breaker, a bulkhead in front of a hanging server (2 reach it, 4 refused), connection refused with a budget (36) |

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

Caught by exactly one test at stage 1 (deleting that test would hide them): R3, R6, R12, R14, R16, R17, R22, R23,
R24, R26, R28, R30, R32.

**Stage 2 (2026-11-23, against 129 tests, then 130):** 27 new breaks; 26 caught at first. The survivor was K7 (a
waiter that got its slot left its abort listener on the caller's signal: a leak with no visible effect). A test that
spies on the signal's listeners was added; K7 is now caught.

| # | Break | Failed |
|---|---|---|
| B1 | old failures never leave the window | 1 |
| B2 | minimumCalls ignored | 6 |
| B3 | threshold exclusive | 2 |
| B4 | open breaker still calls the operation | 2 |
| B5 | never goes half-open | 12 |
| B6 | half-open probe limit not enforced | 2 |
| B7 | a finished probe's slot is reused | 1 |
| B8 | a failed probe does not reopen | 2 |
| B9 | no generation check (stale results count) | 2 |
| B10 | window not reset on close | 1 |
| B11 | calls of aborted callers recorded | 2 |
| B12 | isFailure ignored | 3 |
| B13 | non-failures ignored instead of counted as success | 1 |
| B14 | probe slot never freed | 1 |
| B15 | reopen keeps the old open time | 2 |
| B16 | retryAfterMs always openMs | 1 |
| B17 | onStateChange errors not swallowed | 1 |
| B18 | breaker ignores an already-aborted caller | 1 |
| K1 | bulkhead allows one too many | 7 |
| K2 | queue allows one too many | 3 |
| K3 | slot leaks when the operation fails | 1 |
| K4 | barging: release frees the slot, the waiter re-takes it later | 1 |
| K5 | aborted waiter stays in the queue | 1 |
| K6 | LIFO instead of FIFO | 1 |
| K7 | abort listener not removed on hand-off (survived; test added) | 1 |
| K8 | bulkhead ignores an already-aborted caller | 1 |
| K9 | breaker / bulkhead rejections retried | 1 |

The 32 stage 1 breaks re-run on the stage 2 code: all caught (R1 5, R2 2, R3 1, R4 2, R5 4, R6 1, R7 2, R8 2, R9 10,
R10 3, R11 4, R12 1, R13 4, R14 1, R15 2, R16 1, R17 1, R18 4, R19 4, R20 2, R21 3, R22 1, R23 1, R24 1, R25 11,
R26 1, R27 8, R28 1, R29 3, R30 1, R31 2, R32 1).

**A test-environment finding.** The first stage 2 run gave unstable counts (the same break failing 1 test, then 6).
The extra failures all read "expected BulkheadRejectedError to be an instance of BulkheadRejectedError": the error
classes had been loaded TWICE, so `instanceof` failed against the other copy. It happened only when the runner
started vitest from a lowercase drive path (`h:\...`); with `H:\...` the same breaks gave the same counts in 3 of 3
runs, and the clean suite never failed (8 of 8 runs). The stage 2 numbers and the stage 1 re-run above are from
`H:\` runs; the stage 1 table further up came from a lowercase-path run, so the re-run is the one to trust. Lesson: a noisy
mutation count can make a break look caught when it is not -- check unexpected failures by name.

## NOT implemented (after stage 2)

- Composition helper, one event stream, Express / NestJS adapters (stage 3). The framework snippets above are
  sketches, not tested here.
- The breaker's window is count-based only (no time-based window), and it has no "slow call" rate: put a
  `TimeoutPolicy` inside it so slow calls become failures.
- Anything shared between processes: a budget, a breaker and a bulkhead live in one process's memory. Three API
  replicas have three of each (each replica learns on its own that a dependency is down).
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
| `src/breaker.ts` | `CircuitBreaker` |
| `src/bulkhead.ts` | `Bulkhead` |
| `src/retry.ts` | `RetryPolicy`, events, give-up reasons |
| `src/backoff.ts` | `exponentialBackoff`, jitter modes |
| `src/budget.ts` | `RetryBudget` |
| `src/sleep.ts` | cancellable `sleep` |
| `src/errors.ts` | `TimeoutError`, `BrokenCircuitError`, `BulkheadRejectedError` |
| `src/http.ts` | `parseRetryAfter`, `HttpError`, `isRetryableHttp` |
