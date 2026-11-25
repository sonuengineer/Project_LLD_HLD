// Stage 1: the in-process notifier. One request -> one notification record with one delivery per channel of its
// type; notify() sends right away and resolves when the immediate sends are done. (Stage 2's QueuedNotifier puts the
// sends on a queue instead; both share planner.ts.)
//
// notify() has two halves:
//   1. synchronous: validate, look up type / user / preferences, render every channel's template, plan every channel,
//      store the record and register the idempotency key. Anything that can throw throws HERE, before anything is
//      stored ("an error means nothing happened"). Because this half has no await, two concurrent calls with the same
//      key cannot both get past the key check: JavaScript runs one synchronous block at a time.
//   2. asynchronous: send the pending deliveries ("all": in parallel; "first": in order, stop at the first success).
//
// One runner per record: a record whose sends are in progress is skipped by flushDue() until they finish, so a
// delivery can never be sent by two callers at once and "first" mode never sends two channels.
import { randomUUID } from "node:crypto";
import type { NotificationCatalog } from "./catalog.js";
import { systemClock, type Clock } from "./clock.js";
import { NotificationError } from "./errors.js";
import {
  applyPlan,
  buildRecord,
  checkRequest,
  outboundMessage,
  recordResult,
  replan,
  sendersByChannel,
  sendOnce,
  type PlannerDeps,
} from "./planner.js";
import type { PreferenceStore } from "./preferences.js";
import { markRestNotNeeded, type Delivery, type NotificationRecord, type NotifyRequest } from "./record.js";
import type { ChannelSender } from "./senders.js";
import type { UserDirectory } from "./users.js";

export {
  notificationStatus,
  type Delivery,
  type NotificationRecord,
  type NotificationStatus,
  type NotifyRequest,
} from "./record.js";

export interface NotifierOptions {
  catalog: NotificationCatalog;
  users: UserDirectory;
  preferences: PreferenceStore;
  senders: ChannelSender[];
  clock?: Clock;
  newId?: () => string;
}

interface KeyEntry {
  fingerprint: string;
  recordId: string;
  done: Promise<void>;
}

export class Notifier {
  private readonly deps: PlannerDeps;
  private readonly clock: Clock;
  private readonly newId: () => string;
  private readonly records = new Map<string, NotificationRecord>();
  private readonly keys = new Map<string, KeyEntry>();
  private readonly running = new Set<string>(); // record ids with sends in progress

  constructor(options: NotifierOptions) {
    this.deps = {
      catalog: options.catalog,
      users: options.users,
      preferences: options.preferences,
      senders: sendersByChannel(options.senders),
    };
    this.clock = options.clock ?? systemClock;
    this.newId = options.newId ?? (() => randomUUID());
  }

  // Resolves when this request's immediate sends are done (deferred deliveries wait for flushDue). A duplicate of an
  // earlier request resolves with the SAME record, after the original's sends finish, and sends nothing.
  async notify(request: NotifyRequest): Promise<NotificationRecord> {
    const entry = this.accept(request); // synchronous: throws before anything is stored
    await entry.done;
    return this.get(entry.recordId)!;
  }

  private accept(request: NotifyRequest): KeyEntry {
    const { key, fingerprint } = checkRequest(request);
    const existing = this.keys.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new NotificationError("IDEMPOTENCY_CONFLICT", `idempotency key ${key} was used for a different request`);
      }
      return existing;
    }
    const record = buildRecord(this.deps, request, key, this.newId(), this.clock.now());
    // Nothing above changed any state. From here on, nothing throws.
    this.records.set(record.id, record);
    const entry: KeyEntry = { fingerprint, recordId: record.id, done: Promise.resolve() };
    this.keys.set(key, entry);
    entry.done = this.run(record, (d) => d.status === "pending").then(() => undefined);
    return entry;
  }

  // Sends the deferred deliveries that have come due. Records with sends in progress are left for the next call.
  // Resolves with the number of deliveries attempted.
  //
  // A due delivery is PLANNED AGAIN before it is sent: hours or days may have passed (a late flush can land in the
  // NEXT night's quiet hours), and the user may have muted the channel or removed the address meanwhile. So it may
  // be sent, deferred again, or skipped -- the same rule as at notify time, applied at send time. (Found by the
  // randomized test: a late flush sent a marketing push inside the user's quiet hours.)
  async flushDue(): Promise<number> {
    const now = this.clock.now();
    const due = (d: Delivery) => d.status === "deferred" && d.notBefore !== undefined && d.notBefore <= now;
    const runs: Promise<number>[] = [];
    for (const record of this.records.values()) {
      if (this.running.has(record.id) || !record.deliveries.some(due)) continue;
      const ready = new Set<Delivery>();
      for (const delivery of record.deliveries.filter(due)) {
        applyPlan(delivery, replan(this.deps, record, delivery, now));
        if (delivery.status === "pending") ready.add(delivery);
      }
      if (ready.size > 0) runs.push(this.run(record, (d) => ready.has(d)));
    }
    const counts = await Promise.all(runs);
    return counts.reduce((a, b) => a + b, 0);
  }

  get(id: string): NotificationRecord | undefined {
    const record = this.records.get(id);
    return record ? structuredClone(record) : undefined;
  }

  getByKey(idempotencyKey: string): NotificationRecord | undefined {
    const entry = this.keys.get(idempotencyKey);
    return entry ? this.get(entry.recordId) : undefined;
  }

  list(): NotificationRecord[] {
    return [...this.records.values()].map((r) => structuredClone(r));
  }

  // Returns the number of deliveries attempted.
  private async run(record: NotificationRecord, selected: (d: Delivery) => boolean): Promise<number> {
    this.running.add(record.id);
    let attempted = 0;
    try {
      const chosen = record.deliveries.filter(selected);
      if (record.mode === "all") {
        attempted = chosen.length;
        await Promise.all(chosen.map((d) => this.attempt(record, d)));
        return attempted;
      }
      for (const delivery of chosen) {
        attempted += 1;
        if (await this.attempt(record, delivery)) {
          markRestNotNeeded(record);
          return attempted;
        }
      }
      return attempted;
    } finally {
      this.running.delete(record.id);
    }
  }

  private async attempt(record: NotificationRecord, delivery: Delivery): Promise<boolean> {
    const sender = this.deps.senders.get(delivery.channel)!;
    delivery.status = "sending";
    delivery.attempts += 1;
    delete delivery.notBefore;
    const result = await sendOnce(sender, outboundMessage(record, delivery));
    recordResult(delivery, result);
    return result.status === "sent";
  }
}
