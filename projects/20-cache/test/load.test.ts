import { describe, expect, it, vi } from "vitest";
import { LruCache } from "../src/index.js";
import { deferred, flush, manualClock, recorder } from "./support.js";

const cache = () => new LruCache<string, number>({ maxEntries: 100 });

describe("getOrLoad: single flight", () => {
  it("a miss loads once and caches; the next call is a hit without calling the loader", async () => {
    const c = cache();
    const loader = vi.fn(async () => 42);
    expect(await c.getOrLoad("k", loader)).toBe(42);
    expect(await c.getOrLoad("k", loader)).toBe(42);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(c.peek("k")).toBe(42);
    expect(c.stats()).toMatchObject({ hits: 1, misses: 1, loads: 1, coalesced: 0, loadErrors: 0 });
  });

  it("100 concurrent getOrLoad for one key -> the loader runs ONCE and all get the same result", async () => {
    const c = cache();
    const d = deferred<number>();
    const loader = vi.fn(() => d.promise);
    const all = Array.from({ length: 100 }, () => c.getOrLoad("k", loader));
    await flush();
    expect(loader).toHaveBeenCalledTimes(1);
    d.resolve(7);
    expect(await Promise.all(all)).toEqual(Array(100).fill(7));
    expect(c.stats()).toMatchObject({ misses: 100, loads: 1, coalesced: 99 });
  });

  it("different keys load independently", async () => {
    const c = cache();
    const loader = vi.fn(async (_s: AbortSignal) => 1);
    await Promise.all([c.getOrLoad("a", loader), c.getOrLoad("b", loader), c.getOrLoad("a", loader)]);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("an error is shared by every waiter, is NOT cached, and the next call loads again", async () => {
    const { events, onEvent } = recorder<string>();
    const c = new LruCache<string, number>({ maxEntries: 10, onEvent });
    const d = deferred<number>();
    const loader = vi.fn(() => d.promise);
    const all = Array.from({ length: 10 }, () => c.getOrLoad("k", loader).catch((e: unknown) => e));
    const boom = new Error("db down");
    d.reject(boom);
    for (const r of await Promise.all(all)) expect(r).toBe(boom);
    expect(c.has("k")).toBe(false);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(await c.getOrLoad("k", async () => 5)).toBe(5);
    expect(c.stats()).toMatchObject({ loads: 2, loadErrors: 1 });
    expect(events).toContainEqual({ type: "load-error", key: "k", error: boom });
  });

  it("a loader that throws synchronously is handled like a rejection", async () => {
    const c = cache();
    const err = new Error("sync");
    await expect(c.getOrLoad("k", () => { throw err; })).rejects.toBe(err);
    expect(await c.getOrLoad("k", () => 3)).toBe(3); // a plain (non-promise) value works too
  });

  it("the loaded value gets the per-call ttlMs, else the cache default", async () => {
    const clock = manualClock();
    const c = new LruCache<string, number>({ maxEntries: 10, ttlMs: 100, now: clock.now });
    await c.getOrLoad("short", async () => 1, { ttlMs: 10 });
    await c.getOrLoad("default", async () => 2);
    clock.advance(10);
    expect(c.has("short")).toBe(false);
    expect(c.has("default")).toBe(true);
    await expect(c.getOrLoad("x", async () => 1, { ttlMs: 0 })).rejects.toThrow(RangeError);
    expect(c.stats().loads).toBe(2); // the invalid option cost no load
  });

  it("a hit moves the key to most recently used", async () => {
    const c = new LruCache<string, number>({ maxEntries: 2 });
    c.set("a", 1);
    c.set("b", 2);
    await c.getOrLoad("a", async () => 0);
    expect(c.keys()).toEqual(["b", "a"]);
  });

  it("a loaded value too heavy to store is still returned, but not cached", async () => {
    const c = new LruCache<string, string>({ maxEntries: 10, maxWeight: 3, weigh: (s) => s.length });
    expect(await c.getOrLoad("k", async () => "12345")).toBe("12345");
    expect(c.has("k")).toBe(false);
    expect(c.stats().rejected).toBe(1);
  });

  it("weigh returning an invalid value for a loaded value rejects every waiter and caches nothing", async () => {
    const c = new LruCache<string, number>({ maxEntries: 10, weigh: () => NaN });
    const d = deferred<number>();
    const p1 = c.getOrLoad("k", () => d.promise);
    const p2 = c.getOrLoad("k", () => d.promise);
    d.resolve(1);
    await expect(p1).rejects.toThrow(RangeError);
    await expect(p2).rejects.toThrow(RangeError);
    expect(c.has("k")).toBe(false);
    expect(c.stats().loadErrors).toBe(1);
  });
});

describe("getOrLoad: abort", () => {
  it("an already-aborted caller neither starts nor joins a load", async () => {
    const c = cache();
    const loader = vi.fn(async () => 1);
    const reason = new Error("gone");
    await expect(c.getOrLoad("k", loader, { signal: AbortSignal.abort(reason) })).rejects.toBe(reason);
    expect(loader).not.toHaveBeenCalled();
    expect(c.stats()).toMatchObject({ misses: 0, loads: 0 });
  });

  it("one waiter aborts: it rejects with its reason, the shared load continues for the others and is cached", async () => {
    const c = cache();
    const d = deferred<number>();
    let loadSignal: AbortSignal | undefined;
    const loader = vi.fn((s: AbortSignal) => ((loadSignal = s), d.promise));
    const ac = new AbortController();
    const leaving = c.getOrLoad("k", loader, { signal: ac.signal });
    const staying = c.getOrLoad("k", loader, { signal: new AbortController().signal });
    const plain = c.getOrLoad("k", loader);
    const reason = new Error("client left");
    ac.abort(reason);
    await expect(leaving).rejects.toBe(reason);
    expect(loadSignal!.aborted).toBe(false);
    d.resolve(9);
    expect(await staying).toBe(9);
    expect(await plain).toBe(9);
    expect(c.peek("k")).toBe(9);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("ALL waiters abort: the load's signal is aborted, nothing is written, and the next call starts a fresh load", async () => {
    const { events, onEvent } = recorder<string>();
    const c = new LruCache<string, number>({ maxEntries: 10, onEvent });
    const d = deferred<number>();
    let loadSignal: AbortSignal | undefined;
    const a = new AbortController();
    const b = new AbortController();
    const pa = c.getOrLoad("k", (s) => ((loadSignal = s), d.promise), { signal: a.signal });
    const pb = c.getOrLoad("k", () => Promise.resolve(-1), { signal: b.signal });
    a.abort(new Error("a"));
    expect(loadSignal!.aborted).toBe(false); // b still waits
    const reasonB = new Error("b");
    b.abort(reasonB);
    expect(loadSignal!.aborted).toBe(true);
    expect(loadSignal!.reason).toBe(reasonB);
    await expect(pa).rejects.toThrow("a");
    await expect(pb).rejects.toBe(reasonB);
    expect(events).toContainEqual({ type: "load-abort", key: "k" });

    const fresh = vi.fn(async () => 2);
    const pc = c.getOrLoad("k", fresh);
    d.resolve(1); // the abandoned loader ignores its signal and answers late
    expect(await pc).toBe(2);
    await flush();
    expect(fresh).toHaveBeenCalledTimes(1);
    expect(c.peek("k")).toBe(2);
    expect(c.stats().loadErrors).toBe(0);
  });

  it("an aborted load that rejects is not counted as a load error, and causes no unhandled rejection", async () => {
    const c = cache();
    const ac = new AbortController();
    const p = c.getOrLoad("k", (s) => new Promise<number>((_, rej) => s.addEventListener("abort", () => rej(s.reason))), { signal: ac.signal });
    ac.abort(new Error("bye"));
    await expect(p).rejects.toThrow("bye");
    await flush();
    expect(c.stats().loadErrors).toBe(0);
  });

  it("a caller without a signal keeps the load alive when every signalled caller leaves", async () => {
    const c = cache();
    const d = deferred<number>();
    let loadSignal: AbortSignal | undefined;
    const plain = c.getOrLoad("k", (s) => ((loadSignal = s), d.promise));
    const ac = new AbortController();
    const leaving = c.getOrLoad("k", () => d.promise, { signal: ac.signal });
    ac.abort();
    await expect(leaving).rejects.toThrow();
    expect(loadSignal!.aborted).toBe(false);
    d.resolve(4);
    expect(await plain).toBe(4);
  });

  it("the abort listener is removed from the caller's signal once the load settles", async () => {
    const c = cache();
    const ac = new AbortController();
    const add = vi.spyOn(ac.signal, "addEventListener");
    const remove = vi.spyOn(ac.signal, "removeEventListener");
    await c.getOrLoad("k", async () => 1, { signal: ac.signal });
    expect(add).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith("abort", add.mock.calls[0]![1]);
    ac.abort(); // nothing happens: no stray leave() for a finished load
    expect(c.peek("k")).toBe(1);
  });

  it("aborting after the load settled changes nothing for other waiters", async () => {
    const c = cache();
    const ac = new AbortController();
    const p1 = c.getOrLoad("k", async () => 1, { signal: ac.signal });
    const p2 = c.getOrLoad("k", async () => 2);
    expect(await p1).toBe(1);
    ac.abort();
    expect(await p2).toBe(1);
  });
});

describe("getOrLoad: no stale writes (load versions)", () => {
  it("delete() during a load: the waiters get the load's value, but it is NOT written; the next call loads fresh", async () => {
    const c = cache();
    const d = deferred<number>();
    const p = c.getOrLoad("k", () => d.promise);
    c.delete("k"); // e.g. the row was updated: the value being loaded may be old
    const fresh = vi.fn(async () => 2);
    const p2 = c.getOrLoad("k", fresh); // must NOT join the old load
    d.resolve(1);
    expect(await p).toBe(1);
    expect(await p2).toBe(2);
    expect(fresh).toHaveBeenCalledTimes(1);
    await flush();
    expect(c.peek("k")).toBe(2);
  });

  it("delete() during a load, nobody else asks: the slow load does not bring the value back", async () => {
    const c = cache();
    const d = deferred<number>();
    const p = c.getOrLoad("k", () => d.promise);
    c.delete("k");
    d.resolve(1);
    expect(await p).toBe(1);
    expect(c.has("k")).toBe(false);
  });

  it("clear() during a load: not written", async () => {
    const c = cache();
    const d = deferred<number>();
    const p = c.getOrLoad("k", () => d.promise);
    c.clear();
    d.resolve(1);
    await p;
    expect(c.size).toBe(0);
  });

  it("set() during a load: the newer set value wins, the slow load does not overwrite it", async () => {
    const c = cache();
    const d = deferred<number>();
    const p = c.getOrLoad("k", () => d.promise);
    c.set("k", 100);
    d.resolve(1);
    expect(await p).toBe(1);
    expect(c.peek("k")).toBe(100);
  });

  it("an old load failing after delete() does not remove the new load in flight", async () => {
    const c = cache();
    const old = deferred<number>();
    const pOld = c.getOrLoad("k", () => old.promise).catch((e: unknown) => e);
    c.delete("k");
    const next = deferred<number>();
    const pNew = c.getOrLoad("k", () => next.promise);
    old.reject(new Error("old"));
    await pOld;
    const joiner = vi.fn(async () => 99);
    const pJoin = c.getOrLoad("k", joiner); // must join the NEW load
    next.resolve(5);
    expect(await pNew).toBe(5);
    expect(await pJoin).toBe(5);
    expect(joiner).not.toHaveBeenCalled();
  });
});
