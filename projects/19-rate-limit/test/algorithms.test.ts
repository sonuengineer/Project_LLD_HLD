import { describe, expect, it } from "vitest";
import { luaToString, slidingWindow, tokenBucket } from "../src/algorithms.js";
import { RateLimiter } from "../src/limiter.js";
import { MemoryStore } from "../src/memory-store.js";
import type { Algorithm } from "../src/types.js";

function memoryLimiter<S>(algorithm: Algorithm<S>) {
  let t = 1_000_000;
  const limiter = new RateLimiter({ algorithm, store: new MemoryStore({ now: () => t }) });
  return { limiter, advance: (ms: number) => (t += ms), at: (ms: number) => (t = ms) };
}

describe("token bucket", () => {
  it("allows a burst of `capacity`, then denies with the exact wait for one token", async () => {
    const { limiter } = memoryLimiter(tokenBucket({ capacity: 5, refillPerSec: 1 }));
    for (let i = 4; i >= 0; i--) expect(await limiter.consume("a")).toMatchObject({ allowed: true, remaining: i, retryAfterMs: 0 });
    expect(await limiter.consume("a")).toEqual({ allowed: false, limit: 5, remaining: 0, retryAfterMs: 1000, resetMs: 5000 });
  });

  it("refills lazily at refillPerSec (half a second = half a token: still denied, retry 500)", async () => {
    const { limiter, advance } = memoryLimiter(tokenBucket({ capacity: 2, refillPerSec: 2 }));
    await limiter.consume("a");
    await limiter.consume("a");
    advance(250); // 0.5 token
    expect(await limiter.consume("a")).toMatchObject({ allowed: false, retryAfterMs: 250 });
    advance(250); // 1 token
    expect(await limiter.consume("a")).toMatchObject({ allowed: true, remaining: 0 });
  });

  it("never refills above capacity", async () => {
    const { limiter, advance } = memoryLimiter(tokenBucket({ capacity: 3, refillPerSec: 10 }));
    await limiter.consume("a");
    advance(3_600_000);
    expect(await limiter.consume("a")).toMatchObject({ allowed: true, remaining: 2 });
  });

  it("cost > 1 takes several tokens at once; a denied request takes none", async () => {
    const { limiter } = memoryLimiter(tokenBucket({ capacity: 10, refillPerSec: 1 }));
    expect(await limiter.consume("a", 7)).toMatchObject({ allowed: true, remaining: 3 });
    expect(await limiter.consume("a", 4)).toMatchObject({ allowed: false, remaining: 3, retryAfterMs: 1000 });
    expect(await limiter.consume("a", 3)).toMatchObject({ allowed: true, remaining: 0 });
  });

  it("a clock going backwards neither adds nor REMOVES tokens", async () => {
    const { limiter, advance } = memoryLimiter(tokenBucket({ capacity: 10, refillPerSec: 1 }));
    await limiter.consume("a"); // 9 left
    advance(-5000);
    // Without the max(.., 0) the bucket would lose 5 tokens (9 - 5 = 4 -> 3 left); with it, 9 - 1 = 8 left.
    expect(await limiter.consume("a")).toMatchObject({ allowed: true, remaining: 8 });
  });

  it("keys are independent", async () => {
    const { limiter } = memoryLimiter(tokenBucket({ capacity: 1, refillPerSec: 1 }));
    expect((await limiter.consume("a")).allowed).toBe(true);
    expect((await limiter.consume("b")).allowed).toBe(true);
    expect((await limiter.consume("a")).allowed).toBe(false);
  });

  it.each([
    [{ capacity: 0, refillPerSec: 1 }],
    [{ capacity: 1, refillPerSec: 0 }],
    [{ capacity: Number.NaN, refillPerSec: 1 }],
  ])("rejects %j", (opts) => {
    expect(() => tokenBucket(opts)).toThrow(/must be a positive number/);
  });
});

describe("sliding window counter", () => {
  const W = 60_000;

  it("allows `limit` in a fresh window, then denies until the window ends", async () => {
    const { limiter, at } = memoryLimiter(slidingWindow({ limit: 3, windowMs: W }));
    at(10 * W); // a window start
    for (let i = 2; i >= 0; i--) expect(await limiter.consume("a")).toMatchObject({ allowed: true, remaining: i, resetMs: W });
    expect(await limiter.consume("a")).toEqual({ allowed: false, limit: 3, remaining: 0, retryAfterMs: W, resetMs: W });
  });

  it("weights the previous window: 10 last window, 25% into this one -> 7.5 still count", async () => {
    const { limiter, at } = memoryLimiter(slidingWindow({ limit: 10, windowMs: W }));
    at(10 * W);
    for (let i = 0; i < 10; i++) await limiter.consume("a");
    at(11 * W + W / 4); // weight 0.75 -> 7.5 estimated
    expect(await limiter.consume("a")).toMatchObject({ allowed: true, remaining: 1 }); // 1 + 7.5 = 8.5 -> floor(1.5)
    expect(await limiter.consume("a")).toMatchObject({ allowed: true, remaining: 0 }); // 2 + 7.5 = 9.5
    const denied = await limiter.consume("a"); // 2 + 7.5 + 1 = 10.5 > 10
    expect(denied.allowed).toBe(false);
    // 0.5 must disappear from the weighted 10: 0.5 / 10 x 60 000 = 3000 ms
    expect(denied.retryAfterMs).toBe(3000);
  });

  it("a window two or more back no longer counts", async () => {
    const { limiter, at } = memoryLimiter(slidingWindow({ limit: 2, windowMs: W }));
    at(10 * W);
    await limiter.consume("a");
    await limiter.consume("a");
    at(12 * W + 1);
    expect(await limiter.consume("a")).toMatchObject({ allowed: true, remaining: 1 });
  });

  it("a denied request does not count", async () => {
    const { limiter, at } = memoryLimiter(slidingWindow({ limit: 1, windowMs: W }));
    at(10 * W);
    await limiter.consume("a");
    for (let i = 0; i < 5; i++) await limiter.consume("a");
    at(11 * W); // previous window had exactly 1 (the denied ones did not count): weight 1 -> 1, still full
    expect((await limiter.consume("a")).allowed).toBe(false);
    at(11 * W + W / 2); // 0.5 left
    expect((await limiter.consume("a")).allowed).toBe(false); // 0.5 + 1 = 1.5 > 1
    at(12 * W - 1); // 1 ms of window 10 still inside the sliding window: 1 x 1/60000 + 1 = 1.0000167 > 1
    expect((await limiter.consume("a")).allowed).toBe(false);
    at(12 * W); // window 10 is now two windows back; window 11 had 0 allowed
    expect((await limiter.consume("a")).allowed).toBe(true);
  });

  it.each([[{ limit: 0, windowMs: 1000 }], [{ limit: 1, windowMs: 0 }], [{ limit: 1, windowMs: 10.5 }]])("rejects %j", (opts) => {
    expect(() => slidingWindow(opts)).toThrow();
  });
});

describe("luaToString", () => {
  it("rounds like Redis Lua's tostring (14 significant digits)", () => {
    expect(luaToString(0.1 + 0.2)).toBe(0.3);
    expect(luaToString(1 / 3)).toBe(0.33333333333333);
    expect(luaToString(4.999999999999999)).toBe(5);
  });
});
