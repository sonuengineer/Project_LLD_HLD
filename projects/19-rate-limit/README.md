# ratelimit-kit (build your own)

Rate limiting for any Node app: a **token bucket** (bursts up to a capacity, then a steady rate) and a **sliding
window counter** (about N per window), either in memory (one process) or **atomically in Redis** with Lua, so any
number of app instances share one limit. You pass your own Redis client; the package has no runtime dependency.
The Lua scripts are project 1's (`projects/01-rate-limiter`), reused unchanged.

Status (2026-11-23): **stages 1-3 done** -- 90 tests pass (Windows, Node 20), 10 of them against a real Redis 7
(the repo's `infra/docker-compose.yml` Redis), including two Express instances sharing one limit through Redis;
Express middleware and a NestJS decorator tested with real apps; Redis-down behaviour (failover, fail open / closed)
tested with a real client on a dead port; a load test across 3 instances (correctness held; throughput NOT validly
measurable on this busy PC); 51 mutation checks: 49 caught, 2 equivalent.

## In an Express or NestJS app (stage 2)

```ts
// Express -- ratelimit-kit/express (Node http types only: Express 4 and 5; tested with 4.21.2)
import { keyByIp, rateLimit } from "ratelimit-kit/express";

app.use("/api", rateLimit(apiLimit, { key: keyByIp({ trustedProxies: 1 }) })); // behind ONE nginx / load balancer
app.post("/login", express.json(), rateLimit(loginLimit, { key: (req) => `email:${req.body?.email?.toLowerCase()}` }), login);

// NestJS -- ratelimit-kit/nestjs (platform-express; @nestjs/common is an optional peer dependency; tested with 10.4.15)
import { RateLimit } from "ratelimit-kit/nestjs";

@Controller("auth")
export class AuthController {
  @Post("login")
  @RateLimit(loginIpLimit)                                                    // per IP
  @RateLimit(loginUserLimit, { key: (req) => `email:${(req as any).body?.email}` }) // AND per account
  login(@Body() dto: LoginDto) { /* ... */ }
}
```

- Every limited response carries `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset` (seconds, rounded
  up; the names of the IETF "RateLimit header fields" draft). A denied request gets **429** with `Retry-After`
  (seconds, at least 1) and `{"error":"rate_limited",...}`; the route / handler does not run. `headers: false` keeps
  the headers off allowed responses (the 429 always has them).
- `key` returns `undefined` -> this limiter does not apply (a per-user limit on an anonymous request). Stacked
  limiters all apply; the first denial wins.
- `cost(req)` -> units per request (a bulk endpoint can cost 5).
- A store error (Redis down) or a throwing key function goes to Express's `next(err)` / Nest's exception layer; the
  route does not run. Choosing fail-open vs fail-closed per limit is stage 3.
- NestJS: `@RateLimit` attaches a guard INSTANCE that holds its limiter (no dependency injection); on a controller
  it is one limit shared by all its routes.

**Who is the client? (`keyByIp`, `clientIp`, `ipKey`)** -- the part that decides whether the limit can be bypassed:
- `X-Forwarded-For` is written by every hop INCLUDING the client. Trusting its left-most entry lets anyone send a
  fake address per request and never be limited. Default `trustedProxies: 0`: the header is ignored, the socket
  address is the client (tested: 5 requests with 5 forged addresses -> 2 allowed, 3 denied).
- Behind your own proxies, `trustedProxies: n` takes the n-th entry from the RIGHT (the ones your proxies appended);
  with fewer entries than n, the left-most available (like Express's `trust proxy` = n).
- IPv4-mapped IPv6 (`::ffff:1.2.3.4`) is the same client as `1.2.3.4`. IPv6 is keyed per **/64**: one subscriber
  usually controls a whole /64 and could otherwise rotate addresses for a fresh limit each time. A zone id
  (`fe80::1%eth0`) is dropped. Not an IP -> `undefined` (not limited by IP).

## Use it

```ts
import { Redis } from "ioredis";
import { ioredisClient, MemoryStore, RateLimiter, RedisStore, slidingWindow, tokenBucket } from "ratelimit-kit";

// One limiter per limit; the prefix keeps different limits apart.
const loginLimit = new RateLimiter({
  algorithm: slidingWindow({ limit: 5, windowMs: 15 * 60_000 }), // 5 tries per 15 minutes
  store: new RedisStore(ioredisClient(new Redis(process.env.REDIS_URL!))), // shared by every app instance
  prefix: "rl:login:",
});
const apiLimit = new RateLimiter({
  algorithm: tokenBucket({ capacity: 20, refillPerSec: 5 }), // bursts of 20, then 5/s
  store: new MemoryStore(), // single instance / dev
  prefix: "rl:api:",
});

const d = await loginLimit.consume(`email:${email.toLowerCase()}`);
if (!d.allowed) {
  // stage 2 will set these headers for you
  res.setHeader("Retry-After", String(Math.ceil(d.retryAfterMs / 1000)));
  return res.status(429).json({ error: "too_many_attempts" });
}
```

`consume(key, cost = 1)` returns a `Decision`: `allowed`, `limit`, `remaining` (whole units left), `retryAfterMs`
(0 when allowed; else when this cost would be allowed), `resetMs` (until full again / until the window ends).

node-redis instead of ioredis: `new RedisStore({ evalsha: (sha, keys, args) => client.evalSha(sha, { keys,
arguments: args }), scriptLoad: (s) => client.scriptLoad(s) })` (not tested here; ioredis is).

## When Redis is down (stage 3)

Two decisions: what to do INSTEAD of Redis, and what to do if there is nothing.

```ts
import { CircuitBreaker, TimeoutPolicy, wrap } from "resilience-kit"; // projects/18-resilience (optional)

const store = new FailoverStore(new RedisStore(ioredisClient(redis)), {
  guard: wrap(new CircuitBreaker({ openMs: 10_000 }), new TimeoutPolicy({ ms: 50 })), // anything with execute()
  fallback: new MemoryStore(),             // while Redis is down: each instance limits on its own
  onError: (e) => logger.warn({ err: e }, "rate-limit store failed"),
});

app.use("/api", rateLimit(apiLimit, { onStoreError: "allow" }));   // capacity limit: fail OPEN
app.post("/login", rateLimit(loginLimit, { onStoreError: "deny" }), login); // security limit: fail CLOSED
```

- **`guard`**: any object with resilience-kit's `execute(op, signal)` shape (structural -- this package does not
  import resilience-kit). The timeout is what keeps a HANGING Redis (partition, overload) from hanging every request:
  a test with a never-answering store gets the fallback's answer after the 100 ms timeout. The circuit breaker
  skips Redis at once while it is known to be down: a test with a dead store and a breaker of 3 calls made 10 checks
  and called the dead store only 3 times. The Redis call itself cannot be cancelled (clients take no AbortSignal) --
  the timeout stops WAITING for it.
- **`fallback`** (usually a `MemoryStore`): decisions are marked `degraded: true`. Weaker -- N instances allow up
  to N x the limit -- but still a limit; tested with a real ioredis client pointed at a closed port: capacity 2 ->
  200, 200, 429. Its own failure is reported, not hidden.
- **No fallback, or it fails too** -> `StoreUnavailableError`, and the adapters' **`onStoreError`** decides:
  - `"error"` (default): the framework's error handling (Express `next(err)`, Nest's exception layer -> 500).
  - `"allow"` (fail OPEN): the request goes through, unlimited, without `RateLimit-*` headers. For limits that
    protect capacity, where refusing everyone is worse than briefly not limiting.
  - `"deny"` (fail CLOSED): **503** with `Retry-After: 5` and `{"error":"rate_limit_unavailable"}`. For limits that
    protect SECURITY (login, OTP, password reset): an attacker must not get unlimited guesses because Redis is down.
    503, not 429: the server has the problem, not the client.
