import { TimeoutError } from "./errors.js";
import { emit, type Observable } from "./events.js";
import { listenable, type Operation, type Policy } from "./types.js";

export interface TimeoutOptions extends Observable {
  ms: number;
}

// Gives an operation a deadline. On timeout it does two things:
//   1. aborts the signal the operation was given (reason: a TimeoutError), so a well-behaved operation (fetch, a DB
//      driver that takes a signal) really stops instead of running on in the background;
//   2. rejects with the TimeoutError at once, even if the operation ignores its signal.
// The caller's own signal is linked in: if the caller aborts, the operation's signal is aborted with the caller's
// reason and execute() rejects at once with that reason.
export class TimeoutPolicy implements Policy {
  readonly ms: number;

  constructor(private readonly options: TimeoutOptions) {
    if (!Number.isFinite(options.ms) || options.ms <= 0) throw new RangeError("timeout ms must be a positive number");
    this.ms = options.ms;
  }

  async execute<T>(operation: Operation<T>, callerSignal?: AbortSignal): Promise<T> {
    const signal = listenable(callerSignal); // never listen on the shared never-aborting signal
    signal?.throwIfAborted();
    const controller = new AbortController();
    const onCallerAbort = () => controller.abort(signal!.reason);
    signal?.addEventListener("abort", onCallerAbort, { once: true });
    const timer = setTimeout(() => {
      emit(this.options.onEvent, { type: "timeout", policy: this.options.name ?? "timeout", timeoutMs: this.ms });
      controller.abort(new TimeoutError(this.ms));
    }, this.ms);

    // Rejects as soon as the operation's signal is aborted, for whichever reason.
    const stopped = new Promise<never>((_, reject) => {
      controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
    });
    try {
      // async wrapper: an operation that throws synchronously becomes a rejection like any other failure.
      return await Promise.race([(async () => operation(controller.signal))(), stopped]);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onCallerAbort);
    }
  }
}
