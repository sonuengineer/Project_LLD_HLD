# cache-kit (build your own)

A small TypeScript library for an in-process cache in front of ANY expensive call -- a DB query, an HTTP call to
another service, a config lookup. An LRU bounded by entries and optionally by weight (bytes), TTL with lazy expiry
and an optional background sweep, and single-flight loading: when 100 requests miss the same key at once, the loader
runs ONCE (no cache stampede). It imports no framework, so the same code runs in an Express handler, a NestJS service,
a worker or a script. No runtime dependencies.

Status (2026-11-23): **stage 1 done** -- 67 tests pass (Windows, Node 20), including a randomized comparison
against a naive reference model (8 seeds x 3000 steps, compared after every step); 42 deliberate breaks, every one
that changes behaviour caught, 3 equivalent ones explained (see "Mutation checks"); per-operation cost measured on one PC (see "Overhead"). Stages 2 and 3 not started (see PLAN.md). Not
published to npm.

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

## What each part does

**`new LruCache<K, V>(options)`**

| Option | Default | Meaning |
|---|---|---|
| `maxEntries` | required | integer >= 1; one more evicts the least recently used |
| `maxWeight` | none | second limit, e.g. bytes; needs `weigh` |
| `weigh(value, key)` | none | must return an integer >= 0 (bytes), else `set` throws `RangeError` (cache unchanged); fractions are refused because they drift when added and subtracted |
| `ttlMs` | none (no expiry) | default time to live; > 0, `Infinity` allowed |
| `sweepIntervalMs` | none (lazy only) | remove expired entries every N ms; the timer is `unref`'d |
| `onEvent` | none | `evict` (key, reason), `reject`, `load`, `load-error`, `load-abort`; a throwing handler is ignored |
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
- `delete(key)` returns true only if a live entry was removed. `clear()` empties everything. Neither is an eviction.
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
loaded value counts here and rejects the waiters), `rejected`, `evictions: { size, weight, expired }`. Hits and
misses are counters, not events: an event on every read would cost every call.

## What the tests show

`npm test` -- 67 tests in `test/`:

| File | Proves |
|---|---|
| `lru.test.ts` | set / get / peek / has / delete / clear / size; exactly at maxEntries nothing is evicted, one more evicts the LRU; get refreshes recency, peek and has do not; replace = most recent, no eviction; maxEntries 1; an `undefined` value; weight: the total through set / replace / delete / clear, exactly at maxWeight, evicting until it fits, a value of exactly maxWeight, a single value heavier than maxWeight (not stored, nothing evicted, the older value removed), invalid weigh results (-1, NaN, Infinity, 1.5, 0.1, a string, undefined, null: RangeError, cache unchanged), weigh without maxWeight, both limits with their own reasons; invalid options; evictions reuse one Map iterator (1000 evictions, at most 1 `Map.prototype.keys` call: guards the fix in "Overhead") (16) |
| `ttl.test.ts` | the boundary (live at ttl - 1, expired AT ttl); an expired entry never returned by get / peek / has / getOrLoad and removed as `expired`; delete of an expired entry; get does not extend the TTL; set restarts it; per-entry override, Infinity, no default; an expired eviction victim reported as `expired`; purgeExpired; the sweep (fake timers), its timer is unref'd (`hasRef()` false), close() stops it, no option = no timer, the sweep with real timers (waits up to 10 s for an event, not a fixed time); invalid ttlMs / sweepIntervalMs (15) |
| `load.test.ts` | load once then hit; **100 concurrent getOrLoad -> 1 loader call, 100 equal results, 99 coalesced**; keys independent; an error shared by 10 waiters, not cached, next call loads again; a sync throw; per-call ttlMs (an invalid one costs no load); a hit refreshes recency; a too-heavy loaded value returned but not cached; an invalid weight for a loaded value rejects every waiter; abort: already-aborted caller, one of three waiters leaves (the load continues and is cached), ALL leave (the loader's signal aborted with the last reason, nothing written even when the loader answers later, the next call loads fresh), an aborted load is not a load error, a caller without a signal keeps the load alive, the listener removed after settling, abort after settling; stale writes: delete / clear / set during a load, an old load failing after delete does not detach the new one (21) |
| `stats-events.test.ts` | hits / misses only from get and getOrLoad; an expired read is a miss; stats() is a copy; delete and clear are not evictions; a throwing handler is ignored for all 8 events of a scripted run; the event order of a load (6) |
| `model.test.ts` | **randomized against a naive array model**: 8 seeds x 3000 steps of get / set (incl. values heavier than maxWeight, per-entry TTL) / delete / peek / has / purge / clear / time advance, random maxEntries, maxWeight and TTL; after EVERY step the return value, the key order, the total weight and all stats must be identical; a last test checks the steps really reached hits, misses, rejects and all three eviction reasons (more than 50 of each over all seeds) (9) |

## Mutation checks (2026-11-23)

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

**Found by the benchmark: eviction was not O(1).** The first version found the victim with
`this.map.entries().next()`. The first run measured **10 401.9 ns per evicting set** (raw:
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

- `size` includes expired entries until something touches them or the sweep runs.
- `getOrLoad` has no stale-while-revalidate: an expired key makes its next caller wait for a full load (stage 2).
- Errors are never cached (no negative caching): a key whose load always fails sends EVERY miss to the loader, one
  load at a time per key (single flight still applies to concurrent callers). Stage 2.
- A loader that never settles and ignores its signal keeps the key's flight forever for callers without a signal: put
  a timeout inside the loader (for example projects/18-resilience's `TimeoutPolicy`).
- `weigh` is called on every `set` and every loaded value; an expensive `weigh` (JSON.stringify of a large object) is
  paid on the write path.
- Keys are compared like `Map` keys (SameValueZero): two equal objects are two keys. Use string keys.
- The pinned dev dependency vitest 3.2.7 is reported by `npm audit` (3 advisories in vitest / @vitest/mocker /
  tinypool, fixed in vitest 4); test-time only, nothing of it is shipped. Not upgraded because the toolchain is
  pinned across the projects.

## NOT implemented (stage 1)

- Stale-while-revalidate, negative caching, a shared L2 (Redis) between replicas -- stage 2. Today each replica has
  its own cache, and `delete` on one replica does not invalidate the others.
- Express / NestJS helpers -- stage 3.
- Sliding expiry (TTL refreshed on read), LFU / W-TinyLFU admission, a size estimate that walks objects.
- Not published to npm; use it from this repo (copy or a local path dependency).

## Run it

```bash
cd projects/20-cache
npm ci
npm test
npm run build   # dist/
npm run bench   # per-operation cost, writes bench/reference-results/<date>-<platform>.json
```

## Files

| File | What |
|---|---|
| `src/cache.ts` | `LruCache` (LRU, weight, TTL, sweep, single-flight `getOrLoad`, stats) |
| `src/events.ts` | `CacheEvent`, `EvictionReason`, `emit` (a throwing handler is ignored) |
| `src/index.ts` | entry point |
| `test/support.ts` | manual clock, deferred promise, event recorder |
| `bench/overhead.mjs` | per-operation cost; results in `bench/reference-results/` |