- A `RateLimitError` (bad key / cost -- a bug) is NEVER failed open: it reaches the error handler even with
  `"allow"` (tested for Express and Nest).

## Load test (stage 3) -- correctness held, throughput not measurable on this PC

`bench/load.mjs`: 3 Express instances as separate Node processes, all limiting against one Redis; the client
spreads requests round-robin over them with 32 concurrent connections. Raw results:
`bench/reference-results/2026-11-23-win32-load-run1.json` and `-run2.json` (Windows 11, Ryzen 5 4500, Node
20.20.1, Redis 7 in Docker on the same PC).

**Correctness under load (run 1):** one shared key, sliding window limit 500, all 3 instances -> **exactly 500
allowed**, 503 denied, nothing else. The same with MemoryStore (each instance counting alone): 1116 allowed, 0
denied -- the "N instances, up to N x the limit" warning, measured. Run 2 sent only 410 requests to the shared key
in its 3 seconds (the PC was slower), so it never reached the limit and proves nothing about the cap. The
deterministic test (two Express instances, one Redis, 30 concurrent requests -> exactly 10 of 10) covers the same
property on every `npm test`.

**Throughput: NOT a valid measurement.** The PC's CPU was at 90% (run 1) and 100% (run 2) from other programs, and
the numbers show it: in both runs "no limiter" came out SLOWER than "with a limiter" (run 1: 348 vs 490 req/s;
run 2: 161 vs 256 req/s), which cannot be a real effect. They are kept in the JSON files, but no conclusion is drawn
from them; a clean measurement needs an idle machine or a separate load-generator host.

