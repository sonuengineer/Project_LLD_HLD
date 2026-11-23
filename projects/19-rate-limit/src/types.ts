// What a limiter answers for one request.
export interface Decision {
  readonly allowed: boolean;
  readonly limit: number; // capacity (token bucket) or limit per window (sliding window)
  readonly remaining: number; // whole units left after this request (0 when denied and empty)
  readonly retryAfterMs: number; // 0 when allowed; otherwise how long until this cost would be allowed
  readonly resetMs: number; // until fully refilled (token bucket) / until the current window ends (sliding window)
}

// A rate-limiting algorithm in two forms that MUST agree (tested by test/parity.test.ts):
//   step(): the TypeScript version, used by MemoryStore
//   lua + args(): the Redis version, run atomically by RedisStore
export interface Algorithm<S> {
  readonly name: string;
  readonly limit: number;
  readonly luaFile: string; // file in src/lua/
  args(): string[]; // ARGV[1], ARGV[2]; RedisStore appends now_ms and cost
  // One request at time `now` (ms) with `cost` units, given the stored state (undefined = never seen / expired).
  step(state: S | undefined, now: number, cost: number): { state: S; decision: Decision };
  stateTtlMs(): number; // how long state is worth keeping after the last request
}

export class RateLimitError extends Error {
  override name = "RateLimitError";
}
