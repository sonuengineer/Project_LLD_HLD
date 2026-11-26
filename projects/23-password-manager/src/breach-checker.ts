// Combines the k-anonymity provider call with a timeout and a circuit breaker into one policy: a breach
// check NEVER throws and NEVER blocks the save that triggered it. A timeout, a provider error, or an open
// circuit all degrade to null ("unknown") rather than failing. This is the opposite instinct from this
// project's usual "an error means nothing happened" rule, deliberately: breach-checking is a non-critical
// dependency, and a flaky third-party service must never stop someone from saving a password.
import { isPasswordBreached, FakeBreachProvider, type BreachProvider } from "./breach.js";
import { CircuitBreaker, type CircuitBreakerOptions, type CircuitState } from "./circuit-breaker.js";
import { withTimeout } from "./timeout.js";

export const DEFAULT_BREACH_CHECK_TIMEOUT_MS = 2_000;

export interface BreachCheckerOptions {
  provider?: BreachProvider;
  breaker?: CircuitBreaker;
  breakerOptions?: CircuitBreakerOptions;
  timeoutMs?: number;
}

export class BreachChecker {
  private readonly provider: BreachProvider;
  private readonly breaker: CircuitBreaker;
  private readonly timeoutMs: number;

  constructor(options: BreachCheckerOptions = {}) {
    this.provider = options.provider ?? new FakeBreachProvider();
    this.breaker = options.breaker ?? new CircuitBreaker(options.breakerOptions);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_BREACH_CHECK_TIMEOUT_MS;
  }

  getCircuitState(): CircuitState {
    return this.breaker.getState();
  }

  async check(password: string): Promise<boolean | null> {
    try {
      return await this.breaker.run(() => withTimeout((signal) => isPasswordBreached(password, this.provider, signal), this.timeoutMs));
    } catch {
      return null;
    }
  }
}