## The two algorithms

**Token bucket** `tokenBucket({ capacity, refillPerSec })` -- `src/lua/token_bucket.lua`
- A new key starts full. Tokens refill lazily (computed from the elapsed time; no timer). A request of `cost`
  takes `cost` tokens if there are that many, otherwise it is denied and takes none.
- `retryAfterMs` = time until `cost` tokens are there (rounded UP). A clock going backwards neither adds nor
  removes tokens.
- Redis key: one hash per client, expiring after `capacity / refillPerSec` + 1 s of silence (by then it is full
  anyway).

**Sliding window counter** `slidingWindow({ limit, windowMs })` -- `src/lua/sliding_counter.lua`
- estimate = this window's count + the previous window's count x the share of the previous window still inside the
  sliding window. Approximate: exact only if the previous window's requests were spread evenly; O(1) memory per
  client (two counters), unlike a sliding LOG.
- A denied request is not counted. `retryAfterMs` = the earlier of "the window ends" and "enough of the previous
  window has slid out".

## Stores

**RedisStore(client, { now? })**
- The whole read-decide-write runs as ONE Lua script, so it is atomic: 3 separate clients sending 300 concurrent
  requests at a capacity of 50 get exactly 50 allowed (test).
- `EVALSHA` first; if Redis answers `NOSCRIPT` (restart, `SCRIPT FLUSH`, failover) the script is loaded and the
  call retried once. Any other error (e.g. `READONLY` from a replica) is passed through, not retried (tests).
- Time: by default the script reads **Redis's own clock** (`TIME`), so app servers whose clocks drift still agree;
  the store sends an empty time argument for that (tested). Tests inject a clock.
- An unexpected reply shape is an error, never a guessed decision.

**MemoryStore({ maxKeys = 100 000, now? })**
- One process only: N instances each with their own MemoryStore allow up to N x the limit.
- At most `maxKeys` keys (least recently used dropped first): keys often come from clients (IPs), and an unbounded
  map is a memory attack. Dropping a key RESETS that client's limit -- the trade-off for bounded memory. 100 000
  distinct keys with `maxKeys: 1000` leave exactly 1000 (test).
- No per-key expiry: both algorithms already treat long-idle state like no state (tested: a day-idle key answers
  exactly like a fresh one). An expiry check was in the first version; mutation M3 showed it changed no decision,
  so it was removed.

**RateLimiter({ algorithm, store, prefix = "rl:" })** -- validates before touching the store: non-empty key of at
most 512 characters, integer cost >= 1, and a cost above the limit is an ERROR (it could never be allowed; a
denial with a retry time would be a lie).

## Parity: the TypeScript and the Lua versions must agree

Each algorithm is written twice -- `step()` in TypeScript (memory store) and the Lua script (Redis). If they
differed, moving from memory (dev, tests) to Redis (production) would silently change behaviour. `test/redis.test.ts`
runs the same seeded random sequence (time jumps, 3 keys, costs 1-3) through both and requires IDENTICAL decisions:
600 steps per algorithm, both outcomes (allowed and denied) exercised.

Two precision details make this hold:
- Redis's Lua stores the token count with `tostring()`, which keeps **14 significant digits** (`%.14g`). The
  TypeScript stores it rounded the same way (`luaToString`); mutation L1 (store full precision) fails the parity
  test.
- But the script computes its REPLY (`remaining`, `resetMs`) from the full-precision variable. The first TypeScript
  version rounded first and replied from the rounded value; the parity test failed at step 91 of seed 1 with
  `resetMs` 1135 vs 1136. Fixed: reply from the full value, store the rounded one.

## What the tests show

`npm test` -- 90 tests in `test/`. The Redis tests need Redis at `127.0.0.1:56379` (`docker compose -f
infra/docker-compose.yml up -d redis`) or `REDIS_URL`; without it they are SKIPPED with a printed notice, never
silently passed. All numbers below are from runs WITH Redis.

