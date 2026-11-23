import type { Algorithm, Decision } from "./types.js";

export interface MemoryStoreOptions {
  // Upper bound on tracked keys. Rate-limit keys often come from the client (IP, user id), so without a bound a
  // flood of distinct keys is a memory attack. When full, the least recently used key is dropped -- which RESETS
  // that client's limit (it starts with a full allowance). Default 100 000.
  maxKeys?: number;
  now?: () => number; // test hook, default Date.now
}

// In-process store: one Node process, no Redis. Right for a single instance, tests, or a first line in front of
// Redis. With several instances each has its own counts (N instances -> up to N x the limit).
//
// No per-key expiry (unlike Redis's PEXPIRE): both algorithms already treat long-idle state exactly like no state
// (a bucket refills to full; a window two or more back never matches), so expiry would only free memory -- and
// maxKeys bounds memory. An earlier version had a lazy expiry check; a mutation check showed it changed no
// decision, so it was removed.
export class MemoryStore {
  private readonly entries = new Map<string, unknown>(); // insertion order = least recently used first
  private readonly maxKeys: number;
  private readonly now: () => number;

  constructor(options: MemoryStoreOptions = {}) {
    const maxKeys = options.maxKeys ?? 100_000;
    if (!Number.isSafeInteger(maxKeys) || maxKeys < 1) throw new RangeError("maxKeys must be an integer >= 1");
    this.maxKeys = maxKeys;
    this.now = options.now ?? Date.now;
  }

  get size(): number {
    return this.entries.size;
  }

  async consume<S>(algorithm: Algorithm<S>, key: string, cost: number): Promise<Decision> {
    const { state, decision } = algorithm.step(this.entries.get(key) as S | undefined, this.now(), cost);
    // Re-insert: moves the key to the most-recently-used end.
    this.entries.delete(key);
    this.entries.set(key, state);
    if (this.entries.size > this.maxKeys) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
    }
    return decision;
  }
}
