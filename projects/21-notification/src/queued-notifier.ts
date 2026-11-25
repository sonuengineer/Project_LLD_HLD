// Stage 2: notify() plans the notification and QUEUES its sends; workers (worker.ts) do them. notify() returns at
// once -- an HTTP layer answers 202 Accepted -- and a slow or failing provider no longer holds up the caller.
//
// What happens to one job (one delivery of one notification), in process():
//   1. The record says the delivery is already finished (a redelivered job after a crash) -> drop the job.
//   2. Plan the channel AGAIN (stage 1's lesson: time, preferences and addresses change while a job waits):
//      skipped -> done; deferred (quiet hours) -> back in the queue for the end of the window; pending -> go on.
//   3. Marketing, first try: the per-user, per-channel frequency cap (ratelimit-kit). Over the cap -> skipped
//      (capped). Not deferred: a backlog of old promotions delivered later is worse than none.
//   4. Send through the channel's circuit breaker and a timeout (resilience-kit):
//      sent                               -> done ("first": the other channels are not_needed)
//      permanent failure                  -> failed ("first": the next channel gets a job)
//      retryable failure / timeout / throw -> attempts left: back in the queue after a backoff (exponentialBackoff);
//                                            none left: failed ("first": next channel)
//      circuit open (provider calls refused) -> "first": fail over to the next channel now (that is what "first"
//                                            is for: an OTP must not wait 30 s for a dead push provider);
//                                            "all": back in the queue when the breaker lets a probe through, without
//                                            using up an attempt (no provider call was made).
//   5. Results are written only while the worker still holds the job's lease. A worker that stalled past its lease
//      (the job went to another worker) has its result dropped.
//
// "first" mode keeps ONE job per record at a time: the next channel's job is queued only when the current channel
// has finished. "all" mode queues one job per channel at once (they run in parallel on different workers).
import { randomUUID } from "node:crypto";
import { LruCache } from "cache-kit";
import { BrokenCircuitError, CircuitBreaker, exponentialBackoff, TimeoutError, TimeoutPolicy, type Backoff, type CircuitBreakerOptions } from "resilience-kit";
import type { Decision } from "ratelimit-kit";
import type { NotificationCatalog } from "./catalog.js";
import { systemClock, type Clock } from "./clock.js";
import { NotificationError } from "./errors.js";
import {
  applyPlan,
  buildRecord,
  checkRequest,
  recordResult,
  replan,
  sendersByChannel,
  sendOnce,
  sendToAddresses,
  type CallResult,
  type PlannerDeps,
} from "./planner.js";
import type { PreferenceStore } from "./preferences.js";
import type { ClaimedJob, JobQueue } from "./queue.js";
import { mergeReceipt, type Receipt } from "./receipts.js";
import { markRestNotNeeded, type Delivery, type NotificationRecord, type NotifyRequest } from "./record.js";
import type { ChannelSender } from "./senders.js";
import type { Channel, OutboundMessage, SendResult } from "./types.js";
import type { UserDirectory } from "./users.js";

export const PRIORITY = { transactional: 0, marketing: 1 } as const;

export interface QueuedNotifierOptions {
  catalog: NotificationCatalog;
  users: UserDirectory;
  preferences: PreferenceStore;
  senders: ChannelSender[];
  queue: JobQueue;
  clock?: Clock;
  newId?: () => string;
  random?: () => number; // backoff jitter; tests pass a fixed one
  sendTimeoutMs?: number; // per provider call, default 10 s
  leaseMs?: number; // how long a worker holds a job, default 60 s; must be > sendTimeoutMs
  retry?: { maxAttempts?: number; backoff?: Backoff }; // default 3 attempts, 1 s x2 up to 5 min, full jitter
  breaker?: Omit<CircuitBreakerOptions, "now">; // one breaker per channel with these options
  // Marketing only, keyed "<userId>:<channel>". A RateLimiter from ratelimit-kit (memory or Redis store).
  frequencyCap?: { consume(key: string): Promise<Decision> };
  idempotency?: { ttlMs?: number; maxEntries?: number }; // default 24 h, 100_000 keys
  // Stage 3: receipts that arrive before the send is recorded are parked this long (default 1 h, 10_000 entries).
  receipts?: { parkTtlMs?: number; parkMaxEntries?: number };
}

export type ReceiptOutcome = "applied" | "unchanged" | "parked";

