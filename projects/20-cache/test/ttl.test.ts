import { afterEach, describe, expect, it, vi } from "vitest";
import { LruCache } from "../src/index.js";
import { manualClock, recorder } from "./support.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("TTL", () => {
  it("boundary: live 1 ms before ttlMs, expired AT ttlMs", () => {
    const clock = manualClock();
    const c = new LruCache<string, number>({ maxEntries: 10, ttlMs: 100, now: clock.now });
    c.set("a", 1);
    clock.advance(99);
    expect(c.get("a")).toBe(1);
    clock.advance(1);
    expect(c.get("a")).toBeUndefined();
  });

  it("an expired entry is never returned by get, peek, has or getOrLoad, and is removed lazily as expired", async () => {
    const clock = manualClock();
    const { events, onEvent } = recorder<string>();
    const c = new LruCache<string, number>({ maxEntries: 10, ttlMs: 100, now: clock.now, onEvent });
    for (const read of [
      () => c.get("a"),
      () => c.peek("a"),
      () => (c.has("a") ? 1 : undefined),
    ]) {
      c.set("a", 1);
      clock.advance(100);
      expect(c.size).toBe(1); // still held: nothing touched it yet
      expect(read()).toBeUndefined();
      expect(c.size).toBe(0);
    }
    c.set("a", 1);
    clock.advance(100);
    expect(await c.getOrLoad("a", () => 2)).toBe(2);
    expect(events.filter((e) => e.type === "evict")).toEqual(Array(4).fill({ type: "evict", key: "a", reason: "expired" }));
    expect(c.stats().evictions.expired).toBe(4);
  });

  it("delete of an expired entry returns false", () => {
    const clock = manualClock();
    const c = new LruCache<string, number>({ maxEntries: 10, ttlMs: 10, now: clock.now });
    c.set("a", 1);
    clock.advance(10);
    expect(c.delete("a")).toBe(false);
    expect(c.size).toBe(0);
  });

  it("get does not extend the TTL (expiry counts from set)", () => {
    const clock = manualClock();
    const c = new LruCache<string, number>({ maxEntries: 10, ttlMs: 100, now: clock.now });
    c.set("a", 1);
    clock.advance(60);
    c.get("a");
    clock.advance(40);
    expect(c.get("a")).toBeUndefined();
  });

  it("set again restarts the TTL", () => {
    const clock = manualClock();
    const c = new LruCache<string, number>({ maxEntries: 10, ttlMs: 100, now: clock.now });
    c.set("a", 1);
    clock.advance(60);
    c.set("a", 2);
    clock.advance(60);
    expect(c.get("a")).toBe(2);
  });

  it("per-entry ttlMs overrides the default; Infinity never expires; no default = no expiry", () => {
    const clock = manualClock();
    const c = new LruCache<string, number>({ maxEntries: 10, ttlMs: 100, now: clock.now });
    c.set("short", 1, { ttlMs: 10 });
    c.set("long", 2, { ttlMs: 1000 });
    c.set("forever", 3, { ttlMs: Infinity });
    c.set("default", 4);
    clock.advance(10);
    expect(c.has("short")).toBe(false);
    expect(c.has("default")).toBe(true);
    clock.advance(90);
    expect(c.has("default")).toBe(false);
    expect(c.has("long")).toBe(true);
    clock.advance(1e12);
    expect(c.has("long")).toBe(false);
    expect(c.has("forever")).toBe(true);

    const none = new LruCache<string, number>({ maxEntries: 10, now: clock.now });
    none.set("a", 1);
    clock.advance(1e12);
    expect(none.get("a")).toBe(1);
    none.set("b", 2, { ttlMs: 5 });
    clock.advance(5);
    expect(none.has("b")).toBe(false);
  });

  it("an expired eviction victim is reported as expired, not as size", () => {
    const clock = manualClock();
    const { events, onEvent } = recorder<string>();
    const c = new LruCache<string, number>({ maxEntries: 2, now: clock.now, onEvent });
    c.set("old", 1, { ttlMs: 10 });
    c.set("b", 2);
    clock.advance(10);
    c.set("c", 3);
    c.set("d", 4);
    expect(events).toEqual([
      { type: "evict", key: "old", reason: "expired" },
      { type: "evict", key: "b", reason: "size" },
    ]);
  });

  it("purgeExpired removes exactly the expired entries", () => {
    const clock = manualClock();
    const c = new LruCache<string, number>({ maxEntries: 10, now: clock.now });
    c.set("a", 1, { ttlMs: 10 });
    c.set("b", 2, { ttlMs: 20 });
    c.set("c", 3, { ttlMs: 10 });
    c.set("d", 4);
    clock.advance(10);
    expect(c.purgeExpired()).toBe(2);
    expect(c.keys()).toEqual(["b", "d"]);
    expect(c.stats().evictions.expired).toBe(2);
    expect(c.purgeExpired()).toBe(0);
  });

  it("invalid ttlMs", () => {
    for (const ttlMs of [0, -5, NaN]) {
      expect(() => new LruCache({ maxEntries: 1, ttlMs })).toThrow(RangeError);
      const c = new LruCache<string, number>({ maxEntries: 1 });
      expect(() => c.set("a", 1, { ttlMs })).toThrow(RangeError);
      expect(c.size).toBe(0);
    }
  });
});

