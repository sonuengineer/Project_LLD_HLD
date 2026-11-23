import { describe, expect, it, vi } from "vitest";
import { LruCache } from "../src/index.js";
import { recorder } from "./support.js";

describe("eviction cost (guards the fix in README 'Overhead' without timing anything)", () => {
  it("evictions reuse one Map iterator instead of creating one per eviction", () => {
    const c = new LruCache<number, number>({ maxEntries: 100 });
    for (let i = 0; i < 100; i++) c.set(i, i);
    const keys = vi.spyOn(Map.prototype, "keys");
    try {
      for (let i = 100; i < 1100; i++) {
        c.get(i - 50); // touches leave holes in the middle too
        c.set(i, i); // evicts
      }
      // A fresh iterator per eviction started at slot 0 and walked every hole left by earlier deletions: 10.4 us
      // per evicting set measured on 10 000 entries. One long-lived iterator is O(1) amortized.
      expect(keys.mock.calls.length).toBeLessThanOrEqual(1);
    } finally {
      keys.mockRestore();
    }
    expect(c.size).toBe(100);
    expect(c.stats().evictions.size).toBe(1000);
  });
});

describe("LRU basics", () => {
  it("set / get / peek / has / delete / clear / size", () => {
    const c = new LruCache<string, number>({ maxEntries: 10 });
    expect(c.set("a", 1)).toBe(true);
    c.set("b", 2);
    expect(c.size).toBe(2);
    expect(c.get("a")).toBe(1);
    expect(c.peek("b")).toBe(2);
    expect(c.has("a")).toBe(true);
    expect(c.has("zzz")).toBe(false);
    expect(c.get("zzz")).toBeUndefined();
    expect(c.delete("a")).toBe(true);
    expect(c.delete("a")).toBe(false);
    expect(c.has("a")).toBe(false);
    c.clear();
    expect(c.size).toBe(0);
    expect(c.get("b")).toBeUndefined();
  });

  it("exactly at maxEntries nothing is evicted; one more evicts the least recently used", () => {
    const { events, onEvent } = recorder<string>();
    const c = new LruCache<string, number>({ maxEntries: 3, onEvent });
    c.set("a", 1);
    c.set("b", 2);
    c.set("c", 3);
    expect(c.size).toBe(3);
    expect(c.keys()).toEqual(["a", "b", "c"]);
    expect(events).toEqual([]);
    c.set("d", 4);
    expect(c.keys()).toEqual(["b", "c", "d"]);
    expect(events).toEqual([{ type: "evict", key: "a", reason: "size" }]);
    expect(c.stats().evictions).toEqual({ size: 1, weight: 0, expired: 0 });
  });

  it("get moves the key to most recently used, so it survives the next eviction", () => {
    const c = new LruCache<string, number>({ maxEntries: 3 });
    c.set("a", 1);
    c.set("b", 2);
    c.set("c", 3);
    c.get("a");
    expect(c.keys()).toEqual(["b", "c", "a"]);
    c.set("d", 4);
    expect(c.has("a")).toBe(true);
    expect(c.has("b")).toBe(false);
  });

  it("peek and has do NOT change recency", () => {
    const c = new LruCache<string, number>({ maxEntries: 3 });
    c.set("a", 1);
    c.set("b", 2);
    c.set("c", 3);
    c.peek("a");
    c.has("a");
    expect(c.keys()).toEqual(["a", "b", "c"]);
    c.set("d", 4);
    expect(c.has("a")).toBe(false);
  });

  it("set on an existing key replaces the value, moves it to most recent, and evicts nothing", () => {
    const { events, onEvent } = recorder<string>();
    const c = new LruCache<string, number>({ maxEntries: 2, onEvent });
    c.set("a", 1);
    c.set("b", 2);
    c.set("a", 10);
    expect(c.size).toBe(2);
    expect(c.keys()).toEqual(["b", "a"]);
    expect(c.peek("a")).toBe(10);
    expect(events).toEqual([]);
  });

  it("maxEntries 1 keeps only the last key", () => {
    const c = new LruCache<number, number>({ maxEntries: 1 });
    for (let i = 0; i < 5; i++) c.set(i, i);
    expect(c.keys()).toEqual([4]);
  });

  it("an undefined value is stored: has() tells it apart from a miss", () => {
    const c = new LruCache<string, undefined>({ maxEntries: 2 });
    c.set("a", undefined);
    expect(c.has("a")).toBe(true);
    expect(c.get("a")).toBeUndefined();
    expect(c.stats().hits).toBe(1);
  });

  it("invalid options", () => {
    for (const maxEntries of [0, -1, 1.5, NaN, Infinity]) {
      expect(() => new LruCache({ maxEntries })).toThrow(RangeError);
    }
    expect(() => new LruCache({ maxEntries: 1, maxWeight: 0, weigh: () => 1 })).toThrow(RangeError);
    expect(() => new LruCache({ maxEntries: 1, maxWeight: Infinity, weigh: () => 1 })).toThrow(RangeError);
    expect(() => new LruCache({ maxEntries: 1, maxWeight: 10 })).toThrow(TypeError);
  });
});

