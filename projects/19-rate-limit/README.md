# ratelimit-kit (build your own)

Rate limiting for any Node app: a **token bucket** (bursts up to a capacity, then a steady rate) and a **sliding
window counter** (about N per window), either in memory (one process) or **atomically in Redis** with Lua, so any
number of app instances share one limit. You pass your own Redis client; the package has no runtime dependency.
The Lua scripts are project 1's (`projects/01-rate-limiter`), reused unchanged.

Status (2026-11-23): **stages 1 and 2 done** -- 77 tests pass (Windows, Node 20), 10 of them against a real
Redis 7 (the repo's `infra/docker-compose.yml` Redis), including two Express instances sharing one limit through
Redis; Express middleware and a NestJS decorator tested with real apps; mutation checks below. Stage 3 (Redis-down
behaviour, a load test, interview bank) is planned in [PLAN.md](PLAN.md), not built.

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

`npm test` -- 77 tests in `test/`. The Redis tests need Redis at `127.0.0.1:56379` (`docker compose -f
infra/docker-compose.yml up -d redis`) or `REDIS_URL`; without it they are SKIPPED with a printed notice, never
silently passed. All numbers below are from runs WITH Redis.

| File | Proves |
|---|---|
| `algorithms.test.ts` | token bucket: burst then exact retry, lazy refill (half a token is not enough), never above capacity, multi-unit cost and a denial taking nothing, clock backwards neither adds nor removes tokens, independent keys, invalid options; sliding window: limit per window, the previous window weighted (7.5 of 10 at 25%; retry 3000 ms), two windows back no longer count, denied requests not counted (incl. 1 ms before the window ends), invalid options; luaToString (17) |
| `limiter.test.ts` | prefixes, validation before the store is touched (empty key, 513 chars, cost 0 / 1.5 / above the limit), the 512 / cost = limit boundaries; MemoryStore LRU eviction (and that it resets the dropped client), a day-idle key equals a fresh one, 100 000 keys bounded to 1000, invalid maxKeys (13) |
| `redis.test.ts` | real Redis: parity over 3 seeds x 200 steps for each algorithm, atomicity (3 clients, 300 requests, capacity 50 -> exactly 50; sliding window 200 -> exactly 40), Redis TIME by default and a key expiry set, NOSCRIPT after `SCRIPT FLUSH`, other errors not retried, the empty time argument without a clock, an unexpected reply rejected (9) |
| `ip.test.ts` | clientIp: forged X-Forwarded-For ignored by default, 1 and 2 trusted proxies, repeated headers, fewer entries than proxies, invalid counts; ipKey: IPv4, mapped IPv6 (both cases), /64 grouping incl. leading zeros, `::`, `::1`, zone ids, one /64 = one client, non-IPs; the headers (rounding, Retry-After at least 1) (24) |
| `express.test.ts` | real Express 4 app: limit then 429 with headers and the route not run, forged X-Forwarded-For gives no fresh limit, one trusted proxy, per-user key and `undefined` = not limited, two stacked limiters, cost, `headers: false`, a store error and a throwing key fn reach the error handler; **two Express instances sharing one Redis: 30 concurrent requests over both -> exactly 10 allowed** (10) |
| `nestjs.test.ts` | real NestJS 10 app: headers then 429 with Retry-After and the handler not run, an undecorated route untouched, stacked per-IP + per-user decorators with anonymous skip, a decorator on a controller shared by its routes (4) |

### Mutation checks (2026-11-23)

One deliberate bug at a time, full suite with Redis, reverted (runner kept outside the repo, started from `H:\`).

Run on the stage 2 code against all 77 tests: 39 breaks (24 stage-1 + 15 adapter); **37 caught, 2 equivalent** (cannot be caught by design). From the first stage-1 run: M3 (the memory store ignored its expiry) survived and showed the expiry was redundant -- removed; L3 survived and got a sharper test.

| # | Break | Failed |
|---|---|---|
| L1 | stored tokens not rounded like Lua tostring | 1 |
| L2 | refill not capped at capacity | 3 |
| L3 | a clock going backwards changes tokens | 1 |
| L4 | needs MORE than cost tokens | 12 |
| L5 | retry rounded down | 1 |
| L6 | a new bucket starts empty | 18 |
| S1 | previous window not weighted | 2 |
| S2 | limit exclusive | 4 |
| S3 | denied requests are counted | 2 |
| S4 | a window two back still counts as previous | 4 |
| S5 | retry ignores the previous window's decay | 2 |
| S6 | retry may be 0 when denied | 0 |
| M1 | memory store never evicts | 2 |
| M2 | memory store does not refresh recency | 1 |
| Q1 | prefix not applied | 5 |
| Q2 | cost above the limit not rejected | 1 |
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
| E3 | express: cost option ignored | 1 |
| E4 | express: store errors swallowed (request hangs) | 2 |
| E5 | express: 403 instead of 429 | 8 |
| N1 | nest: undefined key not skipped | 1 |
| N2 | nest: no headers on the 429 | 1 |
| N3 | nest: 403 instead of 429 | 3 |

Equivalent: **S6** -- both candidates for the retry are already >= 1 ms (`elapsed < window`, `needed > 0`), so `max(retry, 1)` never changes the value (kept to mirror the Lua). **H5** -- a zone id (`%eth0`) only ever sits in the LAST group of an address and the /64 key keeps the first four, so stripping it never changes a key (kept for clarity). U1-U3 break the Lua script itself; the tests against the real Redis catch them.

## NOT implemented (after stage 2)

- Behaviour when Redis is down (stage 3): today the error reaches the framework's error handling; whether to fail
  open or closed is the app's decision for now.
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
| `src/adapters/http.ts` | `clientIp`, `ipKey`, `keyByIp`, `rateLimitHeaders` (shared by both adapters) |
| `src/adapters/express.ts` | `rateLimit` middleware (`ratelimit-kit/express`) |
| `src/adapters/nestjs.ts` | `@RateLimit`, `RateLimitGuard` (`ratelimit-kit/nestjs`) |
| `scripts/copy-lua.mjs` | copies the Lua scripts into `dist/` on build |
