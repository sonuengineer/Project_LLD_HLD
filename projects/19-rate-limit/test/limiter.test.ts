import { describe, expect, it } from "vitest";
import { slidingWindow, tokenBucket } from "../src/algorithms.js";
import { RateLimiter, type Store } from "../src/limiter.js";
import { MemoryStore } from "../src/memory-store.js";

describe("RateLimiter", () => {
  const recording = () => {
    const keys: string[] = [];
    const store: Store = { consume: async (_a, key) => (keys.push(key), { allowed: true, limit: 1, remaining: 0, retryAfterMs: 0, resetMs: 0 }) };
    return { store, keys };
  };

  it("prefixes keys (default rl:) so different limits never share state", async () => {
    const { store, keys } = recording();
    await new RateLimiter({ algorithm: tokenBucket({ capacity: 5, refillPerSec: 1 }), store }).consume("ip:1.2.3.4");
    await new RateLimiter({ algorithm: tokenBucket({ capacity: 5, refillPerSec: 1 }), store, prefix: "rl:login:" }).consume("ip:1.2.3.4");
    expect(keys).toEqual(["rl:ip:1.2.3.4", "rl:login:ip:1.2.3.4"]);
  });

  it.each([
    ["an empty key", "", 1, /non-empty/],
    ["a key over 512 characters", "k".repeat(513), 1, /longer than 512/],
    ["cost 0", "a", 0, /cost must be/],
    ["a fractional cost", "a", 1.5, /cost must be/],
    ["a cost above the limit (can never be allowed)", "a", 6, /exceeds the limit 5/],
  ])("rejects %s before touching the store", async (_label, key, cost, message) => {
    const { store, keys } = recording();
    const limiter = new RateLimiter({ algorithm: tokenBucket({ capacity: 5, refillPerSec: 1 }), store });
    await expect(limiter.consume(key, cost)).rejects.toThrow(message);
    expect(keys).toEqual([]);
  });

  it("a key of exactly 512 characters and a cost equal to the limit are fine", async () => {
    const limiter = new RateLimiter({ algorithm: tokenBucket({ capacity: 5, refillPerSec: 1 }), store: new MemoryStore() });
    expect((await limiter.consume("k".repeat(512), 5)).allowed).toBe(true);
  });
});

describe("MemoryStore", () => {
  it("keeps at most maxKeys keys, dropping the least recently used (which resets that client)", async () => {
    let t = 0;
    const store = new MemoryStore({ maxKeys: 2, now: () => t });
    const limiter = new RateLimiter({ algorithm: tokenBucket({ capacity: 1, refillPerSec: 0.001 }), store });
    await limiter.consume("a");
    await limiter.consume("b");
    await limiter.consume("a"); // denied, and "a" is now the most recently used
    await limiter.consume("c"); // evicts "b"
    expect(store.size).toBe(2);
    expect((await limiter.consume("a")).allowed).toBe(false); // "a" kept its state
    expect((await limiter.consume("b")).allowed).toBe(true); // "b" was dropped: fresh full bucket
  });

  it("a long-idle key behaves exactly like a new one (no expiry needed): full bucket / empty window", async () => {
    let t = 0;
    const store = new MemoryStore({ now: () => t });
    const bucket = new RateLimiter({ algorithm: tokenBucket({ capacity: 3, refillPerSec: 1 }), store, prefix: "tb:" });
    const window = new RateLimiter({ algorithm: slidingWindow({ limit: 3, windowMs: 1000 }), store, prefix: "sw:" });
    for (let i = 0; i < 3; i++) {
      await bucket.consume("a");
      await window.consume("a");
    }
    t += 86_400_000; // a day later
    expect(await bucket.consume("a")).toEqual(await bucket.consume("fresh-1"));
    expect(await window.consume("a")).toEqual(await window.consume("fresh-2"));
  });

  it("100 000 distinct keys with maxKeys 1000 stay at 1000 (memory bounded)", async () => {
    const store = new MemoryStore({ maxKeys: 1000 });
    const limiter = new RateLimiter({ algorithm: tokenBucket({ capacity: 1, refillPerSec: 1 }), store });
    for (let i = 0; i < 100_000; i++) await limiter.consume(`ip:${i}`);
    expect(store.size).toBe(1000);
  });

  it.each([0, -1, 1.5])("rejects maxKeys %s", (maxKeys) => {
    expect(() => new MemoryStore({ maxKeys })).toThrow(RangeError);
  });
});