describe("sweep timer", () => {
  it("removes expired entries on its interval without any read", () => {
    vi.useFakeTimers();
    const clock = manualClock();
    const c = new LruCache<string, number>({ maxEntries: 10, ttlMs: 100, sweepIntervalMs: 50, now: clock.now });
    c.set("a", 1);
    clock.advance(100);
    expect(c.size).toBe(1);
    vi.advanceTimersByTime(50);
    expect(c.size).toBe(0);
    c.close();
  });

  it("is unref'd: it never keeps the process alive", () => {
    const spy = vi.spyOn(globalThis, "setInterval");
    const c = new LruCache<string, number>({ maxEntries: 10, ttlMs: 100, sweepIntervalMs: 60_000 });
    expect(spy).toHaveBeenCalledTimes(1);
    const timer = spy.mock.results[0]!.value as NodeJS.Timeout;
    expect(timer.hasRef()).toBe(false);
    c.close();
  });

  it("close() stops it, twice is fine, and the cache keeps working with lazy expiry", () => {
    vi.useFakeTimers();
    const clock = manualClock();
    const c = new LruCache<string, number>({ maxEntries: 10, ttlMs: 100, sweepIntervalMs: 50, now: clock.now });
    expect(vi.getTimerCount()).toBe(1);
    c.close();
    c.close();
    expect(vi.getTimerCount()).toBe(0);
    c.set("a", 1);
    clock.advance(100);
    vi.advanceTimersByTime(1000);
    expect(c.size).toBe(1); // no sweep ran
    expect(c.get("a")).toBeUndefined();
  });

  it("no sweepIntervalMs = no timer", () => {
    vi.useFakeTimers();
    const c = new LruCache<string, number>({ maxEntries: 10, ttlMs: 100 });
    expect(vi.getTimerCount()).toBe(0);
    c.close();
  });

  it("with the real clock and real timers (wide margins: waits for the sweep, not for a fixed time)", async () => {
    const c = new LruCache<string, number>({ maxEntries: 10, ttlMs: 20, sweepIntervalMs: 20 });
    c.set("a", 1);
    const start = Date.now();
    while (c.size > 0 && Date.now() - start < 10_000) await new Promise((r) => setTimeout(r, 20));
    expect(c.size).toBe(0);
    c.close();
  });

  it("invalid sweepIntervalMs", () => {
    for (const sweepIntervalMs of [0, -1, NaN, Infinity]) {
      expect(() => new LruCache({ maxEntries: 1, sweepIntervalMs })).toThrow(RangeError);
    }
  });
});
