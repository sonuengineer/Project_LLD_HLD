# cache-kit (build your own)

A small TypeScript library for an in-process cache in front of ANY expensive call -- a DB query, an HTTP call to
another service, a config lookup. An LRU bounded by entries and optionally by weight (bytes), TTL with lazy expiry
and an optional background sweep, and single-flight loading: when 100 requests miss the same key at once, the loader
runs ONCE (no cache stampede). Stage 2 adds stale-while-revalidate (serve the old value at once while ONE background
load refreshes it), negative caching ("not found" cached for a short separate TTL) and an optional Redis L2 shared
by app replicas, with invalidation between them over pub/sub. It imports no framework, so the same code runs in an
Express handler, a NestJS service, a worker or a script. No runtime dependencies (bring your own Redis client).

Status (2026-11-23): **stage 2 done** -- 151 tests pass (Windows, Node 20, 3 runs in a row; the 8 real-Redis
tests ran against Redis 7.4.12 each time), including the randomized model test extended to stale-while-revalidate
and negative caching; 99 deliberate breaks over stages 1 and 2, every one that changes behaviour caught, the same 3
equivalent ones as stage 1 explained (see "Mutation checks"). The real-Redis test found a cross-replica race, fixed
with SET NX + tombstones (see `TwoLevelCache`). Per-operation cost measured on one PC for stage 1 only (see
"Overhead"). **Stage 3 done**: Express and NestJS helpers (cache a route's JSON or a service method) tested with
real apps -- 178 tests in total; 20 stage-3 breaks, all caught (3 only after unit tests for the "client already
gone" paths were added; 3 more guard fixes from the interview-bank review). Not published to npm.

## In an Express or NestJS app (stage 3)

The helpers cache the **data** a handler produces, not the HTTP bytes (replaying intercepted writes is fragile:
streaming, headers, status codes). Both work with an `LruCache<string, V>` or a `TwoLevelCache<V>`.

```ts
// Express -- cache-kit/express (Node http types only; tested with Express 4.21.2)
import { cachedJson } from "cache-kit/express";

app.get("/products/:id", cachedJson(productCache,
  { key: (req) => `product:${req.params.id}`, ttlMs: 60_000 },
  (req, signal) => db.products.find(req.params.id, { signal })));

// NestJS -- cache-kit/nestjs (platform-express; @nestjs/common and rxjs are optional peer dependencies)
import { Cached, CachedRoute } from "cache-kit/nestjs";

@Get(":id")
@CachedRoute(productCache, { key: (req) => `product:${(req as any).params.id}` })
find(@Param("id") id: string) { return this.products.find(id); }   // runs only on a miss

class ProductService {                                              // or cache the service method
  @Cached(productCache, { key: (id: string) => `product:${id}`, ttlMs: 60_000 })
  async find(id: string) { return db.products.find(id); }
}
```

- `X-Cache: hit | stale | miss | bypass` on every response. "hit" = this request did not run the producer (from
  the cache, from Redis, or from a load another request started); "stale" = a stale value was served at once while
  this request's background refresh ran the producer (stale-while-revalidate); "miss" = it waited for the producer
  it ran; "bypass" = the key function returned `undefined`. The first version had no "stale": a stale serve was
  labelled "miss", because the refresh calls the loader synchronously -- found by a reviewer while writing the
  interview bank, fixed with a test (mutation C7). With `TwoLevelCache`, a stale serve whose refresh is answered by
  Redis (no producer run) shows "hit".
- **The key is required and must contain everything the producer reads** -- with coalescing, ONLY THE FIRST
  request's producer runs, and every request with the same key gets its result. Per-user data needs the user in
  the key (tested: alice, bob, alice -> miss, miss, hit with alice's own data). `@Cached` runs the method with the
  first caller's `this` and arguments, so the key must capture instance differences too: the key function is called
  with the instance as `this` -- `key: function (this: Tenant) { return \`config:${this.name}\`; }` (tested; an
  arrow function cannot see `this`, and a test shows that wrong key on purpose: tenant b gets tenant a's config).
  The first version called the key without `this`, so instance state could not be in the key at all (found by a
  reviewer; fixed, mutation D5). `@Cached` always returns a promise: a synchronous throw becomes a rejection (D6).
- 20 concurrent requests for one key run the producer once (tested). A null / undefined result is answered 404 and
  is cached like any value (negative caching applies if the cache has it); `notFound` changes the rule.
- A producer error is not cached (cache-kit never caches errors): Express `next(err)` / Nest's exception layer,
  and the next request runs the producer again.
- The request's disconnect signal is passed to `getOrLoad`: a client that goes stops waiting; when EVERY client
  waiting for a load has gone, the load's own signal is aborted (pass it to your DB driver / fetch). Express: nothing
  is written to, and `next(err)` is not called for, a client that has gone. NestJS: not special-cased -- the aborted
  wait goes to Nest's exception layer (a write to a closed connection, a no-op), and a Nest handler gets no abort
  signal.
- `@Cached` is framework-free (a legacy TypeScript method decorator, the kind NestJS uses; needs
  `experimentalDecorators`). A method gets no AbortSignal, so a caller cannot abandon the shared call.
- Two Express instances sharing a `TwoLevelCache` over one real Redis: A loads, B answers from Redis without
  running its producer (tested).

## Use it

```ts
import { LruCache, type CacheEvent } from "cache-kit";

// One cache per KIND of data, created once (module level / a singleton service), shared by every request.
// (Illustrative: `db` and `logger` are your app's.)
const users = new LruCache<string, User | null>({
  maxEntries: 10_000,
  maxWeight: 50 * 1024 * 1024, // ~50 MB of JSON
  weigh: (u) => Buffer.byteLength(JSON.stringify(u)),
  ttlMs: 60_000,
  sweepIntervalMs: 30_000, // optional: frees expired entries nobody reads; unref'd, stop with users.close()
  onEvent: (e: CacheEvent<string>) => { if (e.type === "load-error") logger.warn({ key: e.key, err: e.error }); },
});

export function getUser(id: string, signal?: AbortSignal) {
  // 100 concurrent requests for a cold id -> ONE query; all 100 get its result.
  return users.getOrLoad(id, (loadSignal) => db.users.findById(id, { signal: loadSignal }), { signal });
}

export async function updateUser(id: string, patch: Partial<User>) {
  await db.users.update(id, patch);
  users.delete(id); // also stops a load already running for this id from writing the OLD row back
}

// metrics endpoint
app.get("/metrics/cache", (_req, res) => res.json(users.stats()));
```

In Express, pass a signal that aborts when the client disconnects (for example `requestSignal(req, res)` from
projects/18-resilience) as `signal`: that caller stops waiting, and the query itself is aborted only if no other
request is still waiting for it.

Stage 2, all optional:

```ts
import { Redis } from "ioredis"; // your dependency, not cache-kit's
import { LruCache, TwoLevelCache, ioredisL2Client, ioredisSubscriber } from "cache-kit";

const l1 = new LruCache<string, User | null>({
  maxEntries: 10_000,
  ttlMs: 30_000,
  staleMs: 60_000,      // after 30 s: serve the old user at once for up to 60 s more while ONE refresh runs
  negativeTtlMs: 5_000, // a loaded null ("no such user") is cached for 5 s, not 30
});

// Optional L2: Redis shared by every replica. Two connections: SUBSCRIBE takes one over (see below).
const redis = new Redis(process.env.REDIS_URL!, { enableOfflineQueue: false }); // fail fast while disconnected
const users = new TwoLevelCache<User | null>({
  l1,
  redis: ioredisL2Client(redis),
  subscriber: ioredisSubscriber(redis.duplicate()),
  prefix: "myapp:users:",
});

export const getUser = (id: string) => users.getOrLoad(id, (signal) => db.users.findById(id, { signal })); // L1 -> Redis -> DB
export async function updateUser(id: string, patch: Partial<User>) {
  await db.users.update(id, patch);
  await users.delete(id); // this replica, Redis, and (pub/sub) every other replica's L1
}
```

## What each part does

**`new LruCache<K, V>(options)`**

| Option | Default | Meaning |
|---|---|---|
| `maxEntries` | required | integer >= 1; one more evicts the least recently used |
| `maxWeight` | none | second limit, e.g. bytes; needs `weigh` |
| `weigh(value, key)` | none | must return an integer >= 0 (bytes), else `set` throws `RangeError` (cache unchanged); fractions are refused because they drift when added and subtracted |
| `ttlMs` | none (no expiry) | default time to live; > 0, `Infinity` allowed |
| `staleMs` | 0 (none) | stale-while-revalidate grace after the TTL; >= 0, `Infinity` allowed (stage 2) |
| `negativeTtlMs` | none (off) | max TTL of a loaded "not found" value; > 0 (stage 2) |
| `isNegative(value)` | `null` or `undefined` | which loaded values are "not found"; needs `negativeTtlMs` (else `TypeError`) |
| `sweepIntervalMs` | none (lazy only) | remove expired entries every N ms; the timer is `unref`'d |
| `onEvent` | none | `evict` (key, reason), `reject`, `load`, `load-error`, `load-abort`, `refresh`, `refresh-error`; a throwing handler is ignored |
| `now` | `performance.now` | test hook; monotonic so a wall-clock jump does not expire everything |

**LRU.** The order is a `Map`'s insertion order: the first key is the least recently used, and a hit deletes and
re-inserts the key to move it to the end. `get`, `set`, `delete`, `peek`, `has` are O(1) (an evicting `set`
amortized: see "Overhead" for why the victim is found with one long-lived iterator); `purgeExpired()` and `keys()`
are O(n).
- `get(key)` counts a hit or miss and makes the key most recent. `peek` and `has` change neither recency nor stats.
- `set(key, value, { ttlMs })` replaces an existing value (most recent again, TTL restarted, no eviction). Then it
  evicts from the least recent end while entries > `maxEntries`, then while total weight > `maxWeight`. Exactly AT
  either limit nothing is evicted.
- A value heavier than `maxWeight` on its own is NOT stored: `set` returns false, a `reject` event, `stats().rejected`
  +1, nothing else evicted -- and the key's older value is removed (the caller just replaced it; keeping it would be
  a stale read). A value of exactly `maxWeight` is stored and pushes everything else out.
- `delete(key)` returns true only if a FRESH entry was removed (what `has()` would say: false for an expired or a
  stale entry, which it still removes). `clear()` empties everything. Neither is an eviction.
- `size` counts entries held, INCLUDING expired ones not removed yet (see TTL). `totalWeight`, `keys()` (least
  recent first, read-only) for metrics and debugging.

**TTL.** An entry set at time t with `ttlMs` 100 is expired AT t + 100 (live at t + 99). The TTL counts from `set`,
not from the last read. Per-entry `ttlMs` overrides the default; `Infinity` never expires.
- Lazy expiry: `get`, `peek`, `has`, `delete` and `getOrLoad` check the expiry; an expired entry found is removed
  (an `evict` event with reason `expired`) and never returned.
- An eviction victim that had already expired is reported as `expired`, not `size` / `weight`.
- `sweepIntervalMs` runs `purgeExpired()` on an `unref`'d `setInterval` (tested: `hasRef()` is false), so the cache
  never keeps a process alive. `close()` stops it (twice is fine); the cache keeps working with lazy expiry.

**Single flight: `getOrLoad(key, loader, { signal, ttlMs })`.** A live entry is returned (a hit). On a miss, the first
caller starts `loader(loadSignal)`; every caller arriving while it runs joins it (`stats().coalesced`) and gets the
same value or the same error.
- A loader error is NOT cached: every waiter gets it, the next call loads again. A sync throw is a rejection too.
- The loaded value is stored with the call's `ttlMs` (else the default). One too heavy to store is still returned.
- **Abort.** A caller whose `signal` aborts rejects at once with `signal.reason` and stops waiting; the load continues
  for the others and is cached. Only when EVERY waiting caller has aborted is the loader's signal aborted (`load-abort`
  event) and the load detached: the next caller starts a fresh load, and the abandoned load writes nothing even if
  it answers later. A caller without a signal never leaves, so it keeps the load alive. An already-aborted caller
  neither starts nor joins a load. The listener on the caller's signal is removed once the load settles (tested).
- **No stale writes (load versions).** `delete`, `set` and `clear` detach the running load for the key; a load writes
  only if it is still the attached one -- the flight object is the key's version, the same idea as the generations
  in projects/18-resilience/src/breaker.ts. So `delete(key)` after an update cannot be undone by a slow load that
  started before it, and a `set` during a load is not overwritten. The callers already waiting still get that load's
  result.

**Stats** (`stats()` returns a copy): `hits`, `misses` (from `get` and `getOrLoad` only), `loads` (loader calls),
`coalesced` (misses that joined a running load), `loadErrors` (not counting aborted loads; a `weigh` failure on the
loaded value counts here and rejects the waiters), `rejected`, `evictions: { size, weight, expired }`. Stage 2:
`staleHits` (neither a hit nor a miss), `negativeHits` (part of `hits`), `refreshes` (part of `loads`),
`refreshErrors` (part of `loadErrors`). Hits and misses are counters, not events: an event on every read would cost every call.

### Stage 2: stale-while-revalidate

With `staleMs` (cache-wide, or per `set` / per `getOrLoad` call), an entry set at t with `ttlMs` 100 and `staleMs`
50 is **fresh** in [t, t+100), **stale** in [t+100, t+150), and **gone** (removed as `expired`) from t+150.
- `getOrLoad` on a stale entry returns the old value AT ONCE (`staleHits` +1, the key becomes most recent) and starts
  ONE background refresh (`refresh` event, `refreshes` +1), unless a load for the key is already running: 50
  concurrent stale reads -> 1 loader call (tested). The refresh uses the `ttlMs` / `staleMs` of the call that
  started it, and the loader's context says `refresh: true`.
- **A failed refresh** (`refresh-error` event, `refreshErrors` +1, also counted in `loadErrors`) leaves the stale
  entry as it is: it keeps being served until the grace ends, and the next stale read tries another refresh (no
  backoff, see "Known"). After the grace the key is a plain miss and the caller waits for the loader (and gets its
  error).
- **A refresh never overwrites a newer write**: it is a flight like any stage-1 load, so `set`, `delete` and `clear`
  detach it and it writes nothing (tested for all three).
- A miss after the grace ended while the refresh is still running JOINS that refresh (`coalesced`). A refresh counts
  the cache itself as a waiter that never leaves, so a caller that joins and aborts does not abort it (tested).
- **`get` / `peek` / `has` do NOT return a stale entry** (get counts a miss) but leave it in place for `getOrLoad`.
  Decision: `get` has no loader, so it cannot start a refresh; returning the stale value would make `ttlMs` mean
  nothing to every caller that does not use `getOrLoad`. A caller that wants stale data uses `getOrLoad`.
  `delete` returns what `has` would have returned (false for a stale entry) and removes it anyway.
- `purgeExpired` / the sweep remove only entries past their grace. An eviction victim that is stale but within its
  grace is reported with the limit's reason (`size` / `weight`): it was still usable. `size` counts stale entries.

### Stage 2: negative caching

With `negativeTtlMs`, a LOADED value for which `isNegative(value)` is true (default: `null` or `undefined`) is stored
for `min(the TTL it would get, negativeTtlMs)` and with no stale grace. A flood of lookups for a missing id then costs
one loader call per `negativeTtlMs` (1000 sequential + 100 concurrent lookups -> 1 call, tested). A hit on it counts
in `hits` and `negativeHits`. Only loaded values are classified: `set(key, null)` is an ordinary value.
- **Errors are still NOT cached** (tested with negative caching on). Not implemented on purpose: a loader error is
  usually transient (a timeout, a restart), and caching it turns a 50 ms blip into an outage of that key for the
  whole error TTL. A loader that knows an error means "not found" (HTTP 404) should return `null` instead.

### Stage 2: the load context

The loader's second argument: `ttlMs` (the TTL its value will get; the loader may change it, e.g. from an HTTP
`max-age` -- an invalid value fails the load like an invalid weight; a negative value is still capped),
`refresh` (true for a background refresh) and `isCurrent()` (still the key's load version: false after a `delete` /
`set` / `clear` of the key). `TwoLevelCache` is built on these three.

### Stage 2: `TwoLevelCache` (Redis L2 shared between replicas)

`new TwoLevelCache<V>({ l1, redis, subscriber?, prefix, channel?, codec?, l2TimeoutMs?, tombstoneMs?, onEvent? })`.
Keys are strings. L1 is your `LruCache` (its TTL, grace, negative caching and limits apply as usual).
- **`getOrLoad`: L1 -> Redis -> loader.** The Redis read runs INSIDE the L1 load, so single flight covers it: 50
  concurrent misses on one replica = 1 Redis read + at most 1 loader call (tested). A Redis hit costs no loader call;
  its L1 copy gets `min(Redis's remaining PTTL, this call's TTL)`, so a replica that reads a 60 s value 50 s after it
  was written keeps it 10 s, not 60 (tested). After a loader call the value is written to Redis with the same TTL the
  L1 copy got (a negative one with its short TTL) -- in the background, not awaited by the callers (`flush()` waits).
  A stale-while-revalidate refresh also reads Redis first, so a value another replica already refreshed costs no load.
- **Values are strings in Redis**, through a `codec` (default `jsonCodec`: JSON in an envelope `{"v": ...}` so a
  top-level `undefined` survives). **JSON loses**: a `Date` comes back as an ISO string, a `Map` / `Set` as `{}`,
  `undefined` inside objects disappears, `NaN` / `Infinity` become `null`, class instances become plain objects, a
  `BigInt` cannot be encoded (tested). Pass your own codec for those. A value that cannot be encoded is returned and
  cached in L1 but not written to Redis; one that cannot be decoded is a miss and the loader's value overwrites it.
- **Keys**: `prefix + key` (required, non-empty, e.g. `"myapp:users:"`); the channel defaults to `prefix +
  "invalidate"`. The TTL in Redis is the L1 TTL in whole ms, rounded up (`Infinity` = no expiry).
- **`set(key, value, opts)`** writes L1 and Redis, then PUBLISHes `[instanceId, key]`. **`delete(key)`** removes the
  L1 entry, replaces the Redis value by a **tombstone** for `tombstoneMs` (default 10 s; a tombstone reads as a
  miss), then publishes. Every other replica's subscriber drops the key from its L1 (`invalidated` event); the
  sender ignores its own message (a random id per instance). Both resolve `true` when Redis confirmed the write and
  the publish, `false` when Redis failed -- they never throw for Redis (an `l2-error` event); they do throw
  `RangeError` for invalid options before touching Redis.
- **Why `SET NX` and tombstones (a race found by the real-Redis test).** Replica B misses, reads the OLD row from
  the DB; replica A updates the row and calls `set`; B's background write of the old row travels on B's own
  connection and can reach Redis AFTER A's write -- Redis then served the old value to every replica for a whole TTL
  (the first version of `set on A: B ... reads the new value` failed exactly like this). Now writes after a load use
  `SET ... NX` (only if the key is absent): B's late write is refused (`l2WritesSkipped`). `delete` writes a tombstone
  instead of `DEL` so the same late write is refused after a delete too. Also, when the invalidation reaches B
  before B's load ends, B's L1 detaches the load (`isCurrent()` false) and B writes neither L1 nor Redis. The
  real-Redis race test runs 20 rounds and prints which path each took; in four recorded runs the NX refusal was hit
  in 6, 14, 17 and 11 of the 20 rounds (the rest had the message arrive first), and Redis held A's value every
  time. The deterministic versions of both orders use the fake Redis with held messages.
- **Why a second connection for the subscriber.** A Redis connection that runs `SUBSCRIBE` is in subscriber mode
  and (RESP2, ioredis 5's default) can run nothing else but (UN)SUBSCRIBE / PING / QUIT. So you pass one ordinary
  client (`ioredisL2Client(redis)`) and one dedicated to listening (`ioredisSubscriber(redis.duplicate())`). The
  interfaces are tiny (`getWithTtl` (GET + PTTL in one MULTI), `set` (PX, NX), `publish`; `subscribe`), so another
  client needs a five-line adapter; ioredis is only a dev dependency here.
- **The documented weakness: pub/sub is fire-and-forget.** A message published while a replica's subscriber is
  disconnected is lost; Redis does not queue it. Mitigations, in order: (1) on every RE-subscribe the replica clears
  its whole L1 (`resubscribed` event; it refills from Redis, not from the DB). The ioredis adapter calls this only
  after Redis CONFIRMED the new SUBSCRIBE, because ioredis emits `ready` before it has even sent its own
  re-SUBSCRIBE (read in ioredis 5.4.1's `event_handler.js`); clearing at `ready` would leave a gap. (2) What no
  client can see -- a connection that is half-open but not yet detected as dead -- is bounded only by the **L1 TTL:
  keep it short** (seconds, not hours) when replicas share data. Tested: a disconnected subscriber misses a `set`
  and serves the old value until the reconnect clears it (fake Redis), and a killed subscriber connection on the real
  Redis reconnects, clears L1 and receives invalidations again.
- **Redis outage: degrade, never fail a read.** Every Redis call is bounded by `l2TimeoutMs` (default 250 ms). A
  failed or timed-out read is treated as a miss (the loader runs, L1 caches); writes fail quietly (`l2-error`
  events, `l2Errors`); `set` / `delete` resolve `false`. Tested with a fake Redis that is down or never answers, and
  with ioredis against a port where nothing listens and with its connection killed mid-run. Set ioredis's
  `enableOfflineQueue: false` so commands fail at once while disconnected instead of each waiting out the timeout.
- `ready` resolves `true` once subscribed (`false` without a subscriber or on failure; never rejects). `close()`
  waits for background writes and unsubscribes; it does not close your Redis clients or the L1.
- `stats()`: `l2Hits`, `l2Misses`, `l2Errors`, `l2Writes`, `l2WritesSkipped`, `invalidationsSent`,
  `invalidationsReceived`, `resubscribes`.

## What the tests show

`npm test` -- 178 tests in `test/` (stage 1: 67; stage 2 added 84 and extended two stage-1 files; stage 3 added 27):

| File | Proves |
|---|---|
| `lru.test.ts` | set / get / peek / has / delete / clear / size; exactly at maxEntries nothing is evicted, one more evicts the LRU; get refreshes recency, peek and has do not; replace = most recent, no eviction; maxEntries 1; an `undefined` value; weight: the total through set / replace / delete / clear, exactly at maxWeight, evicting until it fits, a value of exactly maxWeight, a single value heavier than maxWeight (not stored, nothing evicted, the older value removed), invalid weigh results (-1, NaN, Infinity, 1.5, 0.1, a string, undefined, null: RangeError, cache unchanged), weigh without maxWeight, both limits with their own reasons; invalid options; evictions reuse one Map iterator (1000 evictions, at most 1 `Map.prototype.keys` call: guards the fix in "Overhead") (16) |
| `ttl.test.ts` | the boundary (live at ttl - 1, expired AT ttl); an expired entry never returned by get / peek / has / getOrLoad and removed as `expired`; delete of an expired entry; get does not extend the TTL; set restarts it; per-entry override, Infinity, no default; an expired eviction victim reported as `expired`; purgeExpired; the sweep (fake timers), its timer is unref'd (`hasRef()` false), close() stops it, no option = no timer, the sweep with real timers (waits up to 10 s for an event, not a fixed time); invalid ttlMs / sweepIntervalMs (15) |
| `load.test.ts` | load once then hit; **100 concurrent getOrLoad -> 1 loader call, 100 equal results, 99 coalesced**; keys independent; an error shared by 10 waiters, not cached, next call loads again; a sync throw; per-call ttlMs (an invalid one costs no load); a hit refreshes recency; a too-heavy loaded value returned but not cached; an invalid weight for a loaded value rejects every waiter; abort: already-aborted caller, one of three waiters leaves (the load continues and is cached), ALL leave (the loader's signal aborted with the last reason, nothing written even when the loader answers later, the next call loads fresh), an aborted load is not a load error, a caller without a signal keeps the load alive, the listener removed after settling, abort after settling; stale writes: delete / clear / set during a load, an old load failing after delete does not detach the new one (21) |
| `stats-events.test.ts` | hits / misses only from get and getOrLoad (the full stats object incl. the stage-2 counters); an expired read is a miss; stats() is a copy; delete and clear are not evictions; a throwing handler is ignored for all 8 events of a scripted run; the event order of a load (6) |
| `model.test.ts` | **randomized against a naive array model**: 8 seeds x 3000 steps of get / set (incl. values heavier than maxWeight, per-entry TTL and staleMs) / **getOrLoad (stale reads + their refresh, "not found" values with negative caching)** / delete / peek / has / purge / clear / time advance, random maxEntries, maxWeight, TTL, staleMs and negativeTtlMs; after EVERY step the return value, the key order, the total weight and all stats must be identical; a last test checks the steps really reached hits, misses, rejects, all three eviction reasons, stale hits and negative hits (more than 50 of each over all seeds; recorded: 104 stale hits, 192 negative hits) (9) |
| `swr.test.ts` | stage 2, stale-while-revalidate: fresh at ttl - 1, stale AT ttl, still stale at ttl + staleMs - 1, gone AT ttl + staleMs (then a real miss that waits); the stale value returned without waiting; get / peek / has do not return stale entries, delete returns false for one; purge keeps stale entries; stale victim = limit reason, dead victim = expired; recency; per-entry / per-call / 0 / Infinity staleMs; the refresh uses its call's options; invalid staleMs; **50 concurrent stale reads -> 1 refresh**; a dead-entry miss joins the refresh; a joiner that aborts does not abort the refresh; a failed refresh keeps the stale value until the grace ends and is retried; set / delete / clear during a refresh win; the load context (ttlMs, refresh flag, loader-set TTL, invalid loader TTL, isCurrent) (25) |
| `negative.test.ts` | stage 2, negative caching: cached until negativeTtlMs, a new load AT it; **1000 sequential + 100 concurrent lookups of a missing id -> 1 loader call**; found values keep the normal TTL; default and custom isNegative; min(TTL, negativeTtlMs) incl. a loader-set TTL; no stale grace for negatives; get counts negative hits; set(null) is not negative; errors still not cached; a refresh returning null replaces a stale value; options validation (11) |
| `two-level.test.ts` | stage 2, `TwoLevelCache` against an in-memory fake Redis (exact control of time, failures and message delivery): L1 -> L2 -> loader with prefixed keys and the TTL; **replica B served from L2 without its loader**, its L1 copy expiring with the Redis copy; min(PTTL, call TTL); PTTL 0 = miss; an L1 hit touches no Redis; 50 concurrent misses -> 1 Redis read + 1 load; negatives through L2; a refresh reads L2 first; nobody waiting -> no load; **delete / set on A invalidate B**, A ignores its own message; Redis TTL from the L1 default; an invalidation or local delete during a load stops the Redis write; **both race orders (set, delete) with held messages: NX / tombstone refuse the late write**; tombstone lifetime; set overwrites a tombstone; **a disconnected subscriber misses messages, the reconnect clears L1**; malformed messages; channel names; close() waits for writes (incl. a slow one) and unsubscribes; codec (JSON round trip and its losses, custom codec, decode failure = miss + overwrite, encode failure incl. non-string results); **outage**: Redis down, Redis hanging (timeout, real 30 ms timer), subscribe failing, Redis back; TTL rounding; a throwing handler; invalid options (35) |
| `adapters.test.ts` | stage 2, the ioredis adapters against stand-ins: messages for the channel only; the first `ready` ignored, after a reconnect onResubscribed only once the new SUBSCRIBE is confirmed; unsubscribe and a failed subscribe remove the listeners; MULTI errors and an aborted MULTI are errors; SET argument mapping for PX / NX (5) |
| `redis-l2.test.ts` | stage 2, **a real Redis** (skipped with a printed notice if unreachable): the adapter's GET + PTTL MULTI and SET PX / NX replies; a load on A served from Redis on B (PTTL checked); delete on A reaches B's L1 over pub/sub, Redis holds a tombstone; set on A -> B reads the new value; **the race, 20 rounds, Redis always keeps A's value**; B's subscriber connection killed with CLIENT KILL -> reconnect, L1 cleared, invalidations arrive again; nothing listening on the port and a connection killed mid-run -> L1 + loader, set / delete false, no crash; all keys of the run deleted afterwards (8) |
| `express-helper.test.ts` | stage 3, a real Express 4 app: miss then hit (producer once), ttlMs passed on (miss, hit, miss on an injected clock), **a stale read answered at once with X-Cache: stale, the refresh then a hit**, keys separate, **per-user key: users never see each other's data**, no key = bypass, **20 concurrent requests -> 1 producer call**, null -> 404 and cached, an error not cached and handled by the app, **all clients gone -> the load's signal aborted; one left -> the load goes on**; **two Express instances on one real Redis: B answers from Redis without running its producer** (10) |
| `nestjs-helper.test.ts` | stage 3, a real NestJS 10 app: `@CachedRoute` miss then hit (handler not run on a hit), 10 concurrent requests -> 1 handler run, null -> 404, an error not cached (500, then the handler runs again); `@Cached` on a service method used by a controller (5) |
| `cached.test.ts` | stage 3, `@Cached` without a framework: key by arguments and `this` kept, 10 concurrent calls -> 1, undefined key = uncached, errors not cached, the first caller's `this` (wrong key on purpose), the key function gets `this` (the right per-tenant key), a sync throw is a rejection, ttlMs passed on, only methods (8) |
| `adapters-unit.test.ts` | stage 3, with a fake response: requestSignal aborts on an early close but not after a finished response; nothing written to a response destroyed during the load; no `next(err)` for a client that has gone (4) |

## Mutation checks (stage 1, 2026-11-23)

Each row: one deliberate bug in `src/`, applied alone, full suite run with `npx vitest run --reporter=json` from
`H:\` (uppercase: a lowercase drive path made vitest load modules twice in projects/18), file restored byte-exact
(checked). The runner was kept outside the repo. Every pattern is checked to match exactly once before anything runs.
The number is how many tests failed. Final run on the final code, against 66 tests; the last five rows were re-run
after the 67th test was added.

| # | Break | Failed |
|---|---|---|
| L1 | `get` does not refresh recency | 10 (67: 10) |
| L2 | `getOrLoad` hit does not refresh recency | 1 |
| L3 | maxEntries off by one: keeps one too many | 15 |
| L4 | maxEntries off by one: evicts at exactly maxEntries | 17 |
| L5 | evicts the most recently used instead of the least | 19 (67: 20) |
| W1 | weight limit inclusive (evicts at exactly maxWeight) | 12 |
| W2 | no reject for a single too-heavy value | 12 |
| W3 | a rejected too-heavy value keeps the key's older value | 10 |
| W4 | invalid weigh results accepted | 2 |
| W5 | removing an entry does not subtract its weight | 13 |
| W6 | `clear()` does not reset the weight | 10 |
| W7 | fractional weights accepted | 1 |
| T1 | TTL boundary: live AT expiresAt (lazy read) | 15 |
| T2 | TTL boundary in purgeExpired | 5 |
| T3 | per-entry ttlMs ignored | 13 |
| T4 | `peek` returns expired entries | 9 |
| T5 | an expired eviction victim reported as size / weight | 10 |
| T6 | per-load ttlMs ignored | 1 |
| S1 | sweep timer not unref'd | 1 |
| S2 | `close()` does not stop the sweep | 1 |
| S3 | the sweep never purges | 2 |
| F1 | **single-flight dedupe removed** (every miss loads) | 8 |
| F2 | **error cached**: a failed load stays attached | 2 |
| F3 | **load version check removed** (stale writes) | 5 |
| F4 | `delete` does not detach the running load | 3 |
| F5 | `set` does not detach the running load | 1 |
| F6 | `clear` does not detach running loads | 1 |
| A1 | one waiter aborting aborts the shared load | 3 |
| A2 | the load is not aborted when every waiter left | 1 |
| A3 | an abandoned load stays attached (the next caller joins a cancelled load) | 1 |
| A4 | an already-aborted caller starts / joins a load | 1 |
| A5 | the abort listener is not removed after the load settles | 1 |
| A6 | an aborting caller keeps waiting | 4 |
| A7 | an aborted load counted as a load error | 1 |
| E1 | a throwing event handler is not contained | 1 |
| E2 | coalesced joins not counted | 1 |
| E3 | `stats()` returns the live counters | 1 |
| E4 | rejected values not counted | 11 |
| L8 | the eviction iterator recreated on every eviction (the old slow code) | 0 at first; 1 after a test was added (67) |

**Survivors that cannot change behaviour (equivalent mutants), kept as documentation:**

| # | Break | Failed | Why no test can catch it |
|---|---|---|---|
| L6 | `clear()` keeps the old eviction iterator | 0 | the language spec keeps a Map iterator valid across `clear()`; the reset is only there to be obviously right. The model test's random `clear` steps confirm the old iterator works |
| L7 | a finished eviction iterator is not replaced | 0 | unreachable: eviction only runs while the map holds keys, all at or after the iterator's position |
| W8 | the weight loop's `size > 1` guard removed | 0 | it only matters if the weight total is already wrong (see below) |

**Found by a mutation: W5 hung the test run.** In the first run, "removing an entry does not subtract its weight"
made the weight-eviction loop spin forever: the total stayed above the limit after the map was empty. The vitest
run never finished, the runner's 300 s timeout killed only the shell, and 12 orphaned node processes kept spinning
(and slowed every later check) until they were found and killed by hand. Two changes: the loop now also stops when
only the new entry is left (`size > 1`, a no-op with correct bookkeeping, hence the survivor W8), so a bookkeeping bug
gives wrong evictions that tests see instead of a hung process; and weights must be integers, because fractions
make the running total drift (`0.1 + 0.2 - 0.1 - 0.2` is `2.8e-17`, not 0) -- new break W7. The runner now kills
the whole tree on a timeout. The first run's other counts (before these changes) matched the final ones except
W1 (13 -> 12), T2 (7 -> 5) and W6 (1 -> 10, after the model test got `clear` steps).

Caught by exactly one test (deleting it would hide them): L2, W7, T6, S1, S2, F5, F6, A2, A3, A4, A5, A7, E1, E2,
E3, L8.

## Mutation checks, stage 2 (2026-11-23)

Same method (the runner is outside the repo, started from `H:\project-cache\projects\20-cache` with an uppercase
drive letter, kills the whole node process tree on a 300 s timeout, restores every file byte-exact, checks every
pattern matches exactly once before anything runs). **99 breaks: the 42 stage-1 ones re-based on the stage-2 code,
plus 57 new ones.** Final run on the final code, 151 tests, the Redis tests running.

**Stage-1 breaks re-run**: all 39 that change behaviour caught again (counts against 151 tests: L1 10, L2 10, L3 18,
L4 20, L5 21, L8 1, W1 12, W2 12, W3 10, W4 2, W5 13, W6 10, W7 1, T1 15, T2 8, T3 13, T4 15, T5 11, T6 14, S1 1,
S2 1, S3 2, F1 12, F2 4, F3 9, F4 7, F5 3, F6 2, A1 4, A2 3, A3 1, A4 1, A5 1, A6 6, A7 1, E1 1, E2 2, E3 1, E4 11);
L6, L7, W8 survive again, for the reasons in the table above. T1 / T2 now break the boundary on `deadAt` (the end of
the grace), which with `staleMs` 0 is the stage-1 expiry.

| # | Break | Failed |
|---|---|---|
| R1 | getOrLoad: fresh AT `expiresAt` (stale boundary off by one) | 16 |
| R2 | get / peek / has: fresh AT `expiresAt` | 12 |
| R3 | no stale grace at all | 29 |
| R4 | `get` returns a stale entry | 10 |
| R5 | a stale read waits for the refresh instead of returning at once | 26 |
| R6 | **every stale read starts its own refresh** | 1 |
| R7 | a stale read starts no refresh | 18 |
| R8 | a refresh can be aborted by a joiner that leaves | 1 |
| R9 | refresh errors not counted | 1 |
| R10 | a refresh emits `load` / `load-error` | 1 |
| R11 | **a failed refresh drops the stale entry** | 1 |
| R12 | a stale hit does not refresh recency | 1 |
| R13 | a stale eviction victim reported as `expired` | 10 |
| R14 | `purgeExpired` also removes stale entries | 11 |
| R15 | `delete` returns true for a stale entry | 10 |
| R16 | `staleMs` not validated | 1 |
| R17 | `staleHits` not counted | 13 |
| R18 | `refreshes` not counted | 12 |
| R19 | per-entry `staleMs` ignored | 11 |
| R20 | per-call `staleMs` ignored | 11 |
| N1 | negative entries get the stale grace | 10 |
| N2 | the negative TTL ignores a shorter TTL | 7 |
| N3 | negative values get the normal TTL | 14 |
| N4 | `negativeHits` not counted | 14 |
| N5 | default `isNegative` only `null` | 1 |
| N6 | `isNegative` without `negativeTtlMs` accepted | 1 |
| N7 | `set(key, null)` marked negative | 9 |
| N8 | `negativeTtlMs` not validated | 1 |
| C1 | a TTL set by the loader ignored | 2 |
| C2 | a TTL set by the loader not validated | 1 |
| C3 | `isCurrent()` always true | 3 |
| C4 | the context says `refresh: false` | 1 |
| X1 | Redis never read | 18 |
| X2 | an L2 hit's L1 copy does not get Redis's remaining TTL | 1 |
| X3 | write-behind without the `isCurrent()` check | 2 |
| X4 | **loads write without NX** (the race) | 6 |
| X5 | loads always NX (a corrupt value is never overwritten) | 1 |
| X6 | a tombstone read as a value | 1 |
| X7 | `delete` leaves Redis untouched | 8 |
| X8 | own invalidation messages not ignored | 2 |
| X9 | an invalidation does not drop the L1 copy | 7 |
| X10 | a re-subscribe does not clear L1 | 2 |
| X11 | no timeout on Redis calls | 2 |
| X12 | a failed Redis read fails `getOrLoad` | 8 |
| X13 | `set` does not publish | 4 |
| X14 | a Redis key without expiry gives the L1 copy TTL -1 | 1 |
| X15 | the loader starts although every caller left during the Redis read | 0 at first; 1 after the test was fixed |
| X16 | a non-string `encode` result sent to Redis | 0 at first; 1 after a test was extended |
| X17 | the adapter calls onResubscribed at `ready`, before the SUBSCRIBE is confirmed | 1 |
| X18 | the adapter treats the first `ready` as a reconnect | 2 |
| X19 | TTLs sent to Redis not rounded | 1 |
| X20 | a decode failure throws instead of being a miss | 1 |
| X21 | `set` / `delete` report success when Redis failed | 3 |
| X22 | a malformed message applied | 1 |
| X23 | loads never write Redis | 16 |
| X24 | `close()` does not wait for pending writes | 0 at first; 1 after a test was added |
| X25 | a PTTL of 0 counted as a hit | 0 at first; 1 after a test was added |

**The 4 first-run survivors were real test gaps, not equivalent mutants; each was closed:**
- X15: the test aborted the caller and checked the loader at once -- before the hung Redis read had even timed out,
  so it proved nothing. It now waits for the read's timeout event first.
- X16: the test's bad codec returned `undefined`, which a second guard (`text === undefined`) also catches; it now
  also returns a number and an object.
- X24: the fake Redis writes synchronously, so there was never a pending write to wait for; a new test uses a client
  whose SET answers 20 ms later.
- X25: no test produced a PTTL of exactly 0 (the fake drops a key at its expiry); a new test returns one, and a hit
  with TTL 0 would have failed the load with a RangeError.

Caught by exactly one test (stage 2): R6, R8, R9, R10, R11, R12, R16, N5, N6, N8, C2, C4, X2, X5, X6, X14, X15, X16,
X17, X19, X20, X22, X24, X25.

## Mutation checks, stage 3 (2026-11-23)

One break at a time in the framework helpers, full suite (178 tests, real Redis on), reverted; runner outside the repo, started from `H:\`, killing the whole process tree on a timeout. 20 breaks, **all caught**. The first run left 3 survivors -- C4, E1, E2: the "client already gone" paths, invisible over a real socket because writing to a closed connection is silently dropped -- and `test/adapters-unit.test.ts` (a fake response object) was added for them. C7, D5 and D6 guard the three fixes from the interview-bank review (the "stale" label, the key function's `this`, a sync throw as a rejection). The 99 stage 1 + 2 breaks were not re-run: stage 3 changed none of the core files (`cache.ts`, `two-level.ts`, `events.ts`).

| # | Break | Failed |
|---|---|---|
| C1 | every request reported as a hit (ran flag never set) | 9 |
| C2 | no key does not bypass (caches under undefined) | 1 |
| C3 | the request's signal not passed to getOrLoad | 1 |
| C4 | requestSignal aborts even after a finished response | 1 |
| C5 | ttlMs / staleMs not passed by the HTTP helpers | 1 |
| C6 | default not-found rule broken (null is a 200) | 2 |
| E1 | express: sends to a client that has gone | 1 |
| E2 | express: next(err) even when the client has gone | 1 |
| E3 | express: no X-Cache header | 8 |
| E4 | express: not-found answered 200 with the value | 1 |
| E5 | express: errors swallowed (request hangs) | 1 |
| N1 | nest: no X-Cache header | 2 |
| N2 | nest: not-found returned as a value | 1 |
| D1 | @Cached: undefined key still cached | 1 |
| D2 | @Cached: `this` lost in the cached call | 3 |
| D3 | @Cached: ttlMs not passed | 1 |
| D4 | @Cached: decorates non-methods silently | 1 |
| C7 | a stale serve labelled miss (refresh flag ignored) | 1 |
| D5 | @Cached: key function called without `this` | 1 |
| D6 | @Cached: a sync throw escapes as a throw | 1 |

## Overhead

`npm run bench` (`bench/overhead.mjs`): ns per operation on a cache holding 10 000 entries, single thread, 1 000 000
operations per round after 200 000 warm-up operations, median of 7 rounds; a plain `Map.get` as the floor. This is
the cache's own bookkeeping, not the value of caching: a DB query costs around a millisecond, thousands of times any
number here. Raw results with every round: `bench/reference-results/2026-11-23-win32-run1.json` and `-run2.json`
(the script writes `<date>-<platform>.json`; renamed by hand after each run).

Windows 11 PC (10.0.26200), AMD Ryzen 5 4500, Node 20.20.1 -- two runs, ns per operation. The machine was busy with
other work (the Map floor alone moved from 37 to 79 between the runs), so read these as orders of magnitude:

| Operation | run 1 | run 2 |
|---|---|---|
| `Map.get` (floor) | 36.9 | 78.9 |
| `get` hit | 413.7 | 403.9 |
| `get` hit, `ttlMs` set | 325.4 | 417.5 |
| `get` miss | 48.6 | 60.2 |
| `set` existing key | 279.8 | 346.4 |
| `set` new key (evicts the LRU) | 548.8 | 664.6 |
| `getOrLoad` hit (awaited) | 924.6 | 1091.7 |

**Found by the benchmark: eviction was not O(1).** The first version found the victim with a fresh
`this.map.keys().next()` per eviction (this README said `entries()` until a reviewer compared it with the code
comment, PLAN and the guard test, which spies on `Map.prototype.keys`). The first run measured **10 401.9 ns per evicting set** (raw:
`2026-11-23-win32-before-iterator-fix.json`), about 150x a `Map.get`. Likely cause (from how V8's ordered hash
tables are known to work; V8's source was not read here, only the fix's effect was measured): V8 leaves a hole in a
Map's table for each deleted entry until it rehashes, and a NEW iterator starts at slot 0, so every eviction walked
over all the holes left by the evictions before it. Fix: one long-lived `keys()` iterator for evictions. By the
language spec it skips deleted entries and visits entries appended later, and every live key is at or after its
position, so `next()` is still the least recently used key, and each hole is walked over once in total. After the
fix: 549 / 665 ns (the two runs above). The order is unchanged (the model test passes). Putting the old code back
(mutation L8) first failed NO test -- a pure performance change. A test now counts `Map.prototype.keys` calls during
1000 evictions (at most 1), so L8 is caught without any timing assertion (those were flaky on this machine).

Not investigated: why a hit costs about 400 ns against a `Map.get`'s 40-80 (it does a `delete` + `set` to move the
key and reads `performance.now()` for the expiry check; which of those dominates was not measured). Not measured:
concurrency, memory per entry, Linux.

## Known and NOT changed

- `size` includes expired entries until something touches them or the sweep runs, and stale entries in their grace.
- Errors are never cached: a key whose load always fails sends EVERY miss to the loader, one load at a time per key
  (single flight still applies to concurrent callers). See "negative caching" for why.
- A failed refresh is retried by the next stale read, with no backoff: during an outage of the DB, a hot stale key
  sends about one refresh at a time to it, back to back, until its grace ends.
- A loader that never settles and ignores its signal keeps the key's flight forever for callers without a signal: put
  a timeout inside the loader (for example projects/18-resilience's `TimeoutPolicy`). For a background refresh this
  also means no further refresh starts for that key, and after the grace every caller joins the stuck refresh.
- `TwoLevelCache`, the windows that remain: (a) a load whose write reaches Redis more than `tombstoneMs` after a
  `delete` (a load slower than that) writes the old value back -- keep `tombstoneMs` above your loader timeout;
  (b) a replica whose subscriber is silently cut off (not yet detected) serves its L1 copy until the L1 TTL;
  (c) between A's `set` and the message reaching B, B still serves its old L1 copy (milliseconds on a healthy
  network); (d) if `set` / `delete` resolve `false`, other replicas and Redis may hold the old value until their
  TTLs; (e) a value Redis holds but cannot decode is overwritten with a plain SET, not NX -- a `set` on another
  replica in that gap can be overwritten (rare: needs a corrupt value AND a concurrent set); (f) a tombstone is an
  ordinary Redis key: if Redis evicts it under memory pressure or restarts without persistence (the repo's infra
  Redis runs with `--appendonly no --save ""`), a late NX write is accepted again; (g) the ioredis subscriber
  adapter ignores a failed re-SUBSCRIBE after a reconnect: if ioredis's own resubscribe works, messages flow again
  but L1 was not cleared (bounded by the L1 TTL). This is a cache, not a consistency protocol: use short TTLs for
  data that changes.
- `TwoLevelCache.set` writes Redis even when the value is too heavy for L1 (L1 refuses it and drops the older
  value) and can still resolve `true` (= the Redis write worked).
- `TwoLevelCache` has no `clear()` across replicas (clearing a prefix in Redis needs SCAN; not built).
- Overhead not re-measured for stage 2: the numbers in "Overhead" above are stage 1's. The hit path gained one boolean check
  (negative hits) and the fresh/stale comparison; not benchmarked. Redis round trips were not benchmarked either.
- `weigh` is called on every `set` and every loaded value; an expensive `weigh` (JSON.stringify of a large object) is
  paid on the write path.
- Keys are compared like `Map` keys (SameValueZero): two equal objects are two keys. Use string keys.
- The pinned dev dependency vitest 3.2.7 is reported by `npm audit` (3 advisories in vitest / @vitest/mocker /
  tinypool, fixed in vitest 4); test-time only, nothing of it is shipped. Not upgraded because the toolchain is
  pinned across the projects.

## NOT implemented

- Error caching (opt-in, short TTL): deliberately left out, see "negative caching".
- Backoff between failed refreshes; a "refresh ahead" that refreshes a hot key BEFORE it goes stale.
- Redis Cluster / Sentinel specifics (the adapters are tested against one Redis 7.4.12 server); RESP3 client-side
  caching (`CLIENT TRACKING`), which would replace the pub/sub channel with server-pushed invalidations; Redis
  Streams instead of pub/sub (a durable log a reconnecting replica could replay).
- A clear across replicas; L2 for non-string keys.
- HTTP caching semantics in the helpers: no `Cache-Control` / `ETag` / `Vary` / conditional requests, no caching
  of non-JSON or streamed responses (they cache handler DATA by design). NestJS on Fastify, an Express 5 test:
  not done.
- Sliding expiry (TTL refreshed on read), LFU / W-TinyLFU admission, a size estimate that walks objects.
- Not published to npm; use it from this repo (copy or a local path dependency).

## Run it

```bash
cd projects/20-cache
npm ci
npm test        # the Redis tests need the infra Redis (127.0.0.1:56379 or REDIS_URL), else they are SKIPPED with a notice
npm run build   # dist/
npm run bench   # per-operation cost, writes bench/reference-results/<date>-<platform>.json
```

## Files

| File | What |
|---|---|
| `src/cache.ts` | `LruCache` (LRU, weight, TTL, sweep, single-flight `getOrLoad`, stale-while-revalidate, negative caching, load context, stats) |
| `src/events.ts` | `CacheEvent`, `EvictionReason`, `emit` (a throwing handler is ignored) |
| `src/two-level.ts` | `TwoLevelCache`, the `L2Client` / `L2Subscriber` interfaces, ioredis adapters, `jsonCodec`, `TOMBSTONE` |
| `src/index.ts` | entry point (core; no framework) |
| `src/cached.ts` | `@Cached` method decorator (stage 3, framework-free) |
| `src/adapters/http.ts` | `Loadable`, `requestSignal`, `loadForRequest`, the key / not-found rules (stage 3) |
| `src/adapters/express.ts` | `cachedJson` (`cache-kit/express`) |
| `src/adapters/nestjs.ts` | `@CachedRoute`, `CachedRouteInterceptor`, re-exports `@Cached` (`cache-kit/nestjs`) |
| `test/support.ts` | manual clock, deferred promise, event recorder |
| `test/fake-redis.ts` | in-memory Redis for unit tests: TTLs on the test clock, down / hang modes, held pub/sub messages |
| `bench/overhead.mjs` | per-operation cost; results in `bench/reference-results/` |
