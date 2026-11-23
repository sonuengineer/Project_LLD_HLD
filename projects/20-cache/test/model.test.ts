import { describe, expect, it } from "vitest";
import { LruCache, type CacheStats, type EvictionReason } from "../src/index.js";
import { manualClock } from "./support.js";

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
// rules in the README, not from the Map implementation.
interface ModelEntry { key: number; value: number; expiresAt: number }
class Model {
  list: ModelEntry[] = [];
  stats: CacheStats = { hits: 0, misses: 0, loads: 0, coalesced: 0, loadErrors: 0, rejected: 0, evictions: { size: 0, weight: 0, expired: 0 } };
  constructor(private maxEntries: number, private maxWeight: number, private defaultTtl: number | undefined, private now: () => number) {}
  weight() { return this.list.reduce((s, e) => s + e.value, 0); }
  private find(key: number) { return this.list.findIndex((e) => e.key === key); }
  private liveIndex(key: number) {
    const i = this.find(key);
    if (i < 0) return -1;
    if (this.now() >= this.list[i]!.expiresAt) {
      this.list.splice(i, 1);
      this.stats.evictions.expired++;
      return -1;
    }
    return i;
  }
  get(key: number) {
    const i = this.liveIndex(key);
    if (i < 0) { this.stats.misses++; return undefined; }
    this.stats.hits++;
    const [e] = this.list.splice(i, 1);
    this.list.push(e!);
    return e!.value;
  }
  peek(key: number) { const i = this.liveIndex(key); return i < 0 ? undefined : this.list[i]!.value; }
  has(key: number) { return this.liveIndex(key) >= 0; }
  delete(key: number) {
    const had = this.liveIndex(key) >= 0;
    const i = this.find(key);
    if (i >= 0) this.list.splice(i, 1);
    return had;
  }
  set(key: number, value: number, ttl: number | undefined) {
    const t = ttl ?? this.defaultTtl;
    const i = this.find(key);
    if (i >= 0) this.list.splice(i, 1);
    if (value > this.maxWeight) { this.stats.rejected++; return false; }
    this.list.push({ key, value, expiresAt: t === undefined ? Infinity : this.now() + t });
    const evictFirst = (reason: EvictionReason) => {
      const victim = this.list.shift()!;
      this.stats.evictions[this.now() >= victim.expiresAt ? "expired" : reason]++;
    };
    while (this.list.length > this.maxEntries) evictFirst("size");
    while (this.weight() > this.maxWeight) evictFirst("weight");
    return true;
  }
  purge() {
    const before = this.list.length;
    this.list = this.list.filter((e) => this.now() < e.expiresAt);
    this.stats.evictions.expired += before - this.list.length;
    return before - this.list.length;
  }
}

// Summed over all seeds, checked by the last test: proof the random steps reached every rule they claim to test.
const seen = { hits: 0, misses: 0, rejected: 0, size: 0, weight: 0, expired: 0 };

describe("randomized against a naive model", () => {
  for (const seed of [1, 2, 3, 42, 1337, 2024, 9001, 123456]) {
    it(`seed ${seed}: 3000 random steps, identical after every step`, () => {
      const rand = rng(seed);
      const int = (n: number) => Math.floor(rand() * n);
      const clock = manualClock();
      const maxEntries = 1 + int(6);
      const maxWeight = 10 + int(30);
      const defaultTtl = rand() < 0.5 ? undefined : 5 + int(50);
      const cache = new LruCache<number, number>({ maxEntries, maxWeight, weigh: (v) => v, ttlMs: defaultTtl, now: clock.now });
      const model = new Model(maxEntries, maxWeight, defaultTtl, clock.now);
      const log: string[] = [];
      for (let step = 0; step < 3000; step++) {
        const key = int(10);
        const r = rand();
        let got: unknown;
        let want: unknown;
        if (r < 0.3) {
          log.push(`get ${key}`);
          got = cache.get(key);
          want = model.get(key);
        } else if (r < 0.55) {
          const value = int(maxWeight + 3); // sometimes heavier than maxWeight on its own
          const ttl = rand() < 0.3 ? 1 + int(40) : undefined;
          log.push(`set ${key}=${value} ttl ${ttl}`);
          got = cache.set(key, value, { ttlMs: ttl });
          want = model.set(key, value, ttl);
        } else if (r < 0.65) {
          log.push(`delete ${key}`);
          got = cache.delete(key);
          want = model.delete(key);
        } else if (r < 0.75) {
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
    });
  }

  it("the random steps exercised hits, misses, rejects and all three eviction reasons", () => {
    for (const [name, n] of Object.entries(seen)) expect(n, name).toBeGreaterThan(50);
    console.log("model coverage over all seeds:", JSON.stringify(seen));
  });
});
