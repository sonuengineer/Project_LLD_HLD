import { describe, expect, it } from "vitest";
import { LruCache, type CacheEvent } from "../src/index.js";
import { manualClock } from "./support.js";

describe("stats", () => {
  it("hits and misses come from get and getOrLoad only (not peek / has)", async () => {
    const c = new LruCache<string, number>({ maxEntries: 10 });
    c.set("a", 1);
    c.get("a");
    c.get("b");
    c.peek("a");
    c.peek("b");
    c.has("a");
    c.has("b");
    await c.getOrLoad("a", async () => 0);
    await c.getOrLoad("c", async () => 0);
    expect(c.stats()).toEqual({
      hits: 2, misses: 2, loads: 1, coalesced: 0, loadErrors: 0, rejected: 0,
      evictions: { size: 0, weight: 0, expired: 0 },
    });
  });

  it("an expired entry read by get is a miss", () => {
    const clock = manualClock();
    const c = new LruCache<string, number>({ maxEntries: 10, ttlMs: 5, now: clock.now });
    c.set("a", 1);
    clock.advance(5);
    c.get("a");
    expect(c.stats()).toMatchObject({ hits: 0, misses: 1, evictions: { expired: 1 } });
  });

  it("stats() is a copy", () => {
    const c = new LruCache<string, number>({ maxEntries: 1 });
    const s = c.stats();
    s.hits = 99;
    s.evictions.size = 99;
    expect(c.stats().hits).toBe(0);
    expect(c.stats().evictions.size).toBe(0);
  });

  it("explicit delete and clear are not evictions", () => {
    const events: CacheEvent<string>[] = [];
    const c = new LruCache<string, number>({ maxEntries: 10, onEvent: (e) => void events.push(e) });
    c.set("a", 1);
    c.set("b", 2);
    c.delete("a");
    c.clear();
    expect(events).toEqual([]);
    expect(c.stats().evictions).toEqual({ size: 0, weight: 0, expired: 0 });
  });
});

describe("events", () => {
  it("a load emits load; a throwing handler is ignored everywhere and changes nothing", async () => {
    const clock = manualClock();
    let calls = 0;
    const c = new LruCache<string, string>({
      maxEntries: 1, maxWeight: 3, weigh: (s) => s.length, ttlMs: 10, now: clock.now,
      onEvent: () => {
        calls++;
        throw new Error("logger broke");
      },
    });
    expect(await c.getOrLoad("a", async () => "x")).toBe("x"); // load
    c.set("b", "y"); // evict size
    clock.advance(10);
    expect(c.get("b")).toBeUndefined(); // evict expired
    expect(c.set("c", "toolong")).toBe(false); // reject
    await expect(c.getOrLoad("d", async () => { throw new Error("real"); })).rejects.toThrow("real"); // load, load-error
    const ac = new AbortController();
    const p = c.getOrLoad("e", () => new Promise<string>(() => {}), { signal: ac.signal }); // load
    ac.abort(new Error("left"));
    await expect(p).rejects.toThrow("left"); // load-abort
    expect(calls).toBe(8);
  });

  it("the event sequence of a load", async () => {
    const events: CacheEvent<string>[] = [];
    const c = new LruCache<string, number>({ maxEntries: 1, onEvent: (e) => void events.push(e) });
    c.set("old", 0);
    await c.getOrLoad("k", async () => 1);
    expect(events).toEqual([
      { type: "load", key: "k" },
      { type: "evict", key: "old", reason: "size" },
    ]);
  });
});
