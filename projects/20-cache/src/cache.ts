import { emit, type CacheEventHandler, type EvictionReason } from "./events.js";

export interface LruCacheOptions<K, V> {
  maxEntries: number; // required: an unbounded cache is a memory leak with extra steps. Integer >= 1.
  // Optional second limit, e.g. bytes. Needs `weigh`. A single value heavier than this is never stored.
  maxWeight?: number;
  // The weight of one value (e.g. bytes); must return an integer >= 0 (else set() throws RangeError). Without
  // maxWeight it only feeds `totalWeight`.
  weigh?: (value: V, key: K) => number;
  ttlMs?: number; // default time to live for every entry; none = entries do not expire. > 0, Infinity allowed.
  // Remove expired entries every this many ms (an unref'd timer: it never keeps the process alive). Without it,
  // expired entries are removed lazily when touched or when they are the eviction victim. Stop it with close().
  sweepIntervalMs?: number;
  onEvent?: CacheEventHandler<K>;
  now?: () => number; // test hook, default performance.now (monotonic: a wall-clock jump cannot expire everything)
}

export interface SetOptions {
  ttlMs?: number; // overrides the cache's ttlMs for this entry; Infinity = never expires
}

export interface LoadOptions extends SetOptions {
  // This caller stops waiting when it aborts (rejects with signal.reason). The shared load keeps running for the
  // other callers and is aborted only when EVERY caller waiting for it has aborted.
  signal?: AbortSignal;
}

// The loader gets the load's own signal: aborted when every waiting caller has left. Pass it on (fetch, a driver).
export type Loader<V> = (signal: AbortSignal) => Promise<V> | V;

export interface CacheStats {
  hits: number; // get / getOrLoad found a live entry
  misses: number; // get / getOrLoad found nothing (or only an expired entry)
  loads: number; // loader calls started
  coalesced: number; // getOrLoad misses that joined a load already running instead of starting one
  loadErrors: number; // loads that failed (loader threw, or its result could not be stored); not aborted ones
  rejected: number; // values not stored because they alone are heavier than maxWeight
  evictions: Record<EvictionReason, number>;
}

interface Entry<V> {
  value: V;
  weight: number;
  expiresAt: number; // Infinity = never
}

// One running load for one key. The object itself is the key's load VERSION: delete(), set() and clear() detach it
// from `flights`, and a load writes its result only if it is still the attached one. Same idea as the generations in
// projects/18-resilience/src/breaker.ts: a slow load that started before a delete() must not bring the deleted
// (stale) value back.
interface Flight<V> {
  readonly controller: AbortController;
  promise: Promise<V>;
  waiters: number; // callers waiting on it; callers without a signal never leave
  settled: boolean;
}

// LRU order is the Map's insertion order: the first key is the least recently used. A hit deletes and re-inserts the
// key, which moves it to the end. Every operation is O(1) (eviction amortized, see evictOldest) except
// purgeExpired() and keys() (O(n)).
export class LruCache<K, V> {
  private readonly map = new Map<K, Entry<V>>();
  private readonly flights = new Map<K, Flight<V>>();
  private readonly maxEntries: number;
  private readonly maxWeight: number | undefined;
  private readonly ttlMs: number | undefined;
  private readonly now: () => number;
  // ONE long-lived iterator over the keys, used only to find the eviction victim. See evictOldest().
  private oldest: Iterator<K> = this.map.keys();
  private weightTotal = 0;
  private timer: NodeJS.Timeout | undefined;
  private readonly counters: CacheStats = {
    hits: 0, misses: 0, loads: 0, coalesced: 0, loadErrors: 0, rejected: 0,
    evictions: { size: 0, weight: 0, expired: 0 },
  };

  constructor(private readonly options: LruCacheOptions<K, V>) {
    this.maxEntries = options.maxEntries;
    this.maxWeight = options.maxWeight;
    this.ttlMs = options.ttlMs;
    this.now = options.now ?? (() => performance.now());
    if (!Number.isSafeInteger(this.maxEntries) || this.maxEntries < 1) throw new RangeError("maxEntries must be an integer >= 1");
    if (this.maxWeight !== undefined) {
      if (!(Number.isFinite(this.maxWeight) && this.maxWeight > 0)) throw new RangeError("maxWeight must be a finite number > 0");
      if (options.weigh === undefined) throw new TypeError("maxWeight needs a weigh(value) function");
    }
    if (this.ttlMs !== undefined) checkTtl(this.ttlMs);
    const every = options.sweepIntervalMs;
    if (every !== undefined) {
      if (!(Number.isFinite(every) && every > 0)) throw new RangeError("sweepIntervalMs must be a finite number > 0");
      this.timer = setInterval(() => this.purgeExpired(), every);
      this.timer.unref(); // a cache must never be the reason a process does not exit
    }
  }

