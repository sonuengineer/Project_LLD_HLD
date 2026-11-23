import { describe, expect, it } from "vitest";
import { LruCache, type CacheStats, type EvictionReason } from "../src/index.js";
import { flush, manualClock } from "./support.js";

// Small seeded PRNG (mulberry32) so a failure is reproducible from the seed in the test name.
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The naive reference: an array in recency order (index 0 = least recently used), O(n) everything, written from the
// rules in the README, not from the Map implementation. Stage 2 added the stale grace (fresh until expiresAt, served
// stale by getOrLoad until deadAt) and negative caching (a LOADED 0 means "not found").
interface ModelEntry { key: number; value: number; expiresAt: number; deadAt: number; negative: boolean }
class Model {
  list: ModelEntry[] = [];
  stats: CacheStats = {
    hits: 0, misses: 0, staleHits: 0, negativeHits: 0, loads: 0, refreshes: 0, coalesced: 0, loadErrors: 0,
    refreshErrors: 0, rejected: 0, evictions: { size: 0, weight: 0, expired: 0 },
  };
  constructor(
    private maxEntries: number,
    private maxWeight: number,
    private defaultTtl: number | undefined,
    private defaultStale: number,
    private negativeTtl: number | undefined,
    private now: () => number,
  ) {}
  weight() { return this.list.reduce((s, e) => s + e.value, 0); }
  private find(key: number) { return this.list.findIndex((e) => e.key === key); }
  private liveIndex(key: number) {
    const i = this.find(key);
    if (i < 0) return -1;
    if (this.now() >= this.list[i]!.deadAt) {
      this.list.splice(i, 1);
      this.stats.evictions.expired++;
      return -1;
    }
    return i;
  }
  private freshIndex(key: number) {
    const i = this.liveIndex(key);
    return i >= 0 && this.now() < this.list[i]!.expiresAt ? i : -1;
  }
  private toEnd(i: number) {
    const [e] = this.list.splice(i, 1);
    this.list.push(e!);
    return e!;
  }
  private hit(i: number) {
    this.stats.hits++;
    const e = this.toEnd(i);
    if (e.negative) this.stats.negativeHits++;
    return e.value;
  }
  get(key: number) {
    const i = this.freshIndex(key);
    if (i < 0) { this.stats.misses++; return undefined; }
    return this.hit(i);
  }
  peek(key: number) { const i = this.freshIndex(key); return i < 0 ? undefined : this.list[i]!.value; }
  has(key: number) { return this.freshIndex(key) >= 0; }
  delete(key: number) {
    const had = this.freshIndex(key) >= 0;
    const i = this.find(key);
    if (i >= 0) this.list.splice(i, 1);
    return had;
  }
  set(key: number, value: number, ttl: number | undefined, stale: number | undefined) {
    return this.store(key, value, ttl ?? this.defaultTtl, stale ?? this.defaultStale, false);
  }
  // A loaded value: negative ones get min(ttl, negativeTtl) and no grace.
  private storeLoaded(key: number, value: number, ttl: number | undefined, stale: number | undefined) {
    const t = ttl ?? this.defaultTtl;
    const negative = this.negativeTtl !== undefined && value === 0;
    if (negative) this.store(key, value, Math.min(t ?? Infinity, this.negativeTtl!), 0, true);
    else this.store(key, value, t, stale ?? this.defaultStale, false);
  }
  // `next` is what the loader returns. A stale entry is returned and refreshed (the test awaits the refresh before
  // comparing, so the model applies it at once).
  getOrLoad(key: number, next: number, ttl: number | undefined, stale: number | undefined) {
    const i = this.liveIndex(key);
    if (i >= 0 && this.now() < this.list[i]!.expiresAt) return this.hit(i);
    this.stats.loads++;
    if (i >= 0) {
      this.stats.staleHits++;
      this.stats.refreshes++;
      const old = this.toEnd(i).value;
      this.storeLoaded(key, next, ttl, stale);
      return old;
    }
    this.stats.misses++;
    this.storeLoaded(key, next, ttl, stale);
    return next;
  }
  private store(key: number, value: number, t: number | undefined, stale: number, negative: boolean) {
    const i = this.find(key);
    if (i >= 0) this.list.splice(i, 1);
    if (value > this.maxWeight) { this.stats.rejected++; return false; }
    const expiresAt = t === undefined ? Infinity : this.now() + t;
    this.list.push({ key, value, expiresAt, deadAt: expiresAt + stale, negative });
    const evictFirst = (reason: EvictionReason) => {
      const victim = this.list.shift()!;
      this.stats.evictions[this.now() >= victim.deadAt ? "expired" : reason]++;
    };
    while (this.list.length > this.maxEntries) evictFirst("size");
    while (this.weight() > this.maxWeight) evictFirst("weight");
    return true;
  }
  purge() {
    const before = this.list.length;
    this.list = this.list.filter((e) => this.now() < e.deadAt);
    this.stats.evictions.expired += before - this.list.length;
    return before - this.list.length;
  }
}

