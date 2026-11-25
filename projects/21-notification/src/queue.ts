// A job queue with priorities, delayed jobs and LEASES -- the shape of SQS (visibility timeout), BullMQ (lock) or a
// Postgres table claimed with FOR UPDATE SKIP LOCKED.
//
// claim() gives a job to one worker for `leaseMs`. Only the holder of the current lease token may complete or
// reschedule it. If the worker dies (or stalls past the lease), the job becomes visible again and another worker
// gets it: delivery is AT-LEAST-ONCE. The old worker's late complete() is refused, so it cannot delete the job the
// new owner is working on.
//
// In memory, one process; claim() scans every job (O(n)). A real deployment uses a broker or a table; the interface
// is what the notifier depends on.
import type { Channel } from "./types.js";

export interface Job {
  id: string;
  recordId: string;
  channel: Channel;
  priority: number; // lower runs first (0 = transactional, 1 = marketing)
  runAt: number; // not claimed before this epoch ms
}

export interface ClaimedJob extends Job {
  leaseToken: number;
  leaseUntil: number;
  claims: number; // how many times this job was claimed (> 1: a previous worker lost its lease)
}

export interface JobQueue {
  enqueue(job: Omit<Job, "id">): string;
  claim(now: number, max: number, leaseMs: number): ClaimedJob[];
  owns(id: string, leaseToken: number, now: number): boolean;
  complete(id: string, leaseToken: number, now: number): boolean;
  reschedule(id: string, leaseToken: number, runAt: number, now: number): boolean;
}

interface Entry {
  job: Job;
  seq: number;
  leaseToken?: number;
  leaseUntil?: number;
  claims: number;
}

export class InMemoryJobQueue implements JobQueue {
  private readonly entries = new Map<string, Entry>();
  private seq = 0;
  private tokens = 0;
  private nextId = 0;
  readonly stats = { enqueued: 0, claimed: 0, reclaimed: 0, completed: 0, rescheduled: 0, refused: 0 };

  enqueue(job: Omit<Job, "id">): string {
    const id = `job-${++this.nextId}`;
    this.entries.set(id, { job: { ...job, id }, seq: ++this.seq, claims: 0 });
    this.stats.enqueued++;
    return id;
  }

  // Ready = runAt reached and not leased (or the lease has run out). Order: priority, then runAt, then FIFO.
  claim(now: number, max: number, leaseMs: number): ClaimedJob[] {
    if (!Number.isInteger(max) || max < 1) throw new RangeError("max must be an integer >= 1");
    if (!Number.isFinite(leaseMs) || leaseMs <= 0) throw new RangeError("leaseMs must be > 0");
    const ready = [...this.entries.values()]
      .filter((e) => e.job.runAt <= now && (e.leaseUntil === undefined || e.leaseUntil <= now))
      .sort((a, b) => a.job.priority - b.job.priority || a.job.runAt - b.job.runAt || a.seq - b.seq)
      .slice(0, max);
    return ready.map((e) => {
      if (e.claims > 0) this.stats.reclaimed++;
      e.claims++;
      e.leaseToken = ++this.tokens;
      e.leaseUntil = now + leaseMs;
      this.stats.claimed++;
      return { ...e.job, leaseToken: e.leaseToken, leaseUntil: e.leaseUntil, claims: e.claims };
    });
  }

  // The caller still holds the job: same token and the lease has not run out.
  owns(id: string, leaseToken: number, now: number): boolean {
    const e = this.entries.get(id);
    return e !== undefined && e.leaseToken === leaseToken && e.leaseUntil !== undefined && e.leaseUntil > now;
  }

  complete(id: string, leaseToken: number, now: number): boolean {
    if (!this.owns(id, leaseToken, now)) return this.refuse();
    this.entries.delete(id);
    this.stats.completed++;
    return true;
  }

  // Back in the queue for runAt (a retry, or a delivery deferred again), lease released.
  reschedule(id: string, leaseToken: number, runAt: number, now: number): boolean {
    if (!this.owns(id, leaseToken, now)) return this.refuse();
    const e = this.entries.get(id)!;
    e.job.runAt = runAt;
    delete e.leaseToken;
    delete e.leaseUntil;
    this.stats.rescheduled++;
    return true;
  }

  get size(): number {
    return this.entries.size;
  }

  // Snapshot for tests and dashboards.
  jobs(): (Job & { leaseUntil?: number; claims: number })[] {
    return [...this.entries.values()].map((e) => ({
      ...e.job,
      claims: e.claims,
      ...(e.leaseUntil !== undefined ? { leaseUntil: e.leaseUntil } : {}),
    }));
  }

  private refuse(): false {
    this.stats.refused++;
    return false;
  }
}