  // Entries currently held, INCLUDING expired ones not yet removed (lazy expiry); purgeExpired() drops those.
  get size(): number {
    return this.map.size;
  }

  get totalWeight(): number {
    return this.weightTotal;
  }

  // A copy; the counters keep counting.
  stats(): CacheStats {
    return { ...this.counters, evictions: { ...this.counters.evictions } };
  }

  // Keys from least to most recently used, without touching recency or expiry (for debugging and tests).
  keys(): K[] {
    return [...this.map.keys()];
  }

  // Counts a hit or a miss and makes the key the most recently used.
  get(key: K): V | undefined {
    const entry = this.live(key);
    if (entry === undefined) {
      this.counters.misses++;
      return undefined;
    }
    this.counters.hits++;
    this.touch(key, entry);
    return entry.value;
  }

  // No recency change, no stats. An expired entry is removed and not returned.
  peek(key: K): V | undefined {
    return this.live(key)?.value;
  }

  has(key: K): boolean {
    return this.live(key) !== undefined;
  }

  // Returns false when the value was not stored because it alone is heavier than maxWeight; any older value for the
  // key is removed in that case too (keeping it would serve a value the caller just replaced). Throws RangeError for
  // an invalid weight or ttlMs, leaving the cache unchanged.
  set(key: K, value: V, options: SetOptions = {}): boolean {
    const ttl = options.ttlMs ?? this.ttlMs;
    if (ttl !== undefined) checkTtl(ttl);
    const weight = this.weighOf(value, key);
    this.flights.delete(key); // a load already running is older than this value: it must not overwrite it
    return this.store(key, value, weight, ttl);
  }

  // True if a live entry was removed. Also detaches a running load for the key: its callers still get its result,
  // but it is not written, and the next getOrLoad starts a fresh load.
  delete(key: K): boolean {
    this.flights.delete(key);
    const had = this.live(key) !== undefined;
    this.remove(key);
    return had;
  }

  // Removes everything and detaches every running load (none of them will write).
  clear(): void {
    this.map.clear();
    this.oldest = this.map.keys(); // the spec keeps an old iterator valid across clear(); a fresh one is simpler to trust
    this.flights.clear();
    this.weightTotal = 0;
  }

  // Removes every expired entry now; returns how many. O(n). The sweep timer calls this.
  purgeExpired(): number {
    const t = this.now();
    let removed = 0;
    for (const [key, entry] of this.map) {
      if (t >= entry.expiresAt) {
        this.evict(key, "expired"); // deleting the current key while iterating a Map is safe
        removed++;
      }
    }
    return removed;
  }

