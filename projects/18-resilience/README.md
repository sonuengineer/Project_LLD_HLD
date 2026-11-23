# resilience-kit (build your own)

A small TypeScript library that wraps ANY async call -- a payment gateway, an SMS or email API, another service --
with a timeout, retries with backoff and jitter, a retry budget that switches retries off during an outage, a
circuit breaker that stops calling a dependency that is down, and a bulkhead that caps how many calls to it run at
once. The core imports no framework, so the same code runs in an Express handler, a NestJS service, a worker or a
script. No runtime dependencies.

Status (2026-11-23): **stages 1-3 done** -- 179 tests pass (Windows, Node 20), including tests against a real HTTP
server on loopback, a real Express 4 app and a real NestJS 10 app; per-call overhead measured against cockatiel
(see "Overhead"); all deliberate breaks of the last round caught (see "Mutation checks"). Not published to npm.

## Use it

Everything wraps an `Operation<T> = (signal: AbortSignal) => Promise<T>`. Pass the signal on to whatever does the
work (fetch, a driver), so a timeout, an open breaker or a client that went away really stops it.

```ts
import {
  Bulkhead, CircuitBreaker, HttpError, isRetryableHttp, parseRetryAfter, RetryBudget, RetryPolicy, TimeoutPolicy, wrap,
  type ResilienceEvent,
} from "resilience-kit";

// One set of policies PER DEPENDENCY, created once (module level / a singleton service), shared by every call.
// (Illustrative: `logger` is your app's logger.)
const onEvent = (e: ResilienceEvent) => logger.info({ resilience: e.type, policy: e.policy }); // or a metrics counter
const sms = wrap(
  new RetryPolicy({
    name: "sms-retry", maxAttempts: 3, budget: new RetryBudget(), deadlineMs: 8000, onEvent,
    shouldRetry: isRetryableHttp, // network errors, timeouts, 408, 429, 5xx except 501; never an open breaker
    retryAfterMs: (e) => (e instanceof HttpError ? e.retryAfterMs : undefined),
  }),
  new CircuitBreaker({ name: "sms-breaker", isFailure: isRetryableHttp, onEvent }), // a 404 is not "down"
  new Bulkhead({ name: "sms-pool", maxConcurrent: 20, maxQueue: 50, onEvent }),
  new TimeoutPolicy({ name: "sms-timeout", ms: 2000, onEvent }), // per attempt
);

export function sendSms(body: unknown, signal?: AbortSignal) {
  return sms.execute(async (s) => {
    const res = await fetch("https://sms.example/send", { method: "POST", body: JSON.stringify(body), signal: s });
    if (!res.ok) throw new HttpError(res.status, parseRetryAfter(res.headers.get("retry-after")));
    return res.json();
  }, signal);
}
```

