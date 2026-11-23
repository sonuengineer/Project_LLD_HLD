import { emit, type CacheEventHandler, type EvictionReason } from "./events.js";

export interface LruCacheOptions<K, V> {
  maxEntries: number; // required: an unbounded cache is a memory leak with extra steps. Integer >= 1.
  // Optional second limit, e.g. bytes. Needs `weigh`. A single value heavier than this is never stored.
  maxWeight?: number;
  // The weight of one value (e.g. bytes); must return an integer >= 0 (else set() throws RangeError). Without
  // maxWeight it only feeds `totalWeight`.
  weigh?: (value: V, key: K) => number;
  ttlMs?: number; // default time to live for every entry; none = entries do not expire. > 0, Infinity allowed.
  // Stale-while-revalidate grace after the TTL, default 0 (none). Within it, getOrLoad returns the old value at once
  // and starts ONE background refresh; get / peek / has already treat the entry as gone. >= 0, Infinity allowed.
  staleMs?: number;
  // Negative caching: a LOADED value for which isNegative(value) is true ("not found") is stored for at most this
  // long, with no stale grace. Without it, negative caching is off and such a value is cached like any other.
  negativeTtlMs?: number;
  // Which loaded values mean "not found". Default: null or undefined. Needs negativeTtlMs.
  isNegative?: (value: V) => boolean;
  // Remove expired entries every this many ms (an unref'd timer: it never keeps the process alive). Without it,
  // expired entries are removed lazily when touched or when they are the eviction victim. Stop it with close().
  sweepIntervalMs?: number;
  onEvent?: CacheEventHandler<K>;
  now?: () => number; // test hook, default performance.now (monotonic: a wall-clock jump cannot expire everything)
}

export interface SetOptions {
  ttlMs?: number; // overrides the cache's ttlMs for this entry; Infinity = never expires
  staleMs?: number; // overrides the cache's staleMs for this entry
}

export interface LoadOptions extends SetOptions {
  // This caller stops waiting when it aborts (rejects with signal.reason). The shared load keeps running for the
  // other callers and is aborted only when EVERY caller waiting for it has aborted.
  signal?: AbortSignal;
}

// What the loader may read and change about the value it is producing.
export interface LoadContext {
  // The TTL the loaded value will be stored with: the call's ttlMs, else the cache default (undefined = no expiry).
  // The loader may change it, e.g. from an HTTP max-age or from the remaining TTL of a shared L2 copy. A negative
  // value is still capped at negativeTtlMs. An invalid value set here fails the load (RangeError, like weigh).
  ttlMs: number | undefined;
  // True for a stale-while-revalidate background refresh (no caller is waiting for it).
  readonly refresh: boolean;
  // True while this load is still the key's current version: no delete / set / clear since it started. A loader
  // that writes somewhere else too (TwoLevelCache writes Redis) checks it first, so it does not spread a value the
  // cache itself will not store.
  isCurrent(): boolean;
}

// The loader gets the load's own signal: aborted when every waiting caller has left. Pass it on (fetch, a driver).
export type Loader<V> = (signal: AbortSignal, context: LoadContext) => Promise<V> | V;

export interface CacheStats {
  hits: number; // get / getOrLoad found a fresh entry (negative ones included)
  misses: number; // get / getOrLoad found nothing usable (get: nothing fresh; getOrLoad: nothing fresh or stale)
  staleHits: number; // getOrLoad returned a stale value within the grace (neither a hit nor a miss)
  negativeHits: number; // the part of `hits` that found a cached "not found"
  loads: number; // loader calls started (background refreshes included)
  refreshes: number; // the part of `loads` that were stale-while-revalidate background refreshes
  coalesced: number; // getOrLoad misses that joined a load already running instead of starting one
  loadErrors: number; // loads that failed (loader threw, or its result could not be stored); not aborted ones
  refreshErrors: number; // the part of `loadErrors` that were background refreshes (the stale value stays)
  rejected: number; // values not stored because they alone are heavier than maxWeight
  evictions: Record<EvictionReason, number>;
}

