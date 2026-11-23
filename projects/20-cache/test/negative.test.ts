import { describe, expect, it, vi } from "vitest";
import { LruCache } from "../src/index.js";
import { deferred, flush, manualClock } from "./support.js";

type User = { id: string } | null;

// ttl 1000 for found values, 50 for "not found".
function setup(extra: { staleMs?: number; isNegative?: (v: User) => boolean } = {}) {
  const clock = manualClock(1000);
  const c = new LruCache<string, User>({ maxEntries: 10, ttlMs: 1000, negativeTtlMs: 50, now: clock.now, ...extra });
  return { clock, c };
}

describe("negative caching", () => {
  it("a loaded null is cached for negativeTtlMs: hits until then (counted as negative hits), a new load AT the boundary", async () => {
    const { clock, c } = setup();
    const loader = vi.fn(async () => null);
    expect(await c.getOrLoad("missing", loader)).toBeNull();
    clock.advance(49);
    expect(await c.getOrLoad("missing", loader)).toBeNull();
    expect(loader).toHaveBeenCalledTimes(1);
    clock.advance(1);
    expect(c.has("missing")).toBe(false);
    await c.getOrLoad("missing", loader);
    expect(loader).toHaveBeenCalledTimes(2);
    expect(c.stats()).toMatchObject({ hits: 1, negativeHits: 1, misses: 2, loads: 2 });
  });

  it("a flood of lookups for a missing id: 1000 sequential + 100 concurrent -> ONE loader call", async () => {
    const { c } = setup();
    const loader = vi.fn(async () => null);
    for (let i = 0; i < 1000; i++) await c.getOrLoad("ghost", loader);
    await Promise.all(Array.from({ length: 100 }, () => c.getOrLoad("ghost", loader)));
    expect(loader).toHaveBeenCalledTimes(1);
    expect(c.stats()).toMatchObject({ negativeHits: 1099, hits: 1099 });
  });

  it("found values keep the normal TTL", async () => {
    const { clock, c } = setup();
    await c.getOrLoad("u1", async () => ({ id: "u1" }));
    clock.advance(999);
    expect(c.get("u1")).toEqual({ id: "u1" });
    expect(c.stats().negativeHits).toBe(0);
  });

  it("the default isNegative is null or undefined; a custom one replaces it", async () => {
    const clock = manualClock();
    const d = new LruCache<string, number | null | undefined>({ maxEntries: 10, ttlMs: 1000, negativeTtlMs: 50, now: clock.now });
    await d.getOrLoad("u", async () => undefined);
    await d.getOrLoad("n", async () => null);
    await d.getOrLoad("z", async () => 0);
    clock.advance(50);
    expect(d.keys().filter((k) => d.has(k))).toEqual(["z"]);
    const custom = new LruCache<string, number>({ maxEntries: 10, ttlMs: 1000, negativeTtlMs: 50, isNegative: (v) => v === -1, now: clock.now });
    await custom.getOrLoad("a", async () => -1);
    custom.get("a");
    expect(custom.stats().negativeHits).toBe(1);
  });

  it("a negative value never lives longer than negativeTtlMs, but a shorter call / loader TTL wins", async () => {
    const { clock, c } = setup();
    await c.getOrLoad("long", (_s, ctx) => ((ctx.ttlMs = 1e9), null)); // capped
    await c.getOrLoad("short", async () => null, { ttlMs: 10 });
    clock.advance(10);
    expect(c.has("short")).toBe(false);
    expect(c.has("long")).toBe(true);
    clock.advance(40);
    expect(c.has("long")).toBe(false);
    expect(c.loadedTtl(null, 1e9)).toBe(50);
    expect(c.loadedTtl(null, 10)).toBe(10);
    expect(c.loadedTtl(null, undefined)).toBe(50);
    expect(c.loadedTtl({ id: "x" }, 1e9)).toBe(1e9);
  });

  it("a negative entry gets no stale grace, even when the cache has one", async () => {
    const { clock, c } = setup({ staleMs: 500 });
    await c.getOrLoad("missing", async () => null);
    clock.advance(50);
    const loader = vi.fn(async () => ({ id: "now exists" }));
    expect(await c.getOrLoad("missing", loader)).toEqual({ id: "now exists" }); // a miss, not a stale null
    expect(c.stats().staleHits).toBe(0);
  });

  it("get() of a cached negative returns it (null) and counts a negative hit", async () => {
    const { c } = setup();
    await c.getOrLoad("m", async () => null);
    expect(c.get("m")).toBeNull();
    expect(c.stats()).toMatchObject({ hits: 1, negativeHits: 1 });
  });

  it("set(key, null) is an explicit value, not a negative: normal TTL, not counted as a negative hit", () => {
    const { clock, c } = setup();
    c.set("k", null);
    clock.advance(999);
    expect(c.get("k")).toBeNull();
    expect(c.stats().negativeHits).toBe(0);
  });

  it("errors are still NOT cached", async () => {
    const { c } = setup();
    await expect(c.getOrLoad("k", async () => { throw new Error("timeout"); })).rejects.toThrow("timeout");
    const loader = vi.fn(async () => null);
    await c.getOrLoad("k", loader);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("a negative refresh result replaces a stale found value (the row was deleted)", async () => {
    const { clock, c } = setup({ staleMs: 500 });
    c.set("k", { id: "k" });
    clock.advance(1000);
    const d = deferred<User>();
    expect(await c.getOrLoad("k", () => d.promise)).toEqual({ id: "k" });
    d.resolve(null);
    await flush();
    expect(c.get("k")).toBeNull();
    expect(c.stats().negativeHits).toBe(1);
    clock.advance(50); // the negative TTL, not the found value's 1000
    expect(c.purgeExpired()).toBe(1);
  });

  it("without negativeTtlMs a loaded null is cached like any value; isNegative without it is a TypeError; bad negativeTtlMs a RangeError", async () => {
    const clock = manualClock();
    const c = new LruCache<string, null>({ maxEntries: 10, ttlMs: 1000, now: clock.now });
    await c.getOrLoad("k", async () => null);
    clock.advance(999);
    expect(c.has("k")).toBe(true);
    expect(c.stats().negativeHits).toBe(0);
    expect(() => new LruCache<string, number>({ maxEntries: 1, isNegative: () => true })).toThrow(TypeError);
    for (const bad of [0, -1, NaN]) expect(() => new LruCache({ maxEntries: 1, negativeTtlMs: bad })).toThrow(RangeError);
    expect(c.loadedTtl(null, 5)).toBe(5); // negative caching off: the TTL is unchanged
  });
});
