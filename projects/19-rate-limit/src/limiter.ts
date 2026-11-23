import { RateLimitError, type Algorithm, type Decision } from "./types.js";

export interface Store {
  consume<S>(algorithm: Algorithm<S>, key: string, cost: number): Promise<Decision>;
}

export interface RateLimiterOptions<S> {
  algorithm: Algorithm<S>;
  store: Store;
  // Namespaces the keys, e.g. "rl:login:" -- one prefix per limit, so a login limit and an API limit for the same
  // user never share state. Default "rl:".
  prefix?: string;
}

const MAX_KEY_LENGTH = 512;

// One limit (an algorithm with its numbers) over one store. Keys are whatever identifies the client for this limit:
// an IP, a user id, "user:42:otp".
export class RateLimiter<S = unknown> {
  readonly prefix: string;

  constructor(private readonly options: RateLimiterOptions<S>) {
    this.prefix = options.prefix ?? "rl:";
  }

  get limit(): number {
    return this.options.algorithm.limit;
  }

  async consume(key: string, cost = 1): Promise<Decision> {
    if (typeof key !== "string" || key.length === 0) throw new RateLimitError("key must be a non-empty string");
    if (key.length > MAX_KEY_LENGTH) throw new RateLimitError(`key longer than ${MAX_KEY_LENGTH} characters`);
    if (!Number.isSafeInteger(cost) || cost < 1) throw new RateLimitError("cost must be an integer >= 1");
    // A cost above the limit can NEVER be allowed; say so instead of returning a retry time that will never work.
    if (cost > this.options.algorithm.limit) throw new RateLimitError(`cost ${cost} exceeds the limit ${this.options.algorithm.limit}`);
    return this.options.store.consume(this.options.algorithm, this.prefix + key, cost);
  }
}
