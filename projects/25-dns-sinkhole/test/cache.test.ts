import { describe, expect, it } from "vitest";
import { ResponseCache } from "../src/cache.js";
import { ManualClock } from "../src/clock.js";
import { TYPE } from "../src/wire.js";

const buf = (tag: string) => Buffer.from(tag);

describe("ResponseCache: TTL and lazy expiry (ManualClock, no real sleeps)", () => {
  it("a stored entry is returned before its TTL elapses", () => {
    const clock = new ManualClock(0);
    const cache = new ResponseCache({ clock });
    cache.put("example.com", TYPE.A, buf("answer"), 30);
    clock.advance(29_999);
    expect(cache.get("example.com", TYPE.A)).toEqual(buf("answer"));
  });

  it("an entry is gone the instant its TTL elapses, and stays gone (lazy eviction)", () => {
    const clock = new ManualClock(0);
    const cache = new ResponseCache({ clock });
    cache.put("example.com", TYPE.A, buf("answer"), 30);
    clock.advance(30_000);
    expect(cache.get("example.com", TYPE.A)).toBeUndefined();
    clock.advance(1); // still gone, not somehow revived
    expect(cache.get("example.com", TYPE.A)).toBeUndefined();
  });

  it("is keyed by (name, type): an A and an AAAA entry for the same name do not collide", () => {
    const cache = new ResponseCache({ clock: new ManualClock(0) });
    cache.put("example.com", TYPE.A, buf("a-answer"), 60);
    cache.put("example.com", TYPE.AAAA, buf("aaaa-answer"), 60);
    expect(cache.get("example.com", TYPE.A)).toEqual(buf("a-answer"));
    expect(cache.get("example.com", TYPE.AAAA)).toEqual(buf("aaaa-answer"));
  });

  it("name lookup is case-insensitive and ignores a trailing dot", () => {
    const cache = new ResponseCache({ clock: new ManualClock(0) });
    cache.put("Example.com", TYPE.A, buf("answer"), 60);
    expect(cache.get("example.com.", TYPE.A)).toEqual(buf("answer"));
  });

  it("ttlSeconds <= 0 is never cached", () => {
    const cache = new ResponseCache({ clock: new ManualClock(0) });
    expect(cache.put("example.com", TYPE.A, buf("x"), 0)).toBe(false);
    expect(cache.put("example.com", TYPE.A, buf("x"), -5)).toBe(false);
    expect(cache.get("example.com", TYPE.A)).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it("put() returns a fresh copy; mutating the buffer the caller passed does not corrupt the cache", () => {
    const cache = new ResponseCache({ clock: new ManualClock(0) });
    const original = Buffer.from("answer");
    cache.put("example.com", TYPE.A, original, 60);
    original[0] = 0; // mutate the caller's own buffer after storing it
    expect(cache.get("example.com", TYPE.A)).toEqual(buf("answer"));
  });

  it("get() returns a fresh copy each time; the caller mutating it (e.g. to patch an ID) never corrupts later hits", () => {
    const cache = new ResponseCache({ clock: new ManualClock(0) });
    cache.put("example.com", TYPE.A, buf("answer"), 60);
    const first = cache.get("example.com", TYPE.A)!;
    first[0] = 0;
    expect(cache.get("example.com", TYPE.A)).toEqual(buf("answer"));
  });

  it("re-storing the same key replaces the old entry and its TTL", () => {
    const clock = new ManualClock(0);
    const cache = new ResponseCache({ clock });
    cache.put("example.com", TYPE.A, buf("old"), 10);
    clock.advance(5_000);
    cache.put("example.com", TYPE.A, buf("new"), 10); // fresh 10s TTL from now
    clock.advance(9_000); // 9s after the SECOND put; the old TTL (5s left) would have expired by now
    expect(cache.get("example.com", TYPE.A)).toEqual(buf("new"));
  });

  it("evicts the oldest entry first once maxEntries is exceeded", () => {
    const cache = new ResponseCache({ clock: new ManualClock(0), maxEntries: 2 });
    cache.put("a.test", TYPE.A, buf("a"), 60);
    cache.put("b.test", TYPE.A, buf("b"), 60);
    cache.put("c.test", TYPE.A, buf("c"), 60); // pushes out "a.test", the oldest
    expect(cache.get("a.test", TYPE.A)).toBeUndefined();
    expect(cache.get("b.test", TYPE.A)).toEqual(buf("b"));
    expect(cache.get("c.test", TYPE.A)).toEqual(buf("c"));
    expect(cache.size).toBe(2);
  });

  it("counts down each ttlOffset by elapsed time on get(), never below zero", () => {
    const clock = new ManualClock(0);
    const cache = new ResponseCache({ clock });
    const raw = Buffer.alloc(8);
    raw.writeUInt32BE(300, 0); // one record's ttl field at offset 0
    raw.writeUInt32BE(50, 4); // another record's ttl field at offset 4
    cache.put("example.com", TYPE.A, raw, 50, [0, 4]); // cache entry itself expires in 50s (the smaller ttl)
    clock.advance(20_000);
    const hit = cache.get("example.com", TYPE.A)!;
    expect(hit.readUInt32BE(0)).toBe(280);
    expect(hit.readUInt32BE(4)).toBe(30);
    clock.advance(29_000); // 49s total elapsed, still just inside the 50s expiry
    const hit2 = cache.get("example.com", TYPE.A)!;
    expect(hit2.readUInt32BE(4)).toBe(1); // never negative, even this close to the edge
  });

  it("clear() empties the cache", () => {
    const cache = new ResponseCache({ clock: new ManualClock(0) });
    cache.put("example.com", TYPE.A, buf("answer"), 60);
    cache.clear();
    expect(cache.get("example.com", TYPE.A)).toBeUndefined();
    expect(cache.size).toBe(0);
  });
});