| File | Proves |
|---|---|
| `algorithms.test.ts` | token bucket: burst then exact retry, lazy refill (half a token is not enough), never above capacity, multi-unit cost and a denial taking nothing, clock backwards neither adds nor removes tokens, independent keys, invalid options; sliding window: limit per window, the previous window weighted (7.5 of 10 at 25%; retry 3000 ms), two windows back no longer count, denied requests not counted (incl. 1 ms before the window ends), invalid options; luaToString (17) |
| `limiter.test.ts` | prefixes, validation before the store is touched (empty key, 513 chars, cost 0 / 1.5 / above the limit), the 512 / cost = limit boundaries; MemoryStore LRU eviction (and that it resets the dropped client), a day-idle key equals a fresh one, 100 000 keys bounded to 1000, invalid maxKeys (13) |
| `redis.test.ts` | real Redis: parity over 3 seeds x 200 steps for each algorithm, atomicity (3 clients, 300 requests, capacity 50 -> exactly 50; sliding window 200 -> exactly 40), Redis TIME by default and a key expiry set, NOSCRIPT after `SCRIPT FLUSH`, other errors not retried, the empty time argument without a clock, an unexpected reply rejected (9) |
| `ip.test.ts` | clientIp: forged X-Forwarded-For ignored by default, 1 and 2 trusted proxies, repeated headers, fewer entries than proxies, invalid counts; ipKey: IPv4, mapped IPv6 (both cases), /64 grouping incl. leading zeros, `::`, `::1`, zone ids, one /64 = one client, non-IPs; the headers (rounding, Retry-After at least 1) (24) |
| `express.test.ts` | real Express 4 app: limit then 429 with headers and the route not run, forged X-Forwarded-For gives no fresh limit, one trusted proxy, per-user key and `undefined` = not limited, two stacked limiters, cost, `headers: false`, a store error and a throwing key fn reach the error handler; **two Express instances sharing one Redis: 30 concurrent requests over both -> exactly 10 allowed** (10) |
| `nestjs.test.ts` | real NestJS 10 app: headers then 429 with Retry-After and the handler not run, an undecorated route untouched, stacked per-IP + per-user decorators with anonymous skip, a decorator on a controller shared by its routes; store down: allow -> 200, deny -> 503 + Retry-After, default -> 500, a bug -> 500 even with allow (5) |
| `failover.test.ts` | FailoverStore: primary used and not degraded, fallback marked degraded, no fallback -> StoreUnavailableError with the cause, a failing fallback reported, a throwing onError contained; with resilience-kit as the guard: a hanging primary times out (100 ms) to the fallback, an open breaker stops calling the dead primary (3 calls for 10 checks); a real ioredis client on a closed port behind Express: allow -> 200 without headers, deny -> 503 + Retry-After, default -> error handler, with a memory fallback still limited (200, 200, 429), a bug never failed open (12) |

### Mutation checks (2026-11-23)

