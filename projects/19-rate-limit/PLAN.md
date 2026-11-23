# A20 (build your own) -- ratelimit-kit: plan

Status (2026-11-23): stage 1 DONE (token bucket + sliding window counter, in memory and atomically in Redis via Lua,
bring-your-own Redis client; parity between the TypeScript and the Lua versions tested against a real Redis).
Stage 2 DONE (Express middleware, NestJS decorator, safe client-IP extraction, headers; real apps; two Express
instances sharing one Redis limit). Stage 3 DONE in code (FailoverStore with a guard + memory fallback, fail open /
closed per limit, load test across 3 instances; 91 tests; 51 mutation checks, 49 caught, 2 equivalent); its
interview bank and portfolio page follow.

## Why this project

Project 1 (`projects/01-rate-limiter`) built five rate-limiting algorithms as Redis Lua scripts inside a Python
service. This turns the two most useful ones into a TypeScript library that any Node app can use (Express, NestJS,
workers): the inbound half of the toolkit, next to `projects/18-resilience` for outbound calls.

## Decisions (one recommendation each)

- **Two algorithms, not five.** Token bucket (bursts up to a capacity, then a steady rate -- most API limits) and
  sliding window counter (about N per window, smooth at window edges -- login / OTP style limits). Fixed window,
  sliding log and leaky bucket stay in project 1: fixed window has the edge burst, sliding log needs memory per
  request, leaky bucket is a queue, not a limiter.
- **Reuse project 1's Lua unchanged** (copied with a provenance line). They were already tested there with 3
  replicas; changing them would lose that.
- **Every algorithm exists twice: TypeScript `step()` for the memory store and Lua for Redis -- and a parity test
  proves they agree** on hundreds of random steps against a real Redis. Recommended over "memory store = a
  different, simpler implementation": then switching from memory (tests, dev) to Redis (production) would change
  behaviour silently. The parity test caught one precision bug in the first version (see README).
- **Bring your own Redis client** through a two-method interface (`evalsha`, `scriptLoad`); an adapter for ioredis
  is included, node-redis is a three-line adapter. No runtime dependency, and the app keeps one Redis connection
  pool.
- **EVALSHA with a NOSCRIPT fallback**, not EVAL every time: the script body is sent once per Redis restart, not on
  every request.
- **Redis's own clock by default.** App servers' clocks drift; the script reads Redis TIME so every instance agrees.
  A test clock can be injected.
- **Memory store bounded by `maxKeys` (LRU), no per-key expiry.** Keys come from clients (IPs), so unbounded maps
  are a memory attack; dropping a key resets that client (documented trade-off). Expiry was removed after a
  mutation check showed it changed no decision.
- **A cost above the limit is an error**, not a denial with a retry time that can never work.
- **Stage 2: X-Forwarded-For is ignored unless you say how many proxies you trust**, and then read from the right.
  The left-most entry is client-controlled; trusting it makes every limit bypassable. IPv6 keyed per /64.
- **Stage 2: the NestJS decorator attaches a guard instance** (`UseGuards(new RateLimitGuard(limiter))`), so it
  needs no DI and no decorator metadata; stacking several decorators stacks guards.
- **Stage 3: failover is a Store wrapper, not adapter logic.** `FailoverStore(primary, { guard, fallback })` keeps
  "what instead of Redis" in one place for every framework; the adapters only decide what a request gets when there
  is nothing (`onStoreError`).
- **Stage 3: the guard is structural** (`execute(op, signal)`), so resilience-kit's breaker and timeout plug in with
  no dependency between the packages.
- **Stage 3: fail open vs fail closed is chosen PER LIMIT** (capacity limits open, security limits closed), and a
  bug (RateLimitError) is never failed open. Fail closed answers 503, not 429.
- **Stage 3: the load test's throughput numbers are not published as results**: the PC was at 90-100% CPU from
  other programs and "no limiter" came out slower than "limiter". Only the correctness result (exactly the limit
  across 3 instances) is claimed.
- **Stage 2: adapters are separate entry points** written against Node's http types (Express not imported at
  runtime); same layout as resilience-kit.

## Stages

| Stage | What | Status |
|---|---|---|
| 1 | Algorithms (TypeScript + Lua), MemoryStore, RedisStore (EVALSHA, NOSCRIPT, Redis TIME), RateLimiter (prefix, validation), parity + atomicity tests against a real Redis | DONE 2026-11-23 |
| 2 | Express middleware and NestJS `@RateLimit()` decorator; key strategies (IP behind a proxy, IPv6 /64, user id, skip); `RateLimit-*` and `Retry-After` headers; tested with real apps and two Express instances on one Redis | DONE 2026-11-23 |
| 3 | Redis down: FailoverStore (guard = resilience-kit breaker + timeout, memory fallback, degraded decisions), fail open / closed per limit; a load test across 3 app instances on one Redis; interview bank; portfolio page | code DONE 2026-11-23; bank + portfolio in progress |

## Not in scope

Distributed limits without Redis (gossip), quotas over days with billing, per-tenant configuration storage.
