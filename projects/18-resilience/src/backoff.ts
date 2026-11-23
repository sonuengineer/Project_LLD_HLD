// How long to wait before retry number N.
//
// Exponential: initialMs * multiplier^(N-1), capped at maxMs. Jitter spreads the waits of many clients that failed
// at the same moment, so they do not all come back at the same moment and knock the service over again:
//   none:  exactly the exponential value (deterministic; fine for one client, bad for a fleet)
//   full:  random between 0 and the value (the default; spreads the most)
//   equal: half the value plus random up to the other half (never retries almost immediately)
export type Jitter = "none" | "full" | "equal";

export interface BackoffOptions {
  initialMs?: number; // default 100
  maxMs?: number; // default 10_000
  multiplier?: number; // default 2
  jitter?: Jitter; // default "full"
}

export interface Backoff {
  delayMs(retryNumber: number, random: () => number): number;
}

export function exponentialBackoff(options: BackoffOptions = {}): Backoff {
  const initialMs = options.initialMs ?? 100;
  const maxMs = options.maxMs ?? 10_000;
  const multiplier = options.multiplier ?? 2;
  const jitter = options.jitter ?? "full";
  if (!Number.isFinite(initialMs) || initialMs < 0) throw new RangeError("initialMs must be >= 0");
  if (!Number.isFinite(maxMs) || maxMs < initialMs) throw new RangeError("maxMs must be >= initialMs");
  if (!Number.isFinite(multiplier) || multiplier < 1) throw new RangeError("multiplier must be >= 1");
  if (!["none", "full", "equal"].includes(jitter)) throw new RangeError(`unknown jitter ${String(jitter)}`);

  return {
    delayMs(retryNumber, random) {
      // Math.min first: multiplier^n overflows to Infinity for large n, and min(maxMs, Infinity) is still maxMs.
      const ceiling = Math.min(maxMs, initialMs * multiplier ** (retryNumber - 1));
      switch (jitter) {
        case "none":
          return Math.floor(ceiling);
        case "full":
          return Math.floor(random() * ceiling);
        case "equal":
          return Math.floor(ceiling / 2 + random() * (ceiling / 2));
      }
    },
  };
}
