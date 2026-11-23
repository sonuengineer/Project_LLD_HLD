# A20 (build your own) -- cache-kit: plan

Status (2026-11-23): stage 1 DONE (LRU with max entries and max weight, TTL with lazy expiry and an optional unref'd
sweep, single-flight `getOrLoad` with per-caller abort and load versions against stale writes, stats and events;
tested against a naive reference model with seeded random steps; deliberate breaks, see README "Mutation checks").
Stages 2 and 3 not started.

## Why this project

Most backend latency is repeated work: the same DB query, the same call to another service, the same config lookup,
thousands of times a minute. An in-process cache removes it -- and the naive version (a `Map` plus `setTimeout`)
brings its own failures: it grows until the process runs out of memory, it serves values after they expired, and on
a cold key under load it sends 100 identical queries to the database at once (a cache stampede). This is a small
library to cache any expensive call, usable in the owner's own Express / NestJS services, workers and scripts.

Established libraries exist (`lru-cache`, `cacheable`, `async-cache-dedupe`). Building one by hand is about knowing
exactly what each rule does and where it breaks.

## Decisions (one recommendation each)

- **TypeScript, zero runtime dependencies, Node 20.3+.** Same toolchain as projects/18-resilience.
- **LRU on a JavaScript `Map`, not a hand-written doubly linked list.** A Map iterates in insertion order, so the
  first key is the least recently used; a hit is `delete` + `set` (moves the key to the end). All O(1), no node
  objects, far less code. Chosen over a linked list + hash map, which is the textbook answer but here only adds code
  to get wrong. One catch, found by the benchmark: the eviction victim must come from ONE long-lived `keys()`
  iterator, not a new `map.keys().next()` per eviction, which walked over the holes left by deleted entries
  (10.4 us per evicting set before, about 0.6 us after; see README "Overhead").
- **`maxEntries` is required.** A cache without a bound is a slow memory leak. `maxWeight` + `weigh(value)` is the
  optional second bound for values of very different sizes (bytes of a JSON string).
- **A value heavier than `maxWeight` on its own is not stored** (`set` returns false, a `reject` event), and the
  key's older value is removed. Recommended over storing it (it would evict everything else and still be over the
  limit) and over keeping the old value (the caller just replaced it; serving the old one is a stale read).
- **`weigh` must return an integer >= 0; anything else (NaN, negative, Infinity, a fraction, not a number) throws**
  and leaves the cache unchanged. A wrong weight silently corrupts the total; failing loudly finds the bug.
  Fractions are refused because a running float total drifts (0.1 + 0.2 - 0.1 - 0.2 is not 0); bytes are integers.
- **Lazy expiry, plus an OPTIONAL sweep.** Every read checks the expiry, so an expired value is never returned, with
  no timer at all. The sweep (`sweepIntervalMs`) only frees memory held by expired entries nobody reads; its timer is
  `unref`'d so a cache never keeps a process alive, and `close()` stops it.
- **TTL boundary: expired AT `set time + ttlMs`**, not after. One rule, tested at both sides.
- **TTL counts from `set`, not from the last read** (no sliding expiry). A hot key must still be refreshed now and
  then, or it would never pick up changes.
- **Default clock `performance.now()` (monotonic), injectable.** A wall-clock jump (NTP, a VM resume) must not expire
  or resurrect everything at once; tests move a manual clock instead of waiting.
- **Single flight per key in `getOrLoad`.** Concurrent misses for the same key share one loader call. A loader error
  is never cached (every waiter gets it; the next call tries again) -- recommended over caching errors for a while,
  which is stage 2's "negative caching" and needs its own short TTL.
- **Abort: a caller leaving stops only ITS wait.** The shared load continues for the others and is aborted (through
  the signal the loader got) only when every waiting caller has left. A caller without a signal never leaves, so it
  keeps the load alive. Recommended over aborting the load when the first caller aborts (one impatient client would
  fail everybody) and over never aborting it (work nobody wants).
- **Load versions against stale writes.** `delete`, `set` and `clear` detach the running load; a load writes its
  result only if it is still the attached one (the flight object is the version, the same idea as the generations in
  projects/18-resilience/src/breaker.ts). So after `delete(key)` because the row changed, a slow load that started
  before cannot bring the old row back, and the next caller starts a fresh load instead of joining the old one. The
  callers already waiting still get the old load's result (it is what they asked for).
- **Stats are counters, events are for things the cache does by itself** (evictions, loads, rejects, aborts). Hits
  and misses are counters only: an event per read would cost every call. A throwing event handler is ignored.

## Stages

| Stage | What | Status |
|---|---|---|
| 1 | `LruCache`: max entries + max weight, O(1) get/set/delete, peek/has/clear/size; TTL (default + per entry, lazy expiry, optional unref'd sweep, close); single-flight `getOrLoad` (shared errors not cached, per-caller abort, load aborted when all leave, load versions against stale writes); stats and events; randomized test against a naive model; mutation checks | DONE 2026-11-23 |
| 2 | Stale-while-revalidate (serve the old value for a grace period while one background load refreshes it), negative caching (cache "not found" / errors for a short separate TTL), a Redis-backed L2 adapter (L1 in process, L2 shared between replicas; invalidation between them) | not started |
| 3 | Express / NestJS helpers (cache a route's response or a service method, keyed by request), interview bank, portfolio page | not started |

## Not in scope

Cross-process consistency beyond what stage 2's L2 gives, write-through / write-behind to a database, LFU or
W-TinyLFU admission (what Caffeine does), HTTP caching semantics (Cache-Control, ETag) -- a reverse proxy or CDN
does that better.