**Express** (`resilience-kit/express`; uses only Node's http types, so Express 4 and 5; tested with 4.21.2):

```ts
import { loadShedding, requestSignal, resilienceErrorHandler } from "resilience-kit/express";

app.post("/notify", async (req, res, next) => {
  try { res.json(await sendSms(req.body, requestSignal(req, res))); } // client disconnects -> the SMS call stops
  catch (e) { next(e); }
});
app.use("/heavy", loadShedding(new Bulkhead({ maxConcurrent: 50 }))); // at most 50 requests in flight, else 503
app.use(resilienceErrorHandler()); // open breaker / full bulkhead -> 503 (+ Retry-After), timeout -> 504
```

**NestJS** (`resilience-kit/nestjs`, platform-express; `@nestjs/common` is an optional peer dependency; tested with
10.4.15):

```ts
import { RequestSignal, ResilienceExceptionFilter } from "resilience-kit/nestjs";

@Controller("notify")
export class NotifyController {
  @Post() send(@Body() dto: SmsDto, @RequestSignal() signal: AbortSignal) { return sendSms(dto, signal); }
}
// main.ts
app.useGlobalFilters(new ResilienceExceptionFilter());
```

The response bodies are generic (`{"error":"dependency_timeout","message":"..."}`): a dependency's own error text
is never sent to your client. Anything that is not a resilience error goes to the framework's normal handling.

## Composition: why this order

`wrap(a, b, c)` runs `a( b( c( call ) ) )`. The recommended order is **retry -> breaker -> bulkhead -> timeout**;
each line below is a test in `test/wrap.test.ts`:

| Placement | Right | Wrong, and what the test shows |
|---|---|---|
| timeout inside retry | hang, hang, ok -> ok: every attempt has its own deadline | timeout outside: one deadline for all attempts AND the waits; the 3rd attempt never happens |
| breaker inside retry | every failed attempt is recorded: the 10th (during the 4th call) opens it, later attempts are rejected | breaker outside: 4 outcomes, it stays closed while the dependency is down |
| breaker -> retry with `isRetryableHttp` | an open breaker stops the retry at once (0 retries) | -- |
| bulkhead inside retry | a call in backoff does not hold a slot; another call gets through | bulkhead outside: the sleeping call holds the slot, the next call is rejected |

## Events

Every policy takes `name` and `onEvent`. One handler receives one typed union:
`timeout`, `retry` (attempt, delayMs, error), `give-up` (attempts, reason, error), `breaker-state` (from, to),
`breaker-rejected` (state), `bulkhead-rejected` (running, queued) -- each with `policy` (the name; default
`timeout` / `retry` / `breaker` / `bulkhead`). A handler that throws is ignored: telemetry never changes what the
caller gets (tested). The older per-policy callbacks (`onRetry`, `onGiveUp`, `onStateChange`) still work.

**`HttpError` carries `upstreamStatus`, not `status`.** Found by the Express test: Express's default error handler
sends `err.status` to the client, so with a `status` field a dependency's 404 became our 404 and its 401 would tell
OUR client that THEY are unauthorized. Renamed in stage 3; an upstream error now reaches the client as a plain 500
unless the app maps it on purpose.

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
| `minimumCalls` | 10 (or `windowSize` if smaller) | no decision before this many calls (1 failure of 1 call must not open it) |
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
  newcomer arriving at that moment cannot start ahead of someone who waited (test "no barging", mutation K4). The
  first version of that test did NOT test barging: its newcomer arrived before the slot was released, so it was
  refused whatever the release logic did. The test now schedules the newcomer in a reaction on the finishing
  operation's own promise, which runs after the bulkhead's release and before the waiter wakes (promise reactions
  run in registration order) -- the only moment barging can happen.
- A waiter whose caller aborts leaves the queue and rejects with the caller's reason; a waiter that gets its slot
  removes its abort listener (mutation K7).
- `running` and `queued` for metrics.

## What the tests show

`npm test` -- 179 tests in `test/`:

| File | Proves |
|---|---|
| `timeout.test.ts` | sleep (waits, cancellable, no timer left); timeout: result, error pass-through (incl. a sync throw), TimeoutError AND the signal aborted with it, rejects even if the operation ignores the signal, a late answer changes nothing, caller abort (reason, signal, no timer), already-aborted caller never calls the operation, listener removed on every call, invalid ms (15) |
| `backoff.test.ts` | none / full / equal values, defaults and the cap at retry 50 (no overflow), 10 000 random draws stay in range and are integers, invalid options (9) |
| `budget.test.ts` | token arithmetic, the half threshold, never below 0, no float drift; a 1000-call simulation and recovery (see below) (10) |
| `retry.test.ts` | success, fail-fail-succeed with waits 100 and 200, the last error unchanged, maxAttempts 1, non-retryable (no budget change), attempt numbers, Retry-After longer / shorter / too long / Infinity (gives up) / NaN (ignored), throwing onRetry / onGiveUp contained, deadline, budget give-up and refill, caller abort during the call and during the wait (fake timers, no timer left), defaults with an injected random, a custom Backoff, the real sleep, invalid options (22) |
| `breaker.test.ts` | closed: pass-through, minimumCalls, exactly at the threshold, below it, the window slides, non-failures count as success, aborted calls not recorded; open: no call, retryAfterMs; lazy half-open; one probe vs a second call; probe success -> empty window; probe failure -> a new openMs; 3 probes needed and slots not reused; aborted probe frees its slot; stale results from earlier generations (3 cases); throwing onStateChange; a throwing isFailure counts as a failure and cannot leave it stuck half-open; sync throw; defaults; invalid options (29) |
| `bulkhead.test.ts` | limit and immediate rejection, FIFO queue then rejection, slot freed on failure and sync throw, no barging, aborted waiter leaves the queue, a waiter aborted right after the hand-off does not run and passes the slot on, abort listener removed at hand-off, already-aborted caller, the caller's signal passed on, 400 random steps (never above the limit, every accepted call runs exactly once), invalid options (13) |
| `http.test.ts` | parseRetryAfter (11 cases + a 400-digit value -> Infinity), isRetryableHttp (14, incl. breaker / bulkhead rejections); against a real `node:http` server on 127.0.0.1 with `fetch`: 503-503-200, 404 not retried, 429 + `Retry-After: 1` waits 1000 ms, all 503 -> the HttpError, a hanging server -> TimeoutError AND the server sees the connection close, hang-hang-200, caller abort mid-request (server sees the close, no retry), a breaker opened by 503s (20 calls while open reach the server 0 times; after openMs one probe closes it), 404s do not open a breaker, a bulkhead in front of a hanging server (2 reach it, 4 refused), connection refused with a budget (37) |
| `wrap.test.ts` | order of execution, the caller's signal reaches the operation, a caller abort through 4 layers, a timeout deep inside aborts the operation's signal; the 4 placement experiments in "Composition"; one event handler for all policies (exact event sequence and names), default names, a throwing handler changes nothing (15) |
| `http-status.test.ts` | the 503 / 504 mapping, Retry-After never 0 (rounding cases), unmapped errors left alone (incl. an upstream 401), the body does not contain the dependency's message; requestSignal: one signal per response, aborts on an early close, not after a finished response (15) |
| `express.test.ts` | real Express 4.21.2 app in front of a real upstream: pass-through (signal not aborted afterwards), hang -> 504, breaker -> 503 + Retry-After without calling the upstream, unmapped errors reach the app's own handler, an upstream 404 / 401 is NOT passed on by Express's default handler, a client disconnect cancels the upstream request, loadShedding (3rd concurrent request 503, slot freed after the response and after a disconnect) (8) |
| `nestjs.test.ts` | real NestJS 10.4.15 app (platform-express): pass-through with `@RequestSignal()`, hang -> 504 and breaker -> 503 + Retry-After through the filter, full bulkhead -> 503, other errors keep Nest's own 500, an upstream 401 not passed on, a client disconnect aborts the signal and cancels the upstream request (6) |

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

**Stage 3 (2026-11-23):** 22 new breaks (W, E, A, H) were all caught at their first run (against the 172 tests of
that moment). After the review fixes (F1-F5) and the load-hardened tests, EVERYTHING was re-run on the final code
against the final 179 tests, from `H:\`: **86 breaks, all caught.** The numbers below are from that final run
(the earlier counts were lower in places only because the newer tests catch more; e.g. B5 is now also caught by the
hanging-probe and throwing-isFailure tests). One check (F3) crashed with an out-of-memory error of the busy machine
during the run, was re-run alone, and is caught.

| # | Break | Failed |
|---|---|---|
| W1 | wrap applies policies in reverse order | 7 |
| W2 | wrap drops the caller's signal | 2 |
| W3 | wrap passes the outer signal instead of each layer's own | 2 |
| E1 | a throwing event handler is not contained | 1 |
| E2 | timeout event not emitted | 1 |
| E3 | retry event ignores the policy name | 1 |
| E4 | give-up event not emitted | 2 |
| E5 | breaker-rejected not emitted when open | 1 |
| E6 | breaker-state not emitted | 1 |
| E7 | bulkhead-rejected not emitted | 2 |
| A1 | requestSignal aborts even after a finished response | 3 |
| A2 | requestSignal listens on the request's close instead of the response's | 2 |
| A3 | requestSignal not cached per response | 1 |
| A4 | the error handler answers unknown errors itself instead of `next()` | 1 |
| A5 | breaker 503 without Retry-After | 8 |
| A6 | Retry-After may be 0 | 1 |
| A7 | timeout mapped to 503 | 3 |
| A8 | loadShedding frees the slot only on finish (not on a disconnect) | 2 |
| A9 | the Nest filter writes no response | 3 |
| A10 | `@RequestSignal()` returns a signal that never aborts | 1 |
| A11 | the error body leaks the dependency's message | 2 |
| H1 | `HttpError` field named `status` again | 3 |
| F1 | policies listen on the shared never-aborting signal again | 1 |
| F2 | a throwing onRetry / onGiveUp is not contained | 1 |
| F3 | a throwing isFailure is not contained | 1 |
| F4 | an Infinity Retry-After is ignored instead of giving up | 1 |
| F5 | a waiter aborted right after the hand-off still runs | 1 |

Earlier breaks on the final code: B1 1, B2 10, B3 2, B4 7, B5 14, B6 3, B7 1, B8 4, B9 2, B10 1, B11 2, B12 3,
B13 1, B14 1, B15 4, B16 1, B17 1, B18 1; K1 14, K2 9, K3 3, K4 1, K5 1, K6 1, K7 1, K8 1, K9 3; R1 12, R2 2, R3 1,
R4 4, R5 10, R6 1, R7 2, R8 2, R9 13, R10 3, R11 4, R12 1, R13 4, R14 1, R15 2, R16 1, R17 1, R18 7, R19 4, R20 2,
R21 4, R22 4, R23 1, R24 1, R25 20, R26 1, R27 8, R28 1, R29 3, R30 1, R31 2, R32 1.
The tests that catch A3, A4 and A6 (and one of A1's) were added before this run, after listing what the first
adapter tests did not cover (a unit test for `requestSignal`, a test that unknown errors reach the app's own
handler, Retry-After rounding). Whether those breaks would have survived without them was not checked.

## Overhead, measured against cockatiel (stage 3)

`npm run bench` (`bench/overhead.mjs`): the wrapper cost on a no-op operation (`async () => 1`), one call at a time,
100 000 calls per round after 20 000 warm-up calls, median of 5 rounds. Same settings on both sides (retry 3
attempts, a breaker with a 10 s open time, a bulkhead of 10, a 10 s timeout; cockatiel's cooperative timeout and a
consecutive-failures breaker). This measures the WRAPPER, not resilience behaviour; any real network call costs
far more. Raw results with every round: `bench/reference-results/2026-11-23-win32-run1.json` and `-run2.json`
(the script writes `<date>-<platform>.json` at the very end; the two files were renamed by hand. A first attempt at
run 2 was lost: its output was piped through `Select-Object -First 11` in PowerShell, which stopped node before it
wrote the file -- so the file then still held run 1. Caught by checking the file, re-run without the pipe).

Windows 11 PC, AMD Ryzen 5 4500, Node 20.20.1, cockatiel 3.2.1 -- two runs, ns per call:

| Case | ours (run 1 / run 2) | cockatiel (run 1 / run 2) |
|---|---|---|
| bare call (no policy) | 146 / 131 | -- |
| timeout | 7745 / 8194 | 30413 / 31551 |
| retry | 361 / 353 | 382 / 411 |
| circuit breaker | 229 / 247 | 350 / 370 |
| bulkhead | 229 / 271 | 249 / 252 |
| all four, wrapped | 11356 / 12075 | 35251 / 37269 |

What the numbers say: the timeout is the expensive part for both (an AbortController, a timer and listeners per
call); retry, breaker and bulkhead add a few hundred ns. Ours was about 4x cheaper for the timeout in these runs;
the bulkhead is a tie (run 2 has cockatiel ahead). WHY cockatiel's timeout costs more was not investigated, and
cockatiel does more than this library in places (events, cancellation tokens, more breaker kinds) -- this is a cost
comparison, not a verdict. One machine, two runs.

## Found while writing the interview bank (after stage 3)

Five agents wrote the interview bank from the code; each was asked to report anything that looked wrong. Real
bugs, fixed with a test each (mutations F1-F5 prove each test guards its fix):

| # | Finding | Fix |
|---|---|---|
| F1 | With no caller signal, every policy passed one shared never-aborting signal down, and every concurrent timeout / queued bulkhead call added an abort listener to it: at 11 concurrent calls Node printed `MaxListenersExceededWarning` (no real leak -- the listeners were removed -- but a false alarm in production logs) | one exported `NEVER` signal that the timeout and the bulkhead never listen on; test: 50 concurrent calls, no warning |
| F2 | `onRetry` / `onGiveUp` were not guarded: a throwing logging callback replaced the caller's error or ended the retries | guarded like `onEvent` |
| F3 | a user `isFailure` that throws skipped the recording: a half-open probe never released its slot and the breaker stayed half-open, rejecting every call | a throwing `isFailure` counts as a failure |
| F4 | a 400-digit `Retry-After` parses to Infinity, which the retry IGNORED (retrying on normal backoff) instead of giving up like it does for 3600 | Infinity counts as too long; only NaN is ignored |
| F5 | a queued caller that aborted in the instant after the bulkhead handed it a slot still ran its operation, with an aborted signal | re-check after waking: give the slot on, do not run |

Also from the reviews: a test named "10 000 x 0.1" that checked 50 x 0.1 (renamed); a test named "the body never
contains the dependency's message" that only checked a timeout's number (renamed to what it checks); this README
said "12 outcomes" where the breaker opens on the 10th; "the hanging probe needs a timeout inside" was reasoning
only (now a test in `wrap.test.ts`).

**Flaky under load (fixed in the tests).** With the PC at 100% CPU from other programs, full runs failed 1-3 tests
that pass alone: three relied on tight real-time margins (150 ms and 300 ms timeouts against a real server; the
Express and Nest disconnect tests shared a 200 ms-timeout route, so the timeout could close the upstream request
before the test's client disconnected), one made 30 000 `expect` calls in a loop, and Nest's start-up exceeded
vitest's 5 s hook timeout. Fixed by wider margins (1000 / 1500 ms, a separate long-timeout route for the disconnect
tests), one `expect` over collected violations, and `vitest.config.ts` timeouts of 20 s. After that: 4 of 4 full
runs green, two of them at 100% CPU. The mutation tables above were produced with the hardened tests.

Known and NOT changed:
- `deadlineMs` is soft: it stops a retry from STARTING after the deadline; the total can overshoot by one attempt.
- Reading `breaker.state` is not a pure read: it can move open -> half-open and emit the state-change event.
- The adapters' "headers already sent" branches (Express: `next(error)`, Nest: `res.destroy()`) have no test.
- Error handling relies on `instanceof`. If the library is loaded twice (two copies in node_modules, or the
  lowercase drive path finding above), an open breaker's error would look retryable and the adapters would answer
  500 instead of 503 / 504. There is no `name`-based fallback.
- `isRetryableHttp` treats every non-HttpError as retryable, including a `TypeError` from a bug in your own code
  (fetch's network error is also a `TypeError`), and knows nothing about idempotency: do not retry a non-idempotent
  POST without an idempotency key.
- The bulkhead's 503 always says `Retry-After: 1`.

## NOT implemented (after stage 3)

- The breaker's window is count-based only (no time-based window), and it has no "slow call" rate: put a
  `TimeoutPolicy` inside it so slow calls become failures.
- Anything shared between processes: a budget, a breaker and a bulkhead live in one process's memory. Three API
  replicas have three of each (each replica learns on its own that a dependency is down).
- Hedged requests, adaptive concurrency, fallbacks, caching.
- Overhead measured on one Windows PC only (see "Overhead"); not under concurrency, not on Linux.
- Adapters: NestJS only on platform-express (not Fastify); no Express 5 test (written against Node's http types,
  which Express 5 also uses, but not run here); no adapter for other frameworks (Koa, Hono).
- `@nestjs/platform-express` 10.x (a test-only dev dependency) pulls in multer 1.x, which npm reports as deprecated
  with known vulnerabilities; nothing here uses multer and none of it is shipped.
- Not published to npm; use it from this repo (copy or a local path dependency; the `exports` map lists
  `resilience-kit`, `resilience-kit/express` and `resilience-kit/nestjs`).

## Run it

```bash
cd projects/18-resilience
npm ci
npm test
npm run build   # dist/
npm run bench   # overhead vs cockatiel, writes bench/reference-results/<date>-<platform>.json
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
| `src/errors.ts` | `TimeoutError`, `BrokenCircuitError`, `BulkheadRejectedError`, `ClientClosedError` |
| `src/http.ts` | `parseRetryAfter`, `HttpError` (`upstreamStatus`), `isRetryableHttp` |
| `src/wrap.ts` | `wrap` (composition, outermost first) |
| `src/events.ts` | `ResilienceEvent`, `emit` |
| `src/adapters/http-status.ts` | `mapResilienceError` (503 / 504 mapping shared by both adapters) |
| `src/adapters/express.ts` | `requestSignal`, `resilienceErrorHandler`, `loadShedding` |
| `src/adapters/nestjs.ts` | `@RequestSignal()`, `ResilienceExceptionFilter` |
| `bench/overhead.mjs` | per-call overhead vs cockatiel; results in `bench/reference-results/` |
