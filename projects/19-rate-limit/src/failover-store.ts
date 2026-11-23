import type { Store } from "./limiter.js";
import { StoreUnavailableError, type Algorithm, type Decision } from "./types.js";

// Anything with resilience-kit's Policy shape -- e.g. wrap(new CircuitBreaker(...), new TimeoutPolicy({ ms: 50 }))
// from projects/18-resilience. Structural: this package does not import resilience-kit.
export interface Guard {
  execute<T>(operation: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T>;
}

export interface FailoverStoreOptions {
  // Runs every call to the primary. A timeout here is what keeps a HANGING Redis (network partition, overloaded
  // server) from hanging every request; a circuit breaker skips the primary at once while it is known to be down.
  // Note: the Redis call itself cannot be cancelled (clients take no AbortSignal) -- a timeout stops WAITING for it.
  guard?: Guard;
  // Used when the primary fails. Typically a MemoryStore: each instance then limits on its own until Redis is back
  // (weaker -- up to N x the limit with N instances -- but still a limit). Decisions are marked `degraded`.
  // Without a fallback, a primary failure is a StoreUnavailableError (the adapters' onStoreError decides).
  fallback?: Store;
  onError?: (error: unknown) => void; // for logs / metrics; a throwing handler is ignored
}

// A Store that tries a primary (Redis) and, if it fails, a fallback (memory) or a clear StoreUnavailableError.
// Errors from the FALLBACK are not hidden: they are reported as StoreUnavailableError too.
export class FailoverStore implements Store {
  constructor(
    private readonly primary: Store,
    private readonly options: FailoverStoreOptions = {},
  ) {}

  async consume<S>(algorithm: Algorithm<S>, key: string, cost: number): Promise<Decision> {
    try {
      const run = () => this.primary.consume(algorithm, key, cost);
      return await (this.options.guard ? this.options.guard.execute(run) : run());
    } catch (error) {
      try {
        this.options.onError?.(error);
      } catch {
        // ignored: telemetry must not change the decision
      }
      if (this.options.fallback === undefined) {
        throw new StoreUnavailableError("rate-limit store unavailable", { cause: error });
      }
      try {
        const decision = await this.options.fallback.consume(algorithm, key, cost);
        return { ...decision, degraded: true };
      } catch (fallbackError) {
        throw new StoreUnavailableError("rate-limit store and fallback unavailable", { cause: fallbackError });
      }
    }
  }
}
