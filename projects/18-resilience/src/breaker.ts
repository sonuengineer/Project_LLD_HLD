import { BrokenCircuitError } from "./errors.js";
import { emit, type Observable } from "./events.js";
import { NEVER, type Operation, type Policy } from "./types.js";

export type CircuitState = "closed" | "open" | "half-open";

export interface StateChange {
  readonly from: CircuitState;
  readonly to: CircuitState;
}

export interface CircuitBreakerOptions extends Observable {
  failureRateThreshold?: number; // open when failures / calls in the window >= this; 0 < x <= 1, default 0.5
  windowSize?: number; // the last N recorded calls, default 20
  minimumCalls?: number; // no decision before this many calls are in the window, default 10 (<= windowSize)
  openMs?: number; // how long to fail fast before letting a probe through, default 30 s
  halfOpenMaxCalls?: number; // probes allowed (and needed to succeed) in half-open, default 1
  // Does this error mean "the dependency is unhealthy"? Default: every error. A 404 or a validation error is the
  // dependency answering correctly: return false and it counts as a SUCCESS for the health window.
  isFailure?: (error: unknown) => boolean;
  onStateChange?: (change: StateChange) => void;
  now?: () => number; // test hook, default Date.now
}

// closed:    calls go through; outcomes are recorded in a sliding window of the last `windowSize` calls. Once at
//            least `minimumCalls` are in it and the failure rate reaches the threshold -> open.
// open:      every call is rejected at once with BrokenCircuitError, the operation is NOT called. After `openMs`
//            the next call finds the breaker half-open (checked lazily on use; no timer runs).
// half-open: up to `halfOpenMaxCalls` probe calls go through, everything else is rejected. One failing probe ->
//            open again (a new `openMs`); all probes succeed -> closed with an empty window.
//
// Every state change starts a new GENERATION. A call records its outcome only if the breaker is still in the
// generation the call started in: a slow call that started while closed and fails after the breaker opened (or
// already went half-open) says nothing about the dependency NOW, and must not reopen it or count as a probe.
//
// A call whose caller aborted is not recorded at all (the dependency did nothing wrong).
export class CircuitBreaker implements Policy {
  private readonly threshold: number;
  private readonly windowSize: number;
  private readonly minimumCalls: number;
  private readonly openMs: number;
  private readonly halfOpenMaxCalls: number;
  private readonly now: () => number;

  private current: CircuitState = "closed";
  private generation = 0;
  private openedAt = 0;
  // Ring buffer of outcomes in the closed state (true = failure).
  private readonly ring: boolean[];
  private next = 0;
  private count = 0;
  private failures = 0;
  // Half-open bookkeeping.
  private probesInFlight = 0;
  private probeSuccesses = 0;

  constructor(private readonly options: CircuitBreakerOptions = {}) {
    this.threshold = options.failureRateThreshold ?? 0.5;
    this.windowSize = options.windowSize ?? 20;
    this.minimumCalls = options.minimumCalls ?? Math.min(10, this.windowSize);
    this.openMs = options.openMs ?? 30_000;
    this.halfOpenMaxCalls = options.halfOpenMaxCalls ?? 1;
    this.now = options.now ?? Date.now;
    if (!(this.threshold > 0 && this.threshold <= 1)) throw new RangeError("failureRateThreshold must be in (0, 1]");
    for (const [name, v] of [["windowSize", this.windowSize], ["minimumCalls", this.minimumCalls], ["halfOpenMaxCalls", this.halfOpenMaxCalls]] as const) {
      if (!Number.isSafeInteger(v) || v < 1) throw new RangeError(`${name} must be an integer >= 1`);
    }
    if (this.minimumCalls > this.windowSize) throw new RangeError("minimumCalls must be <= windowSize");
    if (!Number.isFinite(this.openMs) || this.openMs <= 0) throw new RangeError("openMs must be > 0");
    this.ring = new Array<boolean>(this.windowSize).fill(false);
  }

  get state(): CircuitState {
    this.refresh();
    return this.current;
  }

  // Failure rate over the current window (closed state), for metrics.
  get failureRate(): number {
    return this.count === 0 ? 0 : this.failures / this.count;
  }

  async execute<T>(operation: Operation<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    this.refresh();
    if (this.current === "open") {
      this.rejected("open");
      throw new BrokenCircuitError("open", Math.max(0, this.openedAt + this.openMs - this.now()));
    }
    if (this.current === "half-open") {
      if (this.probesInFlight + this.probeSuccesses >= this.halfOpenMaxCalls) {
        this.rejected("half-open");
        throw new BrokenCircuitError("half-open", 0);
      }
      this.probesInFlight++;
    }
    const generation = this.generation;
    try {
      const result = await operation(signal ?? NEVER);
      this.record(generation, "success");
      return result;
    } catch (error) {
      this.record(generation, signal?.aborted ? "ignored" : this.classify(error));
      throw error;
    }
  }

  // A user-supplied isFailure that throws counts the call as a failure. Without this, its exception skipped
  // record(): a half-open probe never released its slot and the breaker stayed half-open, rejecting everything.
  private classify(error: unknown): "failure" | "success" {
    try {
      return (this.options.isFailure ?? (() => true))(error) ? "failure" : "success";
    } catch {
      return "failure";
    }
  }

  private rejected(state: "open" | "half-open"): void {
    emit(this.options.onEvent, { type: "breaker-rejected", policy: this.options.name ?? "breaker", state });
  }

  private refresh(): void {
    if (this.current === "open" && this.now() - this.openedAt >= this.openMs) this.transition("half-open");
  }

  private record(generation: number, outcome: "success" | "failure" | "ignored"): void {
    if (generation !== this.generation) return; // started in an earlier state: stale, see above
    if (this.current === "half-open") {
      this.probesInFlight--;
      if (outcome === "failure") this.transition("open");
      else if (outcome === "success" && ++this.probeSuccesses >= this.halfOpenMaxCalls) this.transition("closed");
      return;
    }
    if (this.current !== "closed" || outcome === "ignored") return;
    const failed = outcome === "failure";
    if (this.count === this.windowSize) {
      if (this.ring[this.next]) this.failures--; // the oldest outcome falls out of the window
    } else {
      this.count++;
    }
    this.ring[this.next] = failed;
    if (failed) this.failures++;
    this.next = (this.next + 1) % this.windowSize;
    if (this.count >= this.minimumCalls && this.failures / this.count >= this.threshold) this.transition("open");
  }

  private transition(to: CircuitState): void {
    const from = this.current;
    this.current = to;
    this.generation++;
    if (to === "open") this.openedAt = this.now();
    if (to === "half-open") {
      this.probesInFlight = 0;
      this.probeSuccesses = 0;
    }
    if (to === "closed") {
      this.ring.fill(false);
      this.next = 0;
      this.count = 0;
      this.failures = 0;
    }
    try {
      this.options.onStateChange?.({ from, to });
    } catch {
      // A logging callback that throws must not turn a finished call into a failure.
    }
    emit(this.options.onEvent, { type: "breaker-state", policy: this.options.name ?? "breaker", from, to });
  }
}
