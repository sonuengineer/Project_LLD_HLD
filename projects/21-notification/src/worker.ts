// A worker: claims up to `concurrency` jobs, processes them in parallel, repeats. Run several (in one process or
// many) against the same queue; the leases keep them from doing the same job at the same time.
//
// runOnce() is the unit tests drive with a manual clock; start() / stop() is the loop for a real process: it polls
// every `pollMs` when the queue is empty and goes again at once when it found work. A batch waits for its slowest
// job before the next claim (simple; a slot-based pool would keep all slots busy -- not built).
import type { QueuedNotifier } from "./queued-notifier.js";

export interface WorkerOptions {
  concurrency?: number; // jobs per claim, default 4
  pollMs?: number; // idle wait, default 250 ms
}

export class Worker {
  private readonly concurrency: number;
  private readonly pollMs: number;
  private running = false;
  private loop: Promise<void> | undefined;
  private timer: NodeJS.Timeout | undefined;
  private wake: (() => void) | undefined;

  constructor(
    private readonly notifier: QueuedNotifier,
    options: WorkerOptions = {},
  ) {
    this.concurrency = options.concurrency ?? 4;
    this.pollMs = options.pollMs ?? 250;
    if (!Number.isInteger(this.concurrency) || this.concurrency < 1) throw new RangeError("concurrency must be an integer >= 1");
    if (!Number.isFinite(this.pollMs) || this.pollMs <= 0) throw new RangeError("pollMs must be > 0");
  }

  // Claims once and processes what it got. Resolves with the number of jobs processed.
  async runOnce(): Promise<number> {
    const jobs = this.notifier.claim(this.concurrency);
    await Promise.all(jobs.map((job) => this.notifier.process(job)));
    return jobs.length;
  }

  // Runs until runOnce() finds nothing to do. For tests and scripts: drains everything that is due NOW.
  async drain(maxRounds = 10_000): Promise<number> {
    let total = 0;
    for (let i = 0; i < maxRounds; i++) {
      const n = await this.runOnce();
      if (n === 0) return total;
      total += n;
    }
    throw new Error(`drain: still busy after ${maxRounds} rounds`);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = (async () => {
      while (this.running) {
        const n = await this.runOnce();
        if (n === 0 && this.running) {
          await new Promise<void>((resolve) => {
            this.wake = resolve;
            this.timer = setTimeout(resolve, this.pollMs);
            this.timer.unref(); // an idle worker never keeps the process alive
          });
        }
      }
    })();
  }

  // Stops claiming; resolves when the jobs in progress are done (they are not abandoned).
  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.wake?.();
    await this.loop;
    this.loop = undefined;
  }
}
