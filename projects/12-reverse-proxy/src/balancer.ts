export type Strategy = "round-robin" | "least-connections";

export const STRATEGIES: readonly Strategy[] = ["round-robin", "least-connections"];

export interface Target {
  readonly url: URL;
  /** requests currently being served by this target (leases not yet released) */
  active: number;
}

export interface Lease {
  readonly target: Target;
  /** Give the slot back. Safe to call more than once: only the first call counts. */
  release(): void;
}

/**
 * Chooses which upstream serves the next request.
 *
 * Node runs our code on one thread, so pick-and-increment below cannot interleave with another
 * request. No lock is needed. (With several proxy PROCESSES each has its own counters, see the README.)
 */
export class Balancer {
  readonly targets: Target[];
  private next = 0;

  constructor(urls: URL[], readonly strategy: Strategy = "round-robin") {
    if (urls.length === 0) throw new Error("at least one upstream is required");
    if (!STRATEGIES.includes(strategy)) throw new Error(`unknown strategy: ${String(strategy)}`);
    this.targets = urls.map((url) => ({ url, active: 0 }));
  }

  acquire(): Lease {
    const target = this.strategy === "round-robin" ? this.pickRoundRobin() : this.pickLeastConnections();
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

  private pickRoundRobin(): Target {
    const index = this.next % this.targets.length;
    this.next = index + 1;
    return this.targets[index]!;
  }

  private pickLeastConnections(): Target {
    const n = this.targets.length;
    // Start the scan where the last pick left off, and only replace the best on a STRICTLY smaller
    // count. Result: when everything is equal (for example all idle) the choice rotates instead of
    // always landing on the first target.
    let bestIndex = this.next % n;
    for (let step = 1; step < n; step++) {
      const i = (this.next + step) % n;
      if (this.targets[i]!.active < this.targets[bestIndex]!.active) bestIndex = i;
    }
    this.next = bestIndex + 1;
    return this.targets[bestIndex]!;
  }
}