One deliberate bug at a time, full suite with Redis, reverted (runner kept outside the repo, started from `H:\`).

Final run on the stage 3 code against all 90 tests: 51 breaks (24 stage 1, 15 stage 2, 12 stage 3); **49 caught, 2 equivalent** (cannot be caught by design). From the first stage-1 run: M3 (the memory store ignored its expiry) survived and showed the expiry was redundant -- removed; L3 survived and got a sharper test. Stage 3: all 12 caught at the first run (one Nest test -- a bug is never failed open -- was added before the run, after listing what was not covered).

| # | Break | Failed |
|---|---|---|
| L1 | stored tokens not rounded like Lua tostring | 1 |
| L2 | refill not capped at capacity | 3 |
| L3 | a clock going backwards changes tokens | 1 |
| L4 | needs MORE than cost tokens | 12 |
| L5 | retry rounded down | 1 |
| L6 | a new bucket starts empty | 20 |
| S1 | previous window not weighted | 2 |
| S2 | limit exclusive | 4 |
| S3 | denied requests are counted | 2 |
| S4 | a window two back still counts as previous | 4 |
| S5 | retry ignores the previous window's decay | 2 |
| S6 | retry may be 0 when denied | 0 |
| M1 | memory store never evicts | 2 |
| M2 | memory store does not refresh recency | 1 |
| Q1 | prefix not applied | 5 |
| Q2 | cost above the limit not rejected | 3 |
| Q3 | key length limit off by one | 1 |
| R1 | NOSCRIPT not handled | 2 |
| R2 | every error retried as if NOSCRIPT | 1 |
| R3 | reply shape not checked | 1 |
| R4 | always sends the app's clock instead of Redis TIME | 1 |
| U1 | Lua: refill not capped | 1 |
| U2 | Lua: denied request still counted in the sliding window | 1 |
| U3 | Lua: no expiry on the token bucket key | 1 |
| H1 | client IP from the LEFT-most X-Forwarded-For (client-controlled) | 4 |
| H2 | trusted proxy count off by one | 5 |
| H3 | IPv4-mapped IPv6 not normalised | 3 |
| H4 | IPv6 keyed per full address instead of /64 | 7 |
| H5 | IPv6 zone id not stripped | 0 |
| H6 | Retry-After may be 0 | 1 |
| H7 | RateLimit-Reset rounded down | 1 |
| E1 | express: 429 without headers when headers:false | 1 |
| E2 | express: undefined key not skipped | 1 |
| E3 | express: cost option ignored | 2 |
| E4 | express: store errors swallowed (request hangs) | 4 |
| E5 | express: 403 instead of 429 | 9 |
| N1 | nest: undefined key not skipped | 1 |
| N2 | nest: no headers on the 429 | 1 |
| N3 | nest: 403 instead of 429 | 3 |
| F1 | fallback decisions not marked degraded | 3 |
| F2 | guard ignored (a hanging Redis hangs the request; an open breaker still calls it) | 2 |
| F3 | no fallback: raw error instead of StoreUnavailableError | 1 |
| F4 | a throwing onError is not contained | 1 |
| F5 | a failing fallback's raw error leaks | 1 |
| O1 | express: a bug (RateLimitError) is failed open | 1 |
| O2 | express: fail-closed answers 429 instead of 503 | 1 |
| O3 | express: fail-closed without Retry-After | 1 |
| O4 | express: allow and deny swapped | 2 |
| O5 | nest: fail-closed answers 429 instead of 503 | 1 |
| O6 | nest: allow ignored | 1 |
| O7 | nest: a bug (RateLimitError) is failed open | 1 |

Equivalent: **S6** -- both candidates for the retry are already >= 1 ms (`elapsed < window`, `needed > 0`), so `max(retry, 1)` never changes the value (kept to mirror the Lua). **H5** -- a zone id (`%eth0`) only ever sits in the LAST group of an address and the /64 key keeps the first four, so stripping it never changes a key (kept for clarity). U1-U3 break the Lua script itself; the tests against the real Redis catch them.

## NOT implemented (after stage 3)

- A valid throughput / latency measurement (see "Load test"): needs an idle machine or a separate load generator.
- While degraded, the fallback's counts are per instance and are NOT merged back into Redis when it returns.
- Cancelling an in-flight Redis call (the client APIs take no AbortSignal): a timeout only stops waiting.
- NestJS on Fastify, an Express 5 test, other frameworks (Koa, Hono): not done.
- The combined `RateLimit` / `RateLimit-Policy` fields of newer drafts of the header spec: not sent.
- Not measured: throughput / latency per check (project 1 measured its Lua scripts from Python; not repeated here).
- node-redis adapter: documented, not tested.
- Redis Cluster: NOT tested. The token bucket uses one declared key per client. The sliding window builds two more
  keys inside the script (`<key>:<window start>`) without declaring them in KEYS; in a cluster those can live on
  another node, where Redis refuses access to non-local keys. A hash tag in the key (e.g. `{user42}`) would keep
  them together -- not done or tested here.
- Not published to npm.

## Run it

```bash
docker compose -f infra/docker-compose.yml up -d redis   # from the repo root; 127.0.0.1:56379
cd projects/19-rate-limit
npm ci
npm test
npm run build   # dist/ (copies the Lua scripts next to the JS)
```

## Files

| File | What |
|---|---|
| `src/algorithms.ts` | `tokenBucket`, `slidingWindow` (TypeScript `step` + which Lua file), `luaToString` |
| `src/lua/token_bucket.lua`, `src/lua/sliding_counter.lua` | the Redis scripts (from project 1) |
| `src/memory-store.ts` | `MemoryStore` |
| `src/redis-store.ts` | `RedisStore`, `RedisScriptClient`, `ioredisClient` |
| `src/limiter.ts` | `RateLimiter`, `Store` |
| `src/types.ts` | `Decision`, `Algorithm`, `RateLimitError` |
| `src/failover-store.ts` | `FailoverStore`, `Guard` (stage 3) |
| `src/adapters/http.ts` | `clientIp`, `ipKey`, `keyByIp`, `rateLimitHeaders`, `OnStoreError` (shared by both adapters) |
| `bench/load.mjs` | load test: 3 instances on one Redis; results in `bench/reference-results/` |
| `src/adapters/express.ts` | `rateLimit` middleware (`ratelimit-kit/express`) |
| `src/adapters/nestjs.ts` | `@RateLimit`, `RateLimitGuard` (`ratelimit-kit/nestjs`) |
| `scripts/copy-lua.mjs` | copies the Lua scripts into `dist/` on build |