interface KeyEntry {
  fingerprint: string;
  recordId: string;
}

// A retryable provider failure, thrown inside the breaker so the breaker counts it. A permanent one (bad number,
// unsubscribed address) is the provider working correctly: returned, not counted.
class ProviderFailure extends Error {
  constructor(readonly result: SendResult & { status: "failed" }) {
    super(result.reason);
  }
}

export class QueuedNotifier {
  private readonly deps: PlannerDeps;
  private readonly queue: JobQueue;
  private readonly clock: Clock;
  private readonly newId: () => string;
  private readonly random: () => number;
  private readonly leaseMs: number;
  private readonly maxAttempts: number;
  private readonly backoff: Backoff;
  private readonly timeout: TimeoutPolicy;
  private readonly breakers = new Map<Channel, CircuitBreaker>();
  private readonly frequencyCap?: QueuedNotifierOptions["frequencyCap"];
  private readonly records = new Map<string, NotificationRecord>();
  private readonly keys: LruCache<string, KeyEntry>;
  private readonly admitted = new Set<string>(); // "<recordId>:<channel>" that passed the frequency cap
  private readonly sentBy = new Map<string, string>(); // "<channel>:<providerId>" -> record id (grows like records)
  private readonly parked: LruCache<string, Receipt>; // "<channel>:<providerId>" -> merged receipt, send not seen yet
  readonly stats = { sent: 0, failed: 0, retried: 0, capped: 0, failedOver: 0, leaseLost: 0, duplicateJobs: 0, unexpectedErrors: 0, receiptsApplied: 0, receiptsUnchanged: 0, receiptsParked: 0 };

  constructor(options: QueuedNotifierOptions) {
    this.deps = {
      catalog: options.catalog,
      users: options.users,
      preferences: options.preferences,
      senders: sendersByChannel(options.senders),
    };
    this.queue = options.queue;
    this.clock = options.clock ?? systemClock;
    this.newId = options.newId ?? (() => randomUUID());
    this.random = options.random ?? Math.random;
    const sendTimeoutMs = options.sendTimeoutMs ?? 10_000;
    this.leaseMs = options.leaseMs ?? 60_000;
    // A worker must finish (or time out) well inside its lease, or a healthy but slow send would be handed to a
    // second worker and sent twice.
    if (!(this.leaseMs > sendTimeoutMs)) {
      throw new NotificationError("INVALID_REQUEST", "leaseMs must be greater than sendTimeoutMs");
    }
    this.timeout = new TimeoutPolicy({ ms: sendTimeoutMs });
    this.maxAttempts = options.retry?.maxAttempts ?? 3;
    if (!Number.isInteger(this.maxAttempts) || this.maxAttempts < 1) {
      throw new NotificationError("INVALID_REQUEST", "retry.maxAttempts must be an integer >= 1");
    }
    this.backoff = options.retry?.backoff ?? exponentialBackoff({ initialMs: 1_000, maxMs: 300_000 });
    for (const channel of this.deps.senders.keys()) {
      this.breakers.set(channel, new CircuitBreaker({ ...options.breaker, now: () => this.clock.now() }));
    }
    this.frequencyCap = options.frequencyCap;
    this.keys = new LruCache<string, KeyEntry>({
      maxEntries: options.idempotency?.maxEntries ?? 100_000,
      ttlMs: options.idempotency?.ttlMs ?? 24 * 60 * 60 * 1000,
      now: () => this.clock.now(),
    });
    this.parked = new LruCache<string, Receipt>({
      maxEntries: options.receipts?.parkMaxEntries ?? 10_000,
      ttlMs: options.receipts?.parkTtlMs ?? 60 * 60 * 1000,
      now: () => this.clock.now(),
    });
  }

  // A provider's report on a message it accepted. Synchronous, like notify(). Provider ids are only unique per
  // provider, so the channel is part of the key.
  //   applied   -- the delivery's receipt changed
  //   unchanged -- a duplicate, or outranked by what is already there (out of order): nothing to do, still a success
  //   parked    -- no send with this id yet (the webhook beat the send result): kept, applied when the send is recorded
  applyReceipt(channel: Channel, providerId: string, receipt: Receipt): ReceiptOutcome {
    const key = `${channel}:${providerId}`;
    const recordId = this.sentBy.get(key);
    const delivery = recordId === undefined ? undefined : this.records.get(recordId)?.deliveries.find((d) => d.channel === channel);
    if (!delivery) {
      this.parked.set(key, mergeReceipt(this.parked.get(key), receipt));
      this.stats.receiptsParked++;
      return "parked";
    }
    const merged = mergeReceipt(delivery.receipt, receipt);
    if (merged === delivery.receipt) {
      this.stats.receiptsUnchanged++;
      return "unchanged";
    }
    delivery.receipt = merged;
    this.stats.receiptsApplied++;
    return "applied";
  }