describe("max weight", () => {
  const bytes = (s: string) => Buffer.byteLength(s);

  it("tracks the total weight through set, replace, delete and clear", () => {
    const c = new LruCache<string, string>({ maxEntries: 10, maxWeight: 100, weigh: bytes });
    c.set("a", "xxxx");
    c.set("b", "yy");
    expect(c.totalWeight).toBe(6);
    c.set("a", "x");
    expect(c.totalWeight).toBe(3);
    c.delete("b");
    expect(c.totalWeight).toBe(1);
    c.clear();
    expect(c.totalWeight).toBe(0);
  });

  it("exactly at maxWeight nothing is evicted; over it evicts least recently used until it fits", () => {
    const { events, onEvent } = recorder<string>();
    const c = new LruCache<string, string>({ maxEntries: 10, maxWeight: 10, weigh: bytes, onEvent });
    c.set("a", "aaaa");
    c.set("b", "bbb");
    c.set("c", "ccc");
    expect(c.totalWeight).toBe(10);
    expect(events).toEqual([]);
    c.set("d", "dddddd"); // 16 -> drop a (12) -> drop b (9)
    expect(c.keys()).toEqual(["c", "d"]);
    expect(c.totalWeight).toBe(9);
    expect(events).toEqual([
      { type: "evict", key: "a", reason: "weight" },
      { type: "evict", key: "b", reason: "weight" },
    ]);
    expect(c.stats().evictions.weight).toBe(2);
  });

  it("a value exactly maxWeight heavy is stored (and pushes out everything else)", () => {
    const c = new LruCache<string, string>({ maxEntries: 10, maxWeight: 4, weigh: bytes });
    c.set("a", "a");
    expect(c.set("big", "1234")).toBe(true);
    expect(c.keys()).toEqual(["big"]);
  });

  it("a single value heavier than maxWeight is not stored, evicts nothing, and removes the key's older value", () => {
    const { events, onEvent } = recorder<string>();
    const c = new LruCache<string, string>({ maxEntries: 10, maxWeight: 4, weigh: bytes, onEvent });
    c.set("a", "a");
    c.set("k", "old");
    expect(c.set("k", "12345")).toBe(false);
    expect(c.has("k")).toBe(false); // not the old value: the caller just replaced it
    expect(c.keys()).toEqual(["a"]);
    expect(c.totalWeight).toBe(1);
    expect(events).toEqual([{ type: "reject", key: "k", weight: 5 }]);
    expect(c.stats().rejected).toBe(1);
    expect(c.stats().evictions).toEqual({ size: 0, weight: 0, expired: 0 });
  });

  it("weigh returning an invalid value throws RangeError and leaves the cache unchanged", () => {
    let w: unknown = 1;
    const c = new LruCache<string, string>({ maxEntries: 10, maxWeight: 10, weigh: () => w as number });
    c.set("k", "old");
    for (const bad of [-1, NaN, Infinity, 1.5, 0.1, "3", undefined, null]) { // fractions: they drift, see weighOf
      w = bad;
      expect(() => c.set("k", "new")).toThrow(RangeError);
      expect(c.peek("k")).toBe("old");
      expect(c.totalWeight).toBe(1);
    }
    w = 0; // zero is valid (an empty string weighs 0 bytes)
    expect(c.set("z", "")).toBe(true);
    expect(c.totalWeight).toBe(1);
  });

  it("weigh without maxWeight only counts", () => {
    const c = new LruCache<string, string>({ maxEntries: 2, weigh: bytes });
    c.set("a", "x".repeat(1000));
    expect(c.totalWeight).toBe(1000);
    expect(c.has("a")).toBe(true);
  });

  it("both limits: whichever is hit first evicts, with its own reason", () => {
    const { events, onEvent } = recorder<string>();
    const c = new LruCache<string, string>({ maxEntries: 2, maxWeight: 5, weigh: bytes, onEvent });
    c.set("a", "a");
    c.set("b", "b");
    c.set("c", "c"); // 3 entries -> a leaves by size
    c.set("d", "dddd"); // 3 entries -> b leaves by size; then c(1) + d(4) = 5 fits the weight
    expect(events.map((e) => (e.type === "evict" ? `${e.key}:${e.reason}` : e.type))).toEqual(["a:size", "b:size"]);
    c.set("e", "ee"); // d(4) + e(2) = 6 > 5 after c leaves by size
    expect(c.keys()).toEqual(["e"]);
    expect(events.map((e) => (e.type === "evict" ? `${e.key}:${e.reason}` : e.type)).slice(2)).toEqual(["c:size", "d:weight"]);
  });
});
