import { describe, expect, it, vi } from "vitest";
import { LruCache, type LoadContext } from "../src/index.js";
import { deferred, flush, manualClock, recorder } from "./support.js";

// ttl 100 + staleMs 50, set at t = 1000: fresh [1000, 1100), stale [1100, 1150), gone from 1150.
function setup(extra: { maxEntries?: number } = {}) {
  const clock = manualClock(1000);
  const { events, onEvent } = recorder<string>();
  const c = new LruCache<string, number>({ maxEntries: extra.maxEntries ?? 10, ttlMs: 100, staleMs: 50, now: clock.now, onEvent });
  return { clock, c, events };
}

describe("stale-while-revalidate: the grace boundaries", () => {
  it("at ttl - 1 the entry is fresh: a hit, no refresh", async () => {
    const { clock, c } = setup();
    c.set("k", 1);
    clock.advance(99);
    const loader = vi.fn(async () => 2);
    expect(await c.getOrLoad("k", loader)).toBe(1);
    expect(loader).not.toHaveBeenCalled();
    expect(c.stats()).toMatchObject({ hits: 1, staleHits: 0, refreshes: 0 });
  });

  it("AT ttl the entry is stale: getOrLoad returns the old value and ONE refresh stores the new one", async () => {
    const { clock, c, events } = setup();
    c.set("k", 1);
    clock.advance(100);
    const loader = vi.fn(async () => 2);
    expect(await c.getOrLoad("k", loader)).toBe(1);
    expect(loader).toHaveBeenCalledTimes(1);
    await flush();
    expect(c.peek("k")).toBe(2); // fresh again, with a full new TTL
    clock.advance(99);
    expect(c.peek("k")).toBe(2);
    expect(c.stats()).toMatchObject({ hits: 0, misses: 0, staleHits: 1, loads: 1, refreshes: 1 });
    expect(events).toEqual([{ type: "refresh", key: "k" }]); // "refresh", not "load"
  });

  it("at ttl + staleMs - 1 it is still served stale; AT ttl + staleMs it is gone: a miss that waits for the loader", async () => {
    const { clock, c, events } = setup();
    c.set("k", 1);
    clock.advance(149);
    const never = deferred<number>();
    expect(await c.getOrLoad("k", () => never.promise)).toBe(1);
    c.delete("k"); // drop the stale entry AND detach that refresh, to test the other boundary on a clean key
    c.set("k", 1);
    clock.advance(150);
    const d = deferred<number>();
    const p = c.getOrLoad("k", () => d.promise);
    let settled = false;
    void p.then(() => (settled = true));
    await flush();
    expect(settled).toBe(false); // a real miss: the caller waits
    d.resolve(3);
    expect(await p).toBe(3);
    expect(c.stats()).toMatchObject({ staleHits: 1, misses: 1 });
    expect(events).toContainEqual({ type: "evict", key: "k", reason: "expired" });
  });

  it("the stale value is returned at once, without waiting for the refresh", async () => {
    const { clock, c } = setup();
    c.set("k", 1);
    clock.advance(120);
    const d = deferred<number>(); // the refresh never answers during this test
    expect(await c.getOrLoad("k", () => d.promise)).toBe(1);
    expect(c.size).toBe(1);
  });

  it("get / peek / has do NOT return a stale entry (get counts a miss), but keep it for getOrLoad", async () => {
    const { clock, c } = setup();
    c.set("k", 1);
    clock.advance(100);
    expect(c.get("k")).toBeUndefined();
    expect(c.peek("k")).toBeUndefined();
    expect(c.has("k")).toBe(false);
    expect(c.size).toBe(1);
    expect(c.stats()).toMatchObject({ misses: 1, staleHits: 0, evictions: { expired: 0 } });
    expect(await c.getOrLoad("k", async () => 2)).toBe(1);
  });

  it("delete of a stale entry returns false (like has) and removes it: the next getOrLoad is a miss", async () => {
    const { clock, c } = setup();
    c.set("k", 1);
    clock.advance(100);
    expect(c.delete("k")).toBe(false);
    expect(c.size).toBe(0);
    expect(await c.getOrLoad("k", async () => 2)).toBe(2);
    expect(c.stats()).toMatchObject({ misses: 1, staleHits: 0 });
  });

  it("purgeExpired removes entries past their grace only, not stale ones", () => {
    const { clock, c } = setup();
    c.set("stale", 1);
    c.set("dead", 2, { staleMs: 0 });
    clock.advance(100);
    expect(c.purgeExpired()).toBe(1);
    expect(c.keys()).toEqual(["stale"]);
  });

  it("a stale eviction victim is reported with the limit's reason, a dead one as expired", () => {
    const { clock, c, events } = setup({ maxEntries: 1 });
    c.set("a", 1);
    clock.advance(100); // a is stale
    c.set("b", 2);
    clock.advance(150); // b is past its grace
    c.set("c", 3);
    expect(events).toEqual([
      { type: "evict", key: "a", reason: "size" },
      { type: "evict", key: "b", reason: "expired" },
    ]);
  });

  it("a stale hit makes the key most recently used", async () => {
    const { clock, c } = setup();
    c.set("a", 1);
    c.set("b", 2);
    clock.advance(100);
    await c.getOrLoad("a", () => new Promise<number>(() => {}));
    expect(c.keys()).toEqual(["b", "a"]);
  });

  it("per-entry and per-call staleMs override the default; staleMs 0 = no grace; Infinity = served stale forever", async () => {
    const { clock, c } = setup();
    c.set("none", 1, { staleMs: 0 });
    c.set("long", 1, { staleMs: 1000 });
    c.set("forever", 1, { staleMs: Infinity });
    await c.getOrLoad("loaded", async () => 1, { staleMs: 500 });
    clock.advance(900);
    const never = () => new Promise<number>(() => {});
    expect(c.keys()).toEqual(["none", "long", "forever", "loaded"]);
    expect(c.purgeExpired()).toBe(2); // none (at 1100) and loaded (at 1600)
    expect(await c.getOrLoad("long", never)).toBe(1);
    clock.advance(1e9);
    expect(await c.getOrLoad("forever", never)).toBe(1);
  });

  it("the refresh uses the ttlMs / staleMs of the call that started it", async () => {
    const { clock, c } = setup();
    c.set("k", 1);
    clock.advance(100);
    await c.getOrLoad("k", async () => 2, { ttlMs: 10, staleMs: 5 });
    await flush();
    clock.advance(10);
    expect(c.peek("k")).toBeUndefined(); // stale after 10
    clock.advance(4);
    expect(await c.getOrLoad("k", () => new Promise<number>(() => {}))).toBe(2); // still in its 5 ms grace
    clock.advance(1);
    expect(c.purgeExpired()).toBe(1); // gone AT 10 + 5
    expect(c.size).toBe(0);
  });

  it("invalid staleMs is a RangeError (constructor, set, getOrLoad); 0 is allowed", async () => {
    for (const bad of [-1, NaN, "5" as unknown as number]) {
      expect(() => new LruCache({ maxEntries: 1, staleMs: bad })).toThrow(RangeError);
      expect(() => new LruCache<string, number>({ maxEntries: 1 }).set("k", 1, { staleMs: bad })).toThrow(RangeError);
      await expect(new LruCache<string, number>({ maxEntries: 1 }).getOrLoad("k", async () => 1, { staleMs: bad })).rejects.toThrow(RangeError);
    }
    expect(() => new LruCache({ maxEntries: 1, staleMs: 0 })).not.toThrow();
  });
});