interface Entry<V> {
  value: V;
  weight: number;
  expiresAt: number; // end of the fresh time; Infinity = never
  deadAt: number; // end of the stale grace (= expiresAt when there is none): removed from here on
  negative: boolean; // a cached "not found" (only ever set for loaded values)
}

// One running load for one key. The object itself is the key's load VERSION: delete(), set() and clear() detach it
// from `flights`, and a load writes its result only if it is still the attached one. Same idea as the generations in
// projects/18-resilience/src/breaker.ts: a slow load that started before a delete() must not bring the deleted
// (stale) value back. A background refresh is a flight like any other, so a refresh cannot overwrite a newer set or
// delete either.
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
  private readonly staleMs: number;
  private readonly negativeTtlMs: number | undefined;
  private readonly isNegative: ((value: V) => boolean) | undefined;
  private readonly now: () => number;
  // ONE long-lived iterator over the keys, used only to find the eviction victim. See evictOldest().
  private oldest: Iterator<K> = this.map.keys();
  private weightTotal = 0;
  private timer: NodeJS.Timeout | undefined;
  private readonly counters: CacheStats = {
    hits: 0, misses: 0, staleHits: 0, negativeHits: 0, loads: 0, refreshes: 0, coalesced: 0, loadErrors: 0,
    refreshErrors: 0, rejected: 0, evictions: { size: 0, weight: 0, expired: 0 },
  };

  constructor(private readonly options: LruCacheOptions<K, V>) {
    this.maxEntries = options.maxEntries;
    this.maxWeight = options.maxWeight;
    this.ttlMs = options.ttlMs;
    this.staleMs = options.staleMs ?? 0;
    this.negativeTtlMs = options.negativeTtlMs;
    this.now = options.now ?? (() => performance.now());
    if (!Number.isSafeInteger(this.maxEntries) || this.maxEntries < 1) throw new RangeError("maxEntries must be an integer >= 1");
    if (this.maxWeight !== undefined) {
      if (!(Number.isFinite(this.maxWeight) && this.maxWeight > 0)) throw new RangeError("maxWeight must be a finite number > 0");
      if (options.weigh === undefined) throw new TypeError("maxWeight needs a weigh(value) function");
    }
    if (this.ttlMs !== undefined) checkTtl(this.ttlMs);
    checkStale(this.staleMs);
    if (this.negativeTtlMs !== undefined) {
      checkTtl(this.negativeTtlMs, "negativeTtlMs");
      this.isNegative = options.isNegative ?? ((v) => v === undefined || v === null);
    } else if (options.isNegative !== undefined) {
      // Without a TTL for them, "negative" would mean nothing; failing loudly beats a silently ignored option.
      throw new TypeError("isNegative needs negativeTtlMs");
    }
    const every = options.sweepIntervalMs;
    if (every !== undefined) {
      if (!(Number.isFinite(every) && every > 0)) throw new RangeError("sweepIntervalMs must be a finite number > 0");
      this.timer = setInterval(() => this.purgeExpired(), every);
      this.timer.unref(); // a cache must never be the reason a process does not exit
    }
  }

  // Entries currently held, INCLUDING stale ones and expired ones not yet removed (lazy expiry); purgeExpired()
  // drops the expired ones.
  get size(): number {
    return this.map.size;
  }

  get totalWeight(): number {
    return this.weightTotal;
  }

  // The cache-wide ttlMs (undefined = no expiry). TwoLevelCache reads it to give a set() the same TTL in Redis.
  get defaultTtlMs(): number | undefined {
    return this.ttlMs;
  }

  // The TTL a LOADED value is stored with, given the TTL the load asked for: a negative value is capped at
  // negativeTtlMs. TwoLevelCache uses it so the Redis copy expires with the in-process one.
  loadedTtl(value: V, ttlMs: number | undefined): number | undefined {
    if (this.negativeOf(value)) return Math.min(ttlMs ?? Infinity, this.negativeTtlMs!);
    return ttlMs;
  }

  // A copy; the counters keep counting.
  stats(): CacheStats {
    return { ...this.counters, evictions: { ...this.counters.evictions } };
  }

  // Keys from least to most recently used, without touching recency or expiry (for debugging and tests).
  keys(): K[] {
    return [...this.map.keys()];
  }

  // Counts a hit or a miss and makes the key the most recently used. A stale entry (past its TTL, within the grace)
  // is NOT returned: get has no loader, so it cannot refresh it, and returning it would make the TTL mean nothing
  // to every caller that does not use getOrLoad. It is kept for getOrLoad, counted as a miss.
  get(key: K): V | undefined {
    const entry = this.fresh(key);
    if (entry === undefined) {
      this.counters.misses++;
      return undefined;
    }
    this.hit(key, entry);
    return entry.value;
  }

  // No recency change, no stats. An expired entry is removed and not returned; a stale one is not returned.
  peek(key: K): V | undefined {
    return this.fresh(key)?.value;
  }

  has(key: K): boolean {
    return this.fresh(key) !== undefined;
  }

  // Returns false when the value was not stored because it alone is heavier than maxWeight; any older value for the
  // key is removed in that case too (keeping it would serve a value the caller just replaced). Throws RangeError for
  // an invalid weight, ttlMs or staleMs, leaving the cache unchanged.
  set(key: K, value: V, options: SetOptions = {}): boolean {
    const ttl = options.ttlMs ?? this.ttlMs;
    if (ttl !== undefined) checkTtl(ttl);
    const stale = options.staleMs ?? this.staleMs;
    checkStale(stale);
    const weight = this.weighOf(value, key);
    this.flights.delete(key); // a load already running is older than this value: it must not overwrite it
    return this.store(key, value, weight, ttl, stale, false);
  }

  // True if a FRESH entry was removed (the same answer has() would have given); a stale entry is removed too. Also
  // detaches a running load or refresh for the key: its callers still get its result, but it is not written, and the
  // next getOrLoad starts a fresh load.
  delete(key: K): boolean {
    this.flights.delete(key);
    const had = this.fresh(key) !== undefined;
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

  // Removes every expired entry (past its stale grace) now; returns how many. O(n). The sweep timer calls this.
  purgeExpired(): number {
    const t = this.now();
    let removed = 0;
    for (const [key, entry] of this.map) {
      if (t >= entry.deadAt) {
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
  // Stale-while-revalidate: a stale entry (past its TTL, within its staleMs grace) is returned at once and ONE
  // background refresh starts unless a load for the key is already running.
  async getOrLoad(key: K, loader: Loader<V>, options: LoadOptions = {}): Promise<V> {
    const { signal } = options;
    signal?.throwIfAborted(); // an aborted caller neither joins nor starts a load
    const entry = this.live(key);
    if (entry !== undefined) {
      if (this.now() < entry.expiresAt) {
        this.hit(key, entry);
        return entry.value;
      }
      // Stale. A failed refresh leaves the entry as it is, so the next stale read serves it again and tries again.
      this.counters.staleHits++;
      this.touch(key, entry);
      if (!this.flights.has(key)) this.startLoad(key, loader, options, true);
      return entry.value;
    }
    this.counters.misses++;
    let flight = this.flights.get(key);
    if (flight !== undefined) this.counters.coalesced++;
    else flight = this.startLoad(key, loader, options, false);
    return this.wait(key, flight, signal);
  }

  private startLoad(key: K, loader: Loader<V>, options: SetOptions, refresh: boolean): Flight<V> {
    const ttl = options.ttlMs ?? this.ttlMs;
    const stale = options.staleMs ?? this.staleMs;
    // Before the loader runs, so a bad option costs no load.
    if (ttl !== undefined) checkTtl(ttl);
    checkStale(stale);
    // A refresh counts the cache itself as one waiter that never leaves: a caller that joins it after the grace
    // ended and then aborts must not abort a refresh the cache started for everybody.
    const flight: Flight<V> = { controller: new AbortController(), promise: undefined as never, waiters: refresh ? 1 : 0, settled: false };
    this.flights.set(key, flight);
    this.counters.loads++;
    if (refresh) this.counters.refreshes++;
    emit(this.options.onEvent, { type: refresh ? "refresh" : "load", key });
    const context: LoadContext = { ttlMs: ttl, refresh, isCurrent: () => this.flights.get(key) === flight };
    flight.promise = (async () => {
      try {
        const value = await loader(flight.controller.signal, context); // a sync throw becomes a rejection here too
        if (this.flights.get(key) === flight) {
          // Still the current version of this key: nothing deleted, replaced or cleared it meanwhile.
          if (context.ttlMs !== undefined) checkTtl(context.ttlMs); // the loader may have changed it
          const negative = this.negativeOf(value);
          const weight = this.weighOf(value, key);
          this.flights.delete(key);
          this.store(key, value, weight, this.loadedTtl(value, context.ttlMs), negative ? 0 : stale, negative);
        }
        return value;
      } catch (error) {
        if (this.flights.get(key) === flight) this.flights.delete(key); // not cached: the next call loads again
        if (!flight.controller.signal.aborted) {
          this.counters.loadErrors++;
          if (refresh) this.counters.refreshErrors++;
          emit(this.options.onEvent, { type: refresh ? "refresh-error" : "load-error", key, error });
        }
        throw error;
      } finally {
        flight.settled = true;
      }
    })();
    flight.promise.catch(() => {}); // if every caller left (or nobody waits: a refresh), nobody else handles it
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

  private hit(key: K, entry: Entry<V>): void {
    this.counters.hits++;
    if (entry.negative) this.counters.negativeHits++;
    this.touch(key, entry);
  }

  // The entry if present and not past its stale grace. An entry past it is removed here (lazy expiry): it is never
  // returned. A stale entry IS returned; callers that want only fresh values use fresh().
  private live(key: K): Entry<V> | undefined {
    const entry = this.map.get(key);
    if (entry === undefined) return undefined;
    if (this.now() >= entry.deadAt) {
      // Boundary: an entry set at t with ttlMs 100 (and no grace) is expired AT t + 100, not after.
      this.evict(key, "expired");
      return undefined;
    }
    return entry;
  }

  // The entry if fresh (before its TTL). A stale one is left in place for getOrLoad; an expired one is removed.
  private fresh(key: K): Entry<V> | undefined {
    const entry = this.live(key);
    return entry !== undefined && this.now() < entry.expiresAt ? entry : undefined;
  }

  private touch(key: K, entry: Entry<V>): void {
    this.map.delete(key);
    this.map.set(key, entry);
  }

  private store(key: K, value: V, weight: number, ttl: number | undefined, stale: number, negative: boolean): boolean {
    this.remove(key);
    if (this.maxWeight !== undefined && weight > this.maxWeight) {
      this.counters.rejected++;
      emit(this.options.onEvent, { type: "reject", key, weight });
      return false;
    }
    const expiresAt = ttl === undefined ? Infinity : this.now() + ttl;
    this.map.set(key, { value, weight, expiresAt, deadAt: expiresAt + stale, negative });
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
    // A victim that had already expired is reported as expired, not as pushed out by the limit. A stale victim
    // (within its grace) was still usable, so it is reported with the limit's reason.
    this.evict(key, this.now() >= entry.deadAt ? "expired" : reason);
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

  private negativeOf(value: V): boolean {
    return this.isNegative !== undefined && this.isNegative(value);
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

function checkTtl(ttl: number, name = "ttlMs"): void {
  if (typeof ttl !== "number" || Number.isNaN(ttl) || ttl <= 0) throw new RangeError(`${name} must be a number > 0 (Infinity = never expires)`);
}

function checkStale(ms: number): void {
  if (typeof ms !== "number" || Number.isNaN(ms) || ms < 0) throw new RangeError("staleMs must be a number >= 0 (Infinity allowed)");
}
