// A small, self-contained circuit breaker: protects the vault from a slow or flaky dependency (here, the
// breach-check provider) without that dependency ever being able to block a password save. Same injectable
// Clock pattern as the rest of this project, so tests sit exactly on the cooldown boundary without sleeping.
import { Clock, systemClock } from "./clock.js";

export type CircuitState = "closed" | "open" | "half-open";

export interface CircuitBreakerOptions {
  failureThreshold?: number; // consecutive failures before opening
  cooldownMs?: number; // how long OPEN lasts before a single half-open trial is allowed
  clock?: Clock;
}

export const DEFAULT_FAILURE_THRESHOLD = 3;
export const DEFAULT_COOLDOWN_MS = 10_000;

export class CircuitBreaker {
  private consecutiveFailures = 0;
  private state: CircuitState = "closed";
  private openedAt: number | null = null;
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly clock: Clock;

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
    this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.clock = options.clock ?? systemClock;
  }

  getState(): CircuitState {
    return this.state;
  }

  // While open, fn() is never even called -- the same fail-fast philosophy as the vault's own claims.
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === "open") {
      if (this.openedAt !== null && this.clock.now() - this.openedAt >= this.cooldownMs) {
        this.state = "half-open";
      } else {
        throw new Error("CIRCUIT_OPEN");
      }
    }
    try {
      const result = await fn();
      this.consecutiveFailures = 0;
      this.state = "closed";
      return result;
    } catch (err) {
      this.consecutiveFailures++;
      if (this.state === "half-open" || this.consecutiveFailures >= this.failureThreshold) {
        this.state = "open";
        this.openedAt = this.clock.now();
      }
      throw err;
    }
  }
}
