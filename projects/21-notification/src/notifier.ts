// The notifier: one request -> one notification record with one delivery per channel of its type.
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
import { planChannel } from "./policy.js";
import type { PreferenceStore } from "./preferences.js";
import type { ChannelSender } from "./senders.js";
import { renderTemplate } from "./template.js";
import type {
  Category,
  Channel,
  DeliveryMode,
  DeliveryStatus,
  OutboundMessage,
  SendResult,
  SkipReason,
} from "./types.js";
import type { UserDirectory } from "./users.js";

export interface NotifyRequest {
  typeId: string;
  userId: string;
  data: Record<string, unknown>;
  idempotencyKey: string; // the caller's id for THIS request; a retry of the same request sends the same key
}

export interface Delivery {
  channel: Channel;
  status: DeliveryStatus;
  to?: string; // absent when skipped for no_address
  subject?: string;
  body: string;
  attempts: number;
  notBefore?: number; // deferred: not before this epoch ms
  skipReason?: SkipReason;
  providerId?: string; // sent
  error?: string; // failed
  retryable?: boolean; // failed
}

export type NotificationStatus = "in_progress" | "scheduled" | "delivered" | "failed" | "suppressed";

export interface NotificationRecord {
  id: string;
  idempotencyKey: string;
  typeId: string;
  userId: string;
  category: Category;
  mode: DeliveryMode;
  createdAt: number;
  deliveries: Delivery[];
}

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

const MAX_KEY_LENGTH = 255;

// in_progress > scheduled > delivered > failed > suppressed
export function notificationStatus(record: NotificationRecord): NotificationStatus {
  const statuses = record.deliveries.map((d) => d.status);
  if (statuses.some((s) => s === "pending" || s === "sending")) return "in_progress";
  if (statuses.includes("deferred")) return "scheduled";
  if (statuses.includes("sent")) return "delivered";
  if (statuses.includes("failed")) return "failed";
  return "suppressed";
}

