import { RateLimitError, type Algorithm, type Decision } from "./types.js";

// Redis's Lua turns a number into a string with "%.14g" (14 significant digits) when the token bucket stores its
// fractional token count with tostring(). To give exactly the same decisions as Redis, the TypeScript version
// rounds the STORED value the same way (mutation L1 -- not rounding -- makes the parity test fail).
export const luaToString = (x: number): number => Number(x.toPrecision(14));

function positive(name: string, v: number): number {
  if (!Number.isFinite(v) || v <= 0) throw new RateLimitError(`${name} must be a positive number`);
  return v;
}

// ---- Token bucket: bursts up to `capacity`, then a steady `refillPerSec`. src/lua/token_bucket.lua ----

export interface TokenBucketState {
  tokens: number;
  ts: number;
}

export function tokenBucket(options: { capacity: number; refillPerSec: number }): Algorithm<TokenBucketState> {
  const capacity = positive("capacity", options.capacity);
  const rate = positive("refillPerSec", options.refillPerSec);
  return {
    name: "token-bucket",
    limit: capacity,
    luaFile: "token_bucket.lua",
    args: () => [String(capacity), String(rate)],
    step(state, now, cost) {
      let tokens = state?.tokens ?? capacity; // a new identity starts with a full bucket
      const ts = state?.ts ?? now;
      const elapsed = Math.max(now - ts, 0); // a clock going backwards never adds tokens
      tokens = Math.min(capacity, tokens + (elapsed * rate) / 1000);
      let allowed = false;
      let retry = 0;
      if (tokens >= cost) {
        tokens -= cost;
        allowed = true;
      } else {
        retry = Math.ceil(((cost - tokens) * 1000) / rate);
      }
      // The reply uses the FULL-precision value (the Lua variable); only the STORED value is rounded by tostring().
      // (Rounding both was the first version; the parity test caught a 1 ms difference in resetMs.)
      const decision: Decision = {
        allowed,
        limit: capacity,
        remaining: Math.floor(tokens),
        retryAfterMs: retry,
        resetMs: Math.ceil(((capacity - tokens) * 1000) / rate),
      };
      return { state: { tokens: luaToString(tokens), ts: now }, decision };
    },
  };
}

// ---- Sliding window counter: about `limit` per `windowMs`, smooth across window edges. src/lua/sliding_counter.lua
// estimate = this window's count + previous window's count x the fraction of the previous window still inside the
// sliding window. Approximate (exact only if the previous window's requests were evenly spread), O(1) memory.

export interface SlidingWindowState {
  start: number; // start of the window `count` belongs to
  count: number;
  prevCount: number; // count of the window before `start`
}

export function slidingWindow(options: { limit: number; windowMs: number }): Algorithm<SlidingWindowState> {
  const limit = positive("limit", options.limit);
  const window = positive("windowMs", options.windowMs);
  if (!Number.isInteger(window)) throw new RateLimitError("windowMs must be an integer");
  return {
    name: "sliding-window",
    limit,
    luaFile: "sliding_counter.lua",
    args: () => [String(limit), String(window)],
    step(state, now, cost) {
      const curStart = now - (now % window);
      // What Redis would find under the keys for the current and the previous window.
      let cur = 0;
      let prev = 0;
      if (state !== undefined) {
        if (state.start === curStart) {
          cur = state.count;
          prev = state.prevCount;
        } else if (state.start === curStart - window) {
          prev = state.count;
        }
      }
      const elapsed = now - curStart;
      const weight = (window - elapsed) / window;
      const estimated = cur + prev * weight;
      if (estimated + cost > limit) {
        let retry = window - elapsed;
        // Both candidates are >= 1 ms (elapsed < window; needed > 0), so the max(.., 1) below never changes the
        // value -- kept to mirror the Lua script; a mutation removing it is equivalent (documented in the README).
        if (prev > 0) {
          const needed = estimated + cost - limit;
          const ms = Math.ceil((needed / prev) * window);
          if (ms < retry) retry = ms;
        }
        const decision: Decision = {
          allowed: false,
          limit,
          remaining: Math.max(Math.floor(limit - estimated), 0),
          retryAfterMs: Math.max(retry, 1),
          resetMs: window - elapsed,
        };
        // A denied request changes nothing (the Lua script returns before INCRBY).
        return { state: state ?? { start: curStart, count: 0, prevCount: 0 }, decision };
      }
      cur += cost;
      const decision: Decision = {
        allowed: true,
        limit,
        remaining: Math.max(Math.floor(limit - (cur + prev * weight)), 0),
        retryAfterMs: 0,
        resetMs: window - elapsed,
      };
      return { state: { start: curStart, count: cur, prevCount: prev }, decision };
    },
  };
}