  // Stops the sweep timer. The cache keeps working (lazy expiry only). Safe to call twice.
  close(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  // Single flight: on a miss, concurrent callers for the same key share ONE loader call and get the same result
  // (no cache stampede). A loader error is not cached: every waiting caller gets it and the next call loads again.
  async getOrLoad(key: K, loader: Loader<V>, options: LoadOptions = {}): Promise<V> {
    const { signal } = options;
    signal?.throwIfAborted(); // an aborted caller neither joins nor starts a load
    const entry = this.live(key);
    if (entry !== undefined) {
      this.counters.hits++;
      this.touch(key, entry);
      return entry.value;
    }
    this.counters.misses++;
    let flight = this.flights.get(key);
    if (flight !== undefined) this.counters.coalesced++;
    else flight = this.startLoad(key, loader, options.ttlMs ?? this.ttlMs);
    return this.wait(key, flight, signal);
  }

  private startLoad(key: K, loader: Loader<V>, ttl: number | undefined): Flight<V> {
    if (ttl !== undefined) checkTtl(ttl); // before the loader runs, so a bad option costs no load
    const flight: Flight<V> = { controller: new AbortController(), promise: undefined as never, waiters: 0, settled: false };
    this.flights.set(key, flight);
    this.counters.loads++;
    emit(this.options.onEvent, { type: "load", key });
    flight.promise = (async () => {
      try {
        const value = await loader(flight.controller.signal); // a sync throw becomes a rejection here too
        if (this.flights.get(key) === flight) {
          // Still the current version of this key: nothing deleted, replaced or cleared it meanwhile.
          this.flights.delete(key);
          this.store(key, value, this.weighOf(value, key), ttl);
        }
        return value;
      } catch (error) {
        if (this.flights.get(key) === flight) this.flights.delete(key); // not cached: the next call loads again
        if (!flight.controller.signal.aborted) {
          this.counters.loadErrors++;
          emit(this.options.onEvent, { type: "load-error", key, error });
        }
        throw error;
      } finally {
        flight.settled = true;
      }
    })();
    flight.promise.catch(() => {}); // if every caller left, nobody else handles the rejection
    return flight;
  }

  private wait(key: K, flight: Flight<V>, signal: AbortSignal | undefined): Promise<V> {
    flight.waiters++;
    if (signal === undefined) return flight.promise;
    return new Promise<V>((resolve, reject) => {
      const onAbort = () => {
        this.leave(key, flight, signal.reason);
        reject(signal.reason);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      flight.promise.then(
        (value) => {
          signal.removeEventListener("abort", onAbort);
          resolve(value);
        },
        (error: unknown) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      );
    });
  }

  // A waiting caller aborted. The load goes on for the others; when the last one leaves, nobody wants the result:
  // abort the loader's signal and detach the flight so a later caller starts a fresh load instead of joining a
  // cancelled one (and an aborted load that still returns a value writes nothing).
  private leave(key: K, flight: Flight<V>, reason: unknown): void {
    flight.waiters--;
    if (flight.waiters > 0 || flight.settled) return;
    if (this.flights.get(key) === flight) this.flights.delete(key);
    flight.controller.abort(reason);
    emit(this.options.onEvent, { type: "load-abort", key });
  }

  // The entry if present and not expired. An expired entry found here is removed (lazy expiry): it is never returned.
  private live(key: K): Entry<V> | undefined {
    const entry = this.map.get(key);
    if (entry === undefined) return undefined;
    if (this.now() >= entry.expiresAt) {
      // Boundary: an entry set at t with ttlMs 100 is expired AT t + 100, not after.
      this.evict(key, "expired");
      return undefined;
    }
    return entry;
  }

  private touch(key: K, entry: Entry<V>): void {
    this.map.delete(key);
    this.map.set(key, entry);
  }

  private store(key: K, value: V, weight: number, ttl: number | undefined): boolean {
    this.remove(key);
    if (this.maxWeight !== undefined && weight > this.maxWeight) {
      this.counters.rejected++;
      emit(this.options.onEvent, { type: "reject", key, weight });
      return false;
    }
    this.map.set(key, { value, weight, expiresAt: ttl === undefined ? Infinity : this.now() + ttl });
    this.weightTotal += weight;
    while (this.map.size > this.maxEntries) this.evictOldest("size");
    // The new entry is last and weighs <= maxWeight on its own, so with correct bookkeeping this loop stops before
    // reaching it. `size > 1` is a guard, not a rule: if the total ever drifted from the entries (a bug), the loop
    // would otherwise spin forever on an empty map (found by mutation W5, which hung the test run).
    if (this.maxWeight !== undefined) {
      while (this.weightTotal > this.maxWeight && this.map.size > 1) this.evictOldest("weight");
    }
    return true;
  }

  // Why a long-lived iterator and not `this.map.keys().next()`: V8 leaves a hole in a Map's table for every deleted
  // entry until the next rehash, and a NEW iterator starts at slot 0, so it walks over every hole left by earlier
  // evictions. Measured: 10.4 us per evicting set on a 10 000-entry cache (bench/reference-results/
  // 2026-11-23-win32-before-iterator-fix.json). By the language spec a Map iterator skips deleted entries and DOES
  // visit entries appended after it was created. Every live key is at or after this iterator's position (keys only
  // ever leave, or are re-appended at the end by a hit or a set), so next() is always the least recently used key,
  // and each hole is walked over once in total instead of once per eviction.
  private evictOldest(reason: EvictionReason): void {
    let next = this.oldest.next();
    if (next.done) {
      // A finished iterator stays finished, even if keys are added later. Not reached while the map holds keys
      // (see above), but cheap to be safe.
      this.oldest = this.map.keys();
      next = this.oldest.next();
      if (next.done) return;
    }
    const key = next.value;
    const entry = this.map.get(key)!;
    // A victim that had already expired is reported as expired, not as pushed out by the limit.
    this.evict(key, this.now() >= entry.expiresAt ? "expired" : reason);
  }

  private evict(key: K, reason: EvictionReason): void {
    this.remove(key);
    this.counters.evictions[reason]++;
    emit(this.options.onEvent, { type: "evict", key, reason });
  }

  private remove(key: K): void {
    const entry = this.map.get(key);
    if (entry === undefined) return;
    this.map.delete(key);
    this.weightTotal -= entry.weight;
  }

  private weighOf(value: V, key: K): number {
    if (this.options.weigh === undefined) return 0;
    const w = this.options.weigh(value, key);
    // Integers only: fractional weights drift when added and subtracted many times (0.1 + 0.2 - 0.1 - 0.2 is not 0),
    // and the total would no longer match the entries.
    if (!Number.isSafeInteger(w) || w < 0) {
      throw new RangeError(`weigh() must return an integer >= 0, got ${String(w)}`);
    }
    return w;
  }
}

function checkTtl(ttl: number): void {
  if (typeof ttl !== "number" || Number.isNaN(ttl) || ttl <= 0) throw new RangeError("ttlMs must be a number > 0 (Infinity = never expires)");
}