// Key order must not matter: {a:1,b:2} and {b:2,a:1} are the same request.
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isSendResult(value: unknown): value is SendResult {
  if (value === null || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  if (r.status === "sent") return typeof r.providerId === "string";
  if (r.status === "failed") return typeof r.retryable === "boolean" && typeof r.reason === "string";
  return false;
}

export class Notifier {
  private readonly catalog: NotificationCatalog;
  private readonly users: UserDirectory;
  private readonly preferences: PreferenceStore;
  private readonly senders = new Map<Channel, ChannelSender>();
  private readonly clock: Clock;
  private readonly newId: () => string;
  private readonly records = new Map<string, NotificationRecord>();
  private readonly keys = new Map<string, KeyEntry>();
  private readonly running = new Set<string>(); // record ids with sends in progress

  constructor(options: NotifierOptions) {
    this.catalog = options.catalog;
    this.users = options.users;
    this.preferences = options.preferences;
    this.clock = options.clock ?? systemClock;
    this.newId = options.newId ?? (() => randomUUID());
    for (const sender of options.senders) {
      if (this.senders.has(sender.channel)) {
        throw new NotificationError("INVALID_REQUEST", `two senders for channel ${sender.channel}`);
      }
      this.senders.set(sender.channel, sender);
    }
  }

  // Resolves when this request's immediate sends are done (deferred deliveries wait for flushDue). A duplicate of an
  // earlier request resolves with the SAME record, after the original's sends finish, and sends nothing.
  async notify(request: NotifyRequest): Promise<NotificationRecord> {
    const entry = this.accept(request); // synchronous: throws before anything is stored
    await entry.done;
    return this.get(entry.recordId)!;
  }

  private accept(request: NotifyRequest): KeyEntry {
    const key = request?.idempotencyKey;
    if (typeof key !== "string" || key.trim() === "" || key.length > MAX_KEY_LENGTH) {
      throw new NotificationError("INVALID_REQUEST", `idempotencyKey must be a non-empty string of at most ${MAX_KEY_LENGTH} characters`);
    }
    if (!isPlainObject(request.data)) throw new NotificationError("INVALID_REQUEST", "data must be a plain object");
    const fingerprint = stableStringify({ typeId: request.typeId, userId: request.userId, data: request.data });
    const existing = this.keys.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new NotificationError("IDEMPOTENCY_CONFLICT", `idempotency key ${key} was used for a different request`);
      }
      return existing;
    }

    const type = this.catalog.get(request.typeId);
    if (!type) throw new NotificationError("UNKNOWN_TYPE", `no notification type ${String(request.typeId)}`);
    const recipient = this.users.get(request.userId);
    if (!recipient) throw new NotificationError("UNKNOWN_USER", `no user ${String(request.userId)}`);
    const prefs = this.preferences.get(request.userId);
    const now = this.clock.now();

    // Every channel of the type is rendered and must have a sender, even one this user will skip: whether a request
    // is valid must not depend on who the user is or what time it is.
    const deliveries: Delivery[] = type.channels.map((channel) => {
      if (!this.senders.has(channel)) throw new NotificationError("NO_SENDER", `no sender for channel ${channel}`);
      const rendered = renderTemplate(type.templates[channel]!, request.data, channel === "email");
      const plan = planChannel(type.category, channel, recipient, prefs, now);
      const delivery: Delivery = { channel, status: plan.status, body: rendered.body, attempts: 0 };
      if (rendered.subject !== undefined) delivery.subject = rendered.subject;
      if (plan.status === "skipped") delivery.skipReason = plan.reason;
      else delivery.to = plan.to;
      if (plan.status === "deferred") delivery.notBefore = plan.notBefore;
      return delivery;
    });

    // Nothing above changed any state. From here on, nothing throws.
    const record: NotificationRecord = {
      id: this.newId(),
      idempotencyKey: key,
      typeId: type.id,
      userId: request.userId,
      category: type.category,
      mode: type.mode,
      createdAt: now,
      deliveries,
    };
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
      const recipient = this.users.get(record.userId);
      const prefs = this.preferences.get(record.userId);
      const ready = new Set<Delivery>();
      for (const delivery of record.deliveries.filter(due)) {
        const plan = recipient
          ? planChannel(record.category, delivery.channel, recipient, prefs, now)
          : ({ status: "skipped", reason: "no_address" } as const); // the user is gone
        if (plan.status === "skipped") {
          delivery.status = "skipped";
          delivery.skipReason = plan.reason;
          delete delivery.notBefore;
          delete delivery.to;
        } else {
          delivery.to = plan.to; // the CURRENT address
          if (plan.status === "deferred") delivery.notBefore = plan.notBefore;
          else ready.add(delivery);
        }
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
          // Delivered: every channel still waiting is no longer needed.
          for (const other of record.deliveries) {
            if (other.status === "pending" || other.status === "deferred") {
              other.status = "skipped";
              other.skipReason = "not_needed";
              delete other.notBefore;
            }
          }
          return attempted;
        }
      }
      return attempted;
    } finally {
      this.running.delete(record.id);
    }
  }

  private async attempt(record: NotificationRecord, delivery: Delivery): Promise<boolean> {
    const sender = this.senders.get(delivery.channel)!;
    delivery.status = "sending";
    delivery.attempts += 1;
    delete delivery.notBefore;
    const message: OutboundMessage = {
      notificationId: record.id,
      channel: delivery.channel,
      to: delivery.to!,
      body: delivery.body,
      ...(delivery.subject !== undefined ? { subject: delivery.subject } : {}),
    };
    let result: SendResult;
    try {
      const answer: unknown = await sender.send(message);
      result = isSendResult(answer)
        ? answer
        : { status: "failed", retryable: true, reason: "sender returned an invalid result" };
    } catch (error) {
      result = { status: "failed", retryable: true, reason: `sender threw: ${(error as Error)?.message ?? String(error)}` };
    }
    if (result.status === "sent") {
      delivery.status = "sent";
      delivery.providerId = result.providerId;
      return true;
    }
    delivery.status = "failed";
    delivery.error = result.reason;
    delivery.retryable = result.retryable;
    return false;
  }
}