// Summed over all seeds, checked by the last test: proof the random steps reached every rule they claim to test.
const seen = { hits: 0, misses: 0, rejected: 0, size: 0, weight: 0, expired: 0, staleHits: 0, negativeHits: 0 };

describe("randomized against a naive model", () => {
  for (const seed of [1, 2, 3, 42, 1337, 2024, 9001, 123456]) {
    it(`seed ${seed}: 3000 random steps, identical after every step`, async () => {
      const rand = rng(seed);
      const int = (n: number) => Math.floor(rand() * n);
      const clock = manualClock();
      const maxEntries = 1 + int(6);
      const maxWeight = 10 + int(30);
      const defaultTtl = rand() < 0.5 ? undefined : 5 + int(50);
      const staleMs = rand() < 0.3 ? undefined : int(30);
      const negativeTtlMs = rand() < 0.3 ? undefined : 1 + int(20);
      const cache = new LruCache<number, number>({
        maxEntries, maxWeight, weigh: (v) => v, ttlMs: defaultTtl, staleMs, now: clock.now,
        ...(negativeTtlMs === undefined ? {} : { negativeTtlMs, isNegative: (v: number) => v === 0 }),
      });
      const model = new Model(maxEntries, maxWeight, defaultTtl, staleMs ?? 0, negativeTtlMs, clock.now);
      const log: string[] = [];
      const ttlOpt = () => (rand() < 0.3 ? 1 + int(40) : undefined);
      const staleOpt = () => (rand() < 0.2 ? int(30) : undefined);
      for (let step = 0; step < 3000; step++) {
        const key = int(10);
        const r = rand();
        let got: unknown;
        let want: unknown;
        if (r < 0.25) {
          log.push(`get ${key}`);
          got = cache.get(key);
          want = model.get(key);
        } else if (r < 0.45) {
          const value = int(maxWeight + 3); // sometimes heavier than maxWeight on its own
          const ttl = ttlOpt();
          const stale = staleOpt();
          log.push(`set ${key}=${value} ttl ${ttl} stale ${stale}`);
          got = cache.set(key, value, { ttlMs: ttl, staleMs: stale });
          want = model.set(key, value, ttl, stale);
        } else if (r < 0.6) {
          // Fewer keys and mostly a short TTL with a grace: otherwise stale reads are too rare to test anything.
          const k = int(4);
          // 0 = "not found" when negative caching is on; mostly light values (heavy ones evict everything), sometimes
          // one too heavy to store.
          const v = rand();
          const next = v < 0.25 ? 0 : v < 0.9 ? 1 + int(5) : int(maxWeight + 3);
          const ttl = rand() < 0.7 ? 1 + int(20) : undefined;
          const stale = rand() < 0.7 ? 5 + int(40) : undefined;
          log.push(`getOrLoad ${k} -> ${next} ttl ${ttl} stale ${stale}`);
          got = await cache.getOrLoad(k, () => next, { ttlMs: ttl, staleMs: stale });
          await flush(); // lets a background refresh finish
          want = model.getOrLoad(k, next, ttl, stale);
        } else if (r < 0.68) {
          log.push(`delete ${key}`);
          got = cache.delete(key);
          want = model.delete(key);
        } else if (r < 0.76) {
          log.push(`peek ${key}`);
          got = cache.peek(key);
          want = model.peek(key);
        } else if (r < 0.82) {
          log.push(`has ${key}`);
          got = cache.has(key);
          want = model.has(key);
        } else if (r < 0.85) {
          log.push("purge");
          got = cache.purgeExpired();
          want = model.purge();
        } else if (r < 0.86) {
          log.push("clear");
          cache.clear();
          model.list = [];
        } else {
          const ms = int(15);
          log.push(`advance ${ms}`);
          clock.advance(ms);
        }
        const ctx = `seed ${seed} step ${step}; last ops: ${log.slice(-8).join(" | ")}`;
        expect(got, ctx).toEqual(want);
        expect(cache.keys(), ctx).toEqual(model.list.map((e) => e.key));
        expect(cache.totalWeight, ctx).toBe(model.weight());
        expect(cache.stats(), ctx).toEqual(model.stats);
      }
      const s = cache.stats();
      seen.hits += s.hits;
      seen.misses += s.misses;
      seen.rejected += s.rejected;
      seen.size += s.evictions.size;
      seen.weight += s.evictions.weight;
      seen.expired += s.evictions.expired;
      seen.staleHits += s.staleHits;
      seen.negativeHits += s.negativeHits;
    });
  }

  it("the random steps exercised hits, misses, rejects, all three eviction reasons, stale hits and negative hits", () => {
    for (const [name, n] of Object.entries(seen)) expect(n, name).toBeGreaterThan(50);
    console.log("model coverage over all seeds:", JSON.stringify(seen));
  });
});
