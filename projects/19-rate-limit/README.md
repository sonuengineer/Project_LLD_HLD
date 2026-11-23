# ratelimit-kit (build your own)

Rate limiting for any Node app: a **token bucket** (bursts up to a capacity, then a steady rate) and a **sliding
window counter** (about N per window), either in memory (one process) or **atomically in Redis** with Lua, so any
number of app instances share one limit. You pass your own Redis client; the package has no runtime dependency.
The Lua scripts are project 1's (`projects/01-rate-limiter`), reused unchanged.

Status (2026-11-23): **stage 1 done** -- 39 tests pass (Windows, Node 20), 9 of them against a real Redis 7
(the repo's `infra/docker-compose.yml` Redis); mutation checks below. Stage 2 (Express / NestJS adapters, headers)
and stage 3 (Redis-down behaviour, multi-instance load test, interview bank) are planned in [PLAN.md](PLAN.md),
not built.

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

`npm test` -- 39 tests in `test/`. The Redis tests need Redis at `127.0.0.1:56379` (`docker compose -f
infra/docker-compose.yml up -d redis`) or `REDIS_URL`; without it they are SKIPPED with a printed notice, never
silently passed. All numbers below are from runs WITH Redis.

| File | Proves |
|---|---|
| `algorithms.test.ts` | token bucket: burst then exact retry, lazy refill (half a token is not enough), never above capacity, multi-unit cost and a denial taking nothing, clock backwards neither adds nor removes tokens, independent keys, invalid options; sliding window: limit per window, the previous window weighted (7.5 of 10 at 25%; retry 3000 ms), two windows back no longer count, denied requests not counted (incl. 1 ms before the window ends), invalid options; luaToString (17) |
| `limiter.test.ts` | prefixes, validation before the store is touched (empty key, 513 chars, cost 0 / 1.5 / above the limit), the 512 / cost = limit boundaries; MemoryStore LRU eviction (and that it resets the dropped client), a day-idle key equals a fresh one, 100 000 keys bounded to 1000, invalid maxKeys (13) |
| `redis.test.ts` | real Redis: parity over 3 seeds x 200 steps for each algorithm, atomicity (3 clients, 300 requests, capacity 50 -> exactly 50; sliding window 200 -> exactly 40), Redis TIME by default and a key expiry set, NOSCRIPT after `SCRIPT FLUSH`, other errors not retried, the empty time argument without a clock, an unexpected reply rejected (9) |

### Mutation checks (2026-11-23)

One deliberate bug at a time, full suite with Redis, reverted (runner kept outside the repo, started from `H:\`).

24 breaks; **23 caught**, 1 equivalent (cannot be caught by design). One earlier break, M3 (the memory store ignores its expiry), survived the first run and showed the expiry check was redundant -- it was removed (see MemoryStore); L3 survived the first run and got a sharper test (a partly full bucket).

| # | Break | Failed |
|---|---|---|
| L1 | stored tokens not rounded like Lua tostring | 1 |
| L2 | refill not capped at capacity | 3 |
| L3 | a clock going backwards changes tokens | 1 |
| L4 | needs MORE than cost tokens | 6 |
| L5 | retry rounded down | 1 |
| L6 | a new bucket starts empty | 8 |
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
| R1 | NOSCRIPT not handled | 3 |
| R2 | every error retried as if NOSCRIPT | 1 |
| R3 | reply shape not checked | 1 |
| R4 | always sends the app's clock instead of Redis TIME | 1 |
| U1 | Lua: refill not capped | 1 |
| U2 | Lua: denied request still counted in the sliding window | 1 |
| U3 | Lua: no expiry on the token bucket key | 1 |

S6 is EQUIVALENT: both candidates for the retry are already >= 1 ms (`elapsed < window`, `needed > 0`), so `max(retry, 1)` never changes the value; it is kept to mirror the Lua script. U1-U3 break the Lua script itself (not the TypeScript): the parity, expiry and atomicity tests against the real Redis catch them. Caught by exactly one test (deleting it would hide them): L1, L3, L5, M2, Q2, Q3, R2, R3, R4, U1, U2, U3.

## NOT implemented (after stage 1)

- Express / NestJS adapters and the standard `RateLimit-*` / `Retry-After` headers (stage 2).
- Behaviour when Redis is down (stage 3): today the error from the Redis client reaches the caller; whether to fail
  open or closed is the app's decision for now.
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
| `scripts/copy-lua.mjs` | copies the Lua scripts into `dist/` on build |