  // Synchronous: validates, stores the record, queues the jobs, returns the record (status in_progress / scheduled /
  // suppressed). Throws before anything is stored. A duplicate within the key's TTL returns the existing record.
  notify(request: NotifyRequest): NotificationRecord {
    const { key, fingerprint } = checkRequest(request);
    const existing = this.keys.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new NotificationError("IDEMPOTENCY_CONFLICT", `idempotency key ${key} was used for a different request`);
      }
      return this.get(existing.recordId)!;
    }
    const now = this.clock.now();
    const record = buildRecord(this.deps, request, key, this.newId(), now);
    // Nothing above changed any state. From here on, nothing throws.
    this.records.set(record.id, record);
    this.keys.set(key, { fingerprint, recordId: record.id });
    if (record.mode === "all") {
      for (const d of record.deliveries) {
        if (d.status === "pending") this.enqueue(record, d, now);
        else if (d.status === "deferred") this.enqueue(record, d, d.notBefore!);
      }
    } else {
      this.queueNextCandidate(record, now);
    }
    return structuredClone(record);
  }

  claim(max: number): ClaimedJob[] {
    return this.queue.claim(this.clock.now(), max, this.leaseMs);
  }

  // Never throws (a worker loop must survive any job): an unexpected error leaves the job leased, and when the lease
  // runs out another worker picks it up -- the same path as a crashed worker.
  async process(job: ClaimedJob): Promise<void> {
    try {
      await this.processJob(job);
    } catch {
      this.stats.unexpectedErrors++;
    }
  }

  get(id: string): NotificationRecord | undefined {
    const record = this.records.get(id);
    return record ? structuredClone(record) : undefined;
  }

  getByKey(idempotencyKey: string): NotificationRecord | undefined {
    const entry = this.keys.peek(idempotencyKey);
    return entry ? this.get(entry.recordId) : undefined;
  }

  list(): NotificationRecord[] {
    return [...this.records.values()].map((r) => structuredClone(r));
  }

  breakerState(channel: Channel): string | undefined {
    return this.breakers.get(channel)?.state;
  }

  private enqueue(record: NotificationRecord, delivery: Delivery, runAt: number): void {
    this.queue.enqueue({ recordId: record.id, channel: delivery.channel, priority: PRIORITY[record.category], runAt });
  }

  // "first" mode: the next channel to try is the first pending one in order (it can go now), else the first deferred
  // one (at the end of the quiet hours). Nothing is queued once a channel has been sent.
  private queueNextCandidate(record: NotificationRecord, now: number): void {
    if (record.mode !== "first" || record.deliveries.some((d) => d.status === "sent")) return;
    const next =
      record.deliveries.find((d) => d.status === "pending") ?? record.deliveries.find((d) => d.status === "deferred");
    if (next) this.enqueue(record, next, next.status === "deferred" ? next.notBefore! : now);
  }

  private finish(job: ClaimedJob, record: NotificationRecord, now: number): void {
    if (this.queue.complete(job.id, job.leaseToken, now)) this.queueNextCandidate(record, now);
  }

  private async processJob(job: ClaimedJob): Promise<void> {
    let now = this.clock.now();
    const record = this.records.get(job.recordId);
    const delivery = record?.deliveries.find((d) => d.channel === job.channel);
    if (!record || !delivery || !(delivery.status === "pending" || delivery.status === "deferred" || delivery.status === "sending")) {
      // Finished already: a job redelivered after a worker died between writing the result and completing the job.
      this.stats.duplicateJobs++;
      this.queue.complete(job.id, job.leaseToken, now);
      return;
    }

    const plan = replan(this.deps, record, delivery, now);
    if (plan.status !== "pending") {
      applyPlan(delivery, plan);
      if (plan.status === "deferred") this.queue.reschedule(job.id, job.leaseToken, plan.notBefore, now);
      else this.finish(job, record, now);
      return;
    }
    applyPlan(delivery, plan);

    const admitKey = `${record.id}:${delivery.channel}`;
    if (record.category === "marketing" && this.frequencyCap && !this.admitted.has(admitKey)) {
      let decision: Decision;
      try {
        decision = await this.frequencyCap.consume(`${record.userId}:${delivery.channel}`);
      } catch {
        // The cap's store is down: neither send uncapped nor drop -- try again later, no attempt used.
        now = this.clock.now();
        if (!this.queue.owns(job.id, job.leaseToken, now)) return this.lostLease();
        delivery.error = "frequency cap unavailable";
        this.retryLater(job, delivery, now + this.backoff.delayMs(1, this.random), now);
        return;
      }
      now = this.clock.now();
      if (!this.queue.owns(job.id, job.leaseToken, now)) return this.lostLease();
      if (!decision.allowed) {
        delivery.status = "skipped";
        delivery.skipReason = "capped";
        this.stats.capped++;
        this.finish(job, record, now);
        return;
      }
      this.admitted.add(admitKey);
    }

    delivery.status = "sending";
    const sender = this.deps.senders.get(delivery.channel)!;
    const breaker = this.breakers.get(delivery.channel)!;
    let reopenInMs = 0;
    // One provider call (one address), through the channel's breaker and a timeout. Several devices = several calls.
    const call = async (message: OutboundMessage): Promise<CallResult> => {
      try {
        return await breaker.execute(() =>
          this.timeout.execute(async (signal) => {
            const answer = await sendOnce(sender, message, signal);
            if (answer.status === "failed" && answer.retryable) throw new ProviderFailure(answer);
            return answer;
          }),
        );
      } catch (error) {
        if (error instanceof ProviderFailure) return error.result;
        if (error instanceof TimeoutError) return { status: "failed", retryable: true, reason: `timed out after ${error.timeoutMs} ms` };
        if (error instanceof BrokenCircuitError) {
          reopenInMs = Math.max(reopenInMs, error.retryAfterMs);
          return "circuit-open";
        }
        return { status: "failed", retryable: true, reason: String(error) };
      }
    };
    const { result, called, sentIds, devices } = await sendToAddresses(this.deps, record, delivery, call);
    if (called) delivery.attempts += 1; // one attempt = one round of provider calls (none if every call was refused)

    now = this.clock.now();
    if (!this.queue.owns(job.id, job.leaseToken, now)) return this.lostLease();
    if (devices) delivery.devices = devices;

    if (result === "circuit-open") {
      if (record.mode === "first") {
        this.stats.failedOver++;
        recordResult(delivery, { status: "failed", retryable: true, reason: "circuit open" });
        this.finish(job, record, now);
      } else {
        delivery.status = "pending";
        delivery.error = "circuit open";
        this.retryLater(job, delivery, now + Math.max(reopenInMs, 1), now);
      }
      return;
    }

    if (result.status === "sent") {
      recordResult(delivery, result);
      this.stats.sent++;
      for (const providerId of sentIds) {
        // Every device that accepted has its own provider id; a receipt for any of them is this delivery's.
        const key = `${delivery.channel}:${providerId}`;
        this.sentBy.set(key, record.id);
        const early = this.parked.get(key);
        if (early) {
          delivery.receipt = mergeReceipt(delivery.receipt, early);
          this.parked.delete(key);
          this.stats.receiptsApplied++;
        }
      }
      if (record.mode === "first") markRestNotNeeded(record);
      this.finish(job, record, now);
      return;
    }
    if (result.retryable && delivery.attempts < this.maxAttempts) {
      delivery.status = "pending";
      delivery.error = result.reason;
      this.stats.retried++;
      this.retryLater(job, delivery, now + this.backoff.delayMs(delivery.attempts, this.random), now);
      return;
    }
    recordResult(delivery, result);
    this.stats.failed++;
    this.finish(job, record, now);
  }

  private retryLater(job: ClaimedJob, delivery: Delivery, runAt: number, now: number): void {
    delivery.status = "pending";
    delivery.nextAttemptAt = runAt;
    this.queue.reschedule(job.id, job.leaseToken, runAt, now);
  }

  private lostLease(): void {
    this.stats.leaseLost++;
  }
}
