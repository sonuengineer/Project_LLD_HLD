import { BulkheadRejectedError } from "./errors.js";
import { emit, type Observable, type ResilienceEventHandler } from "./events.js";
import type { Operation, Policy } from "./types.js";

export interface BulkheadOptions extends Observable {
  maxConcurrent: number; // calls running at once
  maxQueue?: number; // calls waiting for a slot; default 0 (reject at once when all slots are busy)
}

interface Waiter {
  resolve: () => void;
  reject: (reason: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

const NEVER = new AbortController().signal;

// Limits how many calls to ONE dependency run at once, so a slow dependency can use up at most its own slots and
// not every connection / worker in the process (the name comes from a ship's watertight compartments).
//
// FIFO queue of bounded length; beyond it calls are rejected with BulkheadRejectedError without running. A finishing
// call hands its slot DIRECTLY to the oldest waiter (the running count does not drop), so a newcomer arriving at
// that moment cannot take the slot ahead of someone who waited. A waiter whose caller aborts leaves the queue and
// rejects with the caller's reason.
export class Bulkhead implements Policy {
  private readonly maxConcurrent: number;
  private readonly maxQueue: number;
  private readonly name: string;
  private readonly onEvent: ResilienceEventHandler | undefined;
  private active = 0;
  private readonly queue: Waiter[] = [];

  constructor(options: BulkheadOptions) {
    const maxQueue = options.maxQueue ?? 0;
    if (!Number.isSafeInteger(options.maxConcurrent) || options.maxConcurrent < 1) {
      throw new RangeError("maxConcurrent must be an integer >= 1");
    }
    if (!Number.isSafeInteger(maxQueue) || maxQueue < 0) throw new RangeError("maxQueue must be an integer >= 0");
    this.maxConcurrent = options.maxConcurrent;
    this.maxQueue = maxQueue;
    this.name = options.name ?? "bulkhead";
    this.onEvent = options.onEvent;
  }

  get running(): number {
    return this.active;
  }

  get queued(): number {
    return this.queue.length;
  }

  async execute<T>(operation: Operation<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    if (this.active < this.maxConcurrent) {
      this.active++;
    } else if (this.queue.length < this.maxQueue) {
      await this.waitForSlot(signal); // resolves with the slot already ours
    } else {
      emit(this.onEvent, { type: "bulkhead-rejected", policy: this.name, running: this.active, queued: this.queue.length });
      throw new BulkheadRejectedError(this.maxConcurrent, this.maxQueue);
    }
    try {
      return await operation(signal ?? NEVER);
    } finally {
      this.release();
    }
  }

  private waitForSlot(signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, signal };
      if (signal !== undefined) {
        waiter.onAbort = () => {
          const i = this.queue.indexOf(waiter);
          if (i >= 0) this.queue.splice(i, 1);
          reject(signal.reason);
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.queue.push(waiter);
    });
  }

  private release(): void {
    const next = this.queue.shift();
    if (next === undefined) {
      this.active--;
      return;
    }
    if (next.onAbort !== undefined) next.signal!.removeEventListener("abort", next.onAbort);
    next.resolve(); // the slot passes to the waiter; `active` stays the same
  }
}
