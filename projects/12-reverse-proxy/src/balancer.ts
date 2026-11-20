export type Strategy = "round-robin" | "least-connections";

export const STRATEGIES: readonly Strategy[] = ["round-robin", "least-connections"];

export interface Target {
  readonly url: URL;
  /** requests currently being served by this target (leases not yet released) */
  active: number;
  /** switched by ACTIVE health checks (probes). Starts true: we assume healthy until shown otherwise. */
  healthy: boolean;
  /** consecutive connection-level failures seen on real traffic (PASSIVE health) */
  failures: number;
  /** passive ejection: the target is skipped until this time (ms on the balancer's clock) */
  ejectedUntil: number;
}

export interface Lease {
  readonly target: Target;
  /** Give the slot back. Safe to call more than once: only the first call counts. */
  release(): void;
}

export interface HealthEvent {
  /** the upstream URL host: "host:port", or just "host" for the default port 80 */
  upstream: string;
  healthy: boolean;
  reason: string;
}

export interface BalancerOptions {
  /** consecutive connection failures before a target is ejected. Default 3. */
  ejectAfter?: number;
  /** how long an ejected target is skipped. Default 10000 ms. */
  ejectMs?: number;
  /** time source in ms; injectable so tests need no real waiting. */
  clock?: () => number;
  onHealthChange?: (event: HealthEvent) => void;
}

/** Thrown by acquire() when every target is unhealthy or ejected. The proxy turns it into a 503. */
export class NoHealthyUpstreamError extends Error {
  constructor() {
    super("no healthy upstream available");
    this.name = "NoHealthyUpstreamError";
  }
}

/**
 * Chooses which upstream serves the next request, and tracks which upstreams are fit to receive traffic.
 *
 * Node runs our code on one thread, so pick-and-increment below cannot interleave with another
 * request. No lock is needed. (With several proxy PROCESSES each has its own counters, see the README.)
 */
export class Balancer {
  readonly targets: Target[];
  private next = 0;
  private readonly ejectAfter: number;
  private readonly ejectMs: number;
  private readonly clock: () => number;
  private readonly onHealthChange?: (event: HealthEvent) => void;
  /** targets that are (or were last) ejected by passive checks, so recovery can be reported once */
  private readonly ejected = new Set<Target>();

  constructor(urls: URL[], readonly strategy: Strategy = "round-robin", options: BalancerOptions = {}) {
    if (urls.length === 0) throw new Error("at least one upstream is required");
    for (const url of urls) {
      if (url.protocol !== "http:") throw new Error("only http:// upstreams are supported");
      if (url.pathname !== "/" || url.search) throw new Error("upstream must not contain a path or query");
    }
    if (!STRATEGIES.includes(strategy)) throw new Error(`unknown strategy: ${String(strategy)}`);
    this.ejectAfter = options.ejectAfter ?? 3;
    this.ejectMs = options.ejectMs ?? 10_000;
    this.clock = options.clock ?? Date.now;
    this.onHealthChange = options.onHealthChange;
    if (this.ejectAfter < 1) throw new Error("ejectAfter must be at least 1");
    this.targets = urls.map((url) => ({ url, active: 0, healthy: true, failures: 0, ejectedUntil: 0 }));
  }

  /** A target can receive traffic when active checks say healthy AND it is not serving an ejection. */
  isAvailable(target: Target, now: number = this.clock()): boolean {
    return target.healthy && now >= target.ejectedUntil;
  }

  /**
   * @param avoid a target that just failed this request: used for retries. Another available target is
   *   preferred; if it is the only one available it may be chosen again (a retry on the same server
   *   still helps with a stale keep-alive connection).
   * @throws NoHealthyUpstreamError when nothing is available
   */
  acquire(avoid?: Target): Lease {
    const now = this.clock();
    let eligible = this.targets.filter((t) => this.isAvailable(t, now));
    if (eligible.length === 0) throw new NoHealthyUpstreamError();
    if (avoid && eligible.length > 1) eligible = eligible.filter((t) => t !== avoid);
    const allowed = new Set(eligible);

    const target = this.strategy === "round-robin" ? this.pickRoundRobin(allowed) : this.pickLeastConnections(allowed);
    target.active++;
    let released = false;
    return {
      target,
      release: () => {
        if (released) return;
        released = true;
        target.active--;
      },
    };
  }

  /** A copy of the current state of every target, for logging and debugging. */
  snapshot(now: number = this.clock()): { upstream: string; active: number; healthy: boolean; ejected: boolean }[] {
    return this.targets.map((t) => ({ upstream: t.url.host, active: t.active, healthy: t.healthy, ejected: now < t.ejectedUntil }));
  }

  /** The upstream accepted the request and answered (any HTTP status): it is reachable. */
  reportSuccess(target: Target): void {
    target.failures = 0;
    if (this.ejected.delete(target)) this.emit(target, true, "answered after ejection");
  }

  /**
   * A connection-level failure on real traffic (refused, reset, timeout). HTTP 5xx answers are NOT
   * failures here: the server is reachable, the application is what is broken.
   */
  reportFailure(target: Target): void {
    const now = this.clock();
    if (now < target.ejectedUntil) return; // already ejected: stragglers already in flight do not extend it
    target.failures++;
    if (target.failures >= this.ejectAfter) {
      target.ejectedUntil = now + this.ejectMs;
      // One failure after the ejection ends puts it straight back out (a single trial request),
      // while one success wipes the slate clean.
      target.failures = this.ejectAfter - 1;
      this.ejected.add(target);
      this.emit(target, false, `ejected for ${this.ejectMs} ms after ${this.ejectAfter} consecutive failures`);
    }
  }

  /** Used by active health checks. Coming back healthy also clears any passive ejection. */
  setHealthy(target: Target, healthy: boolean, reason: string): void {
    if (target.healthy === healthy) return;
    target.healthy = healthy;
    if (healthy) {
      target.ejectedUntil = 0;
      target.failures = 0;
      this.ejected.delete(target);
    }
    this.emit(target, healthy, reason);
  }

  private emit(target: Target, healthy: boolean, reason: string): void {
    this.onHealthChange?.({ upstream: target.url.host, healthy, reason });
  }

  private pickRoundRobin(allowed: Set<Target>): Target {
    const n = this.targets.length;
    for (let step = 0; step < n; step++) {
      const i = (this.next + step) % n;
      const target = this.targets[i]!;
      if (allowed.has(target)) {
        this.next = i + 1;
        return target;
      }
    }
    throw new NoHealthyUpstreamError(); // unreachable: acquire() checked that something is allowed
  }

  private pickLeastConnections(allowed: Set<Target>): Target {
    const n = this.targets.length;
    // Start the scan where the last pick left off, and only replace the best on a STRICTLY smaller
    // count. Result: when everything is equal (for example all idle) the choice rotates instead of
    // always landing on the first target.
    let bestIndex = -1;
    for (let step = 0; step < n; step++) {
      const i = (this.next + step) % n;
      const target = this.targets[i]!;
      if (!allowed.has(target)) continue;
      if (bestIndex < 0 || target.active < this.targets[bestIndex]!.active) bestIndex = i;
    }
    if (bestIndex < 0) throw new NoHealthyUpstreamError();
    this.next = bestIndex + 1;
    return this.targets[bestIndex]!;
  }
}