describe("stale-while-revalidate: single refresh", () => {
  it("50 concurrent stale reads start ONE refresh and all get the old value", async () => {
    const { clock, c } = setup();
    c.set("k", 1);
    clock.advance(100);
    const d = deferred<number>();
    const loader = vi.fn(() => d.promise);
    const all = await Promise.all(Array.from({ length: 50 }, () => c.getOrLoad("k", loader)));
    expect(all).toEqual(Array(50).fill(1));
    expect(loader).toHaveBeenCalledTimes(1);
    d.resolve(2);
    await flush();
    expect(c.peek("k")).toBe(2);
    expect(c.stats()).toMatchObject({ staleHits: 50, refreshes: 1, loads: 1, coalesced: 0 });
  });

  it("a miss after the grace ended while the refresh still runs JOINS the refresh (no second loader call)", async () => {
    const { clock, c } = setup();
    c.set("k", 1);
    clock.advance(100);
    const d = deferred<number>();
    const loader = vi.fn(() => d.promise);
    expect(await c.getOrLoad("k", loader)).toBe(1);
    clock.advance(50); // grace over, refresh still running
    const p = c.getOrLoad("k", loader);
    d.resolve(7);
    expect(await p).toBe(7);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(c.stats()).toMatchObject({ misses: 1, coalesced: 1 });
  });

  it("a caller that joins the refresh and aborts does NOT abort the refresh (the cache itself still wants it)", async () => {
    const { clock, c } = setup();
    c.set("k", 1);
    clock.advance(100);
    const d = deferred<number>();
    let refreshSignal: AbortSignal | undefined;
    await c.getOrLoad("k", (s) => ((refreshSignal = s), d.promise));
    clock.advance(50);
    const ac = new AbortController();
    const joined = c.getOrLoad("k", () => Promise.resolve(-1), { signal: ac.signal });
    ac.abort(new Error("left"));
    await expect(joined).rejects.toThrow("left");
    expect(refreshSignal!.aborted).toBe(false);
    d.resolve(5);
    await flush();
    expect(c.peek("k")).toBe(5);
  });

  it("a load (not a refresh) that every caller left is still aborted as in stage 1", async () => {
    const { c } = setup();
    let s: AbortSignal | undefined;
    const ac = new AbortController();
    const p = c.getOrLoad("k", (sig) => ((s = sig), new Promise<number>(() => {})), { signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toThrow();
    expect(s!.aborted).toBe(true);
  });
});

describe("stale-while-revalidate: a failed refresh", () => {
  it("keeps serving the stale value until the grace ends, reports refresh-error, and the next stale read retries", async () => {
    const { clock, c, events } = setup();
    c.set("k", 1);
    clock.advance(100);
    const boom = new Error("db down");
    const failing = vi.fn(async () => { throw boom; });
    expect(await c.getOrLoad("k", failing)).toBe(1);
    await flush();
    expect(events).toContainEqual({ type: "refresh-error", key: "k", error: boom });
    expect(c.stats()).toMatchObject({ refreshes: 1, refreshErrors: 1, loadErrors: 1 });
    clock.advance(49);
    expect(await c.getOrLoad("k", failing)).toBe(1); // still stale, still served; a second refresh started
    await flush();
    expect(failing).toHaveBeenCalledTimes(2);
    clock.advance(1); // grace over: behaves like a miss
    await expect(c.getOrLoad("k", failing)).rejects.toBe(boom);
    expect(c.stats()).toMatchObject({ staleHits: 2, misses: 1, loadErrors: 3, refreshErrors: 2 });
    expect(events.filter((e) => e.type === "load-error")).toHaveLength(1);
  });

  it("a failed refresh does not reject the stale reader and causes no unhandled rejection", async () => {
    const { clock, c } = setup();
    c.set("k", 1);
    clock.advance(100);
    await expect(c.getOrLoad("k", () => Promise.reject(new Error("x")))).resolves.toBe(1);
    await flush();
  });
});

describe("stale-while-revalidate: a refresh never overwrites a newer write", () => {
  for (const [name, act] of [
    ["set", (c: LruCache<string, number>) => c.set("k", 100)],
    ["delete", (c: LruCache<string, number>) => c.delete("k")],
    ["clear", (c: LruCache<string, number>) => c.clear()],
  ] as const) {
    it(`${name}() during a refresh: the refresh result is not written`, async () => {
      const { clock, c } = setup();
      c.set("k", 1);
      clock.advance(100);
      const d = deferred<number>();
      await c.getOrLoad("k", () => d.promise);
      act(c);
      d.resolve(2);
      await flush();
      expect(c.peek("k")).toBe(name === "set" ? 100 : undefined);
    });
  }
});

describe("the load context", () => {
  it("tells the loader the TTL it will get and whether it is a refresh", async () => {
    const { clock, c } = setup();
    const seen: Array<{ ttlMs: number | undefined; refresh: boolean }> = [];
    const loader = (_s: AbortSignal, ctx: LoadContext) => (seen.push({ ttlMs: ctx.ttlMs, refresh: ctx.refresh }), 1);
    await c.getOrLoad("a", loader);
    await c.getOrLoad("b", loader, { ttlMs: 7 });
    clock.advance(100);
    await c.getOrLoad("a", loader);
    expect(seen).toEqual([
      { ttlMs: 100, refresh: false },
      { ttlMs: 7, refresh: false },
      { ttlMs: 100, refresh: true },
    ]);
  });

  it("a loader can set the TTL of the value it returns (e.g. from an HTTP max-age)", async () => {
    const { clock, c } = setup();
    await c.getOrLoad("k", (_s, ctx) => ((ctx.ttlMs = 10), 1));
    clock.advance(9);
    expect(c.peek("k")).toBe(1);
    clock.advance(1);
    expect(c.peek("k")).toBeUndefined();
  });

  it("an invalid TTL set by the loader fails the load for every waiter and stores nothing", async () => {
    const { c } = setup();
    const p1 = c.getOrLoad("k", (_s, ctx) => ((ctx.ttlMs = -5), 1));
    const p2 = c.getOrLoad("k", async () => 2);
    await expect(p1).rejects.toThrow(RangeError);
    await expect(p2).rejects.toThrow(RangeError);
    expect(c.size).toBe(0);
    expect(c.stats().loadErrors).toBe(1);
  });

  it("isCurrent() is true while the load is the key's version, false after delete / set", async () => {
    const { c } = setup();
    let ctx1: LoadContext | undefined;
    let ctx2: LoadContext | undefined;
    const d = deferred<number>();
    void c.getOrLoad("a", (_s, ctx) => ((ctx1 = ctx), d.promise));
    void c.getOrLoad("b", (_s, ctx) => ((ctx2 = ctx), d.promise));
    expect(ctx1!.isCurrent()).toBe(true);
    c.delete("a");
    c.set("b", 1);
    expect(ctx1!.isCurrent()).toBe(false);
    expect(ctx2!.isCurrent()).toBe(false);
    d.resolve(0);
  });
});
