// The part of notify() that both notifiers share: validate a request, render every channel, plan every channel, and
// build the record -- all without changing any state, so an error means nothing happened. Plus the one way a
// delivery is handed to a sender.
import type { NotificationCatalog } from "./catalog.js";
import { NotificationError } from "./errors.js";
import { planChannel, type ChannelPlan } from "./policy.js";
import type { PreferenceStore } from "./preferences.js";
import type { Delivery, NotificationRecord, NotifyRequest } from "./record.js";
import type { ChannelSender } from "./senders.js";
import { renderTemplate } from "./template.js";
import type { Channel, OutboundMessage, SendResult } from "./types.js";
import type { UserDirectory } from "./users.js";

export const MAX_KEY_LENGTH = 255;

export interface PlannerDeps {
  catalog: NotificationCatalog;
  users: UserDirectory;
  preferences: PreferenceStore;
  senders: ReadonlyMap<Channel, ChannelSender>;
}

export function sendersByChannel(senders: ChannelSender[]): Map<Channel, ChannelSender> {
  const map = new Map<Channel, ChannelSender>();
  for (const sender of senders) {
    if (map.has(sender.channel)) throw new NotificationError("INVALID_REQUEST", `two senders for channel ${sender.channel}`);
    map.set(sender.channel, sender);
  }
  return map;
}

// Key order must not matter: {a:1,b:2} and {b:2,a:1} are the same request.
export function stableStringify(value: unknown): string {
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

// The cheap checks, done before the idempotency lookup. Returns the key and the request's fingerprint.
export function checkRequest(request: NotifyRequest): { key: string; fingerprint: string } {
  const key = request?.idempotencyKey;
  if (typeof key !== "string" || key.trim() === "" || key.length > MAX_KEY_LENGTH) {
    throw new NotificationError("INVALID_REQUEST", `idempotencyKey must be a non-empty string of at most ${MAX_KEY_LENGTH} characters`);
  }
  if (!isPlainObject(request.data)) throw new NotificationError("INVALID_REQUEST", "data must be a plain object");
  return { key, fingerprint: stableStringify({ typeId: request.typeId, userId: request.userId, data: request.data }) };
}

export function applyPlan(delivery: Delivery, plan: ChannelPlan): void {
  delivery.status = plan.status;
  delete delivery.notBefore;
  if (plan.status !== "pending") delete delivery.nextAttemptAt;
  if (plan.status === "skipped") {
    delivery.skipReason = plan.reason;
    delete delivery.to;
  } else {
    delivery.to = plan.to; // the CURRENT address
    if (plan.status === "deferred") delivery.notBefore = plan.notBefore;
  }
}

// Everything that can throw for a new request. Returns a record that is not stored anywhere yet.
export function buildRecord(deps: PlannerDeps, request: NotifyRequest, key: string, id: string, now: number): NotificationRecord {
  const type = deps.catalog.get(request.typeId);
  if (!type) throw new NotificationError("UNKNOWN_TYPE", `no notification type ${String(request.typeId)}`);
  const recipient = deps.users.get(request.userId);
  if (!recipient) throw new NotificationError("UNKNOWN_USER", `no user ${String(request.userId)}`);
  const prefs = deps.preferences.get(request.userId);

  // Every channel of the type is rendered and must have a sender, even one this user will skip: whether a request
  // is valid must not depend on who the user is or what time it is.
  const deliveries: Delivery[] = type.channels.map((channel) => {
    if (!deps.senders.has(channel)) throw new NotificationError("NO_SENDER", `no sender for channel ${channel}`);
    const rendered = renderTemplate(type.templates[channel]!, request.data, channel === "email");
    const delivery: Delivery = { channel, status: "pending", body: rendered.body, attempts: 0 };
    if (rendered.subject !== undefined) delivery.subject = rendered.subject;
    applyPlan(delivery, planChannel(type.category, channel, recipient, prefs, now));
    return delivery;
  });
  return {
    id,
    idempotencyKey: key,
    typeId: type.id,
    userId: request.userId,
    category: type.category,
    mode: type.mode,
    createdAt: now,
    deliveries,
  };
}

// The rule applied again at send time (a deferred or retried delivery may be sent much later than it was planned).
export function replan(deps: PlannerDeps, record: NotificationRecord, delivery: Delivery, now: number): ChannelPlan {
  const recipient = deps.users.get(record.userId);
  if (!recipient) return { status: "skipped", reason: "no_address" }; // the user is gone
  return planChannel(record.category, delivery.channel, recipient, deps.preferences.get(record.userId), now);
}

export function outboundMessage(record: NotificationRecord, delivery: Delivery): OutboundMessage {
  return {
    notificationId: record.id,
    channel: delivery.channel,
    to: delivery.to!,
    // The same for every attempt of this delivery, so a provider that supports idempotency keys drops a duplicate
    // (stage 2's queue is at-least-once: a worker that lost its lease may have sent already).
    idempotencyKey: `${record.id}:${delivery.channel}`,
    body: delivery.body,
    ...(delivery.subject !== undefined ? { subject: delivery.subject } : {}),
  };
}

function isSendResult(value: unknown): value is SendResult {
  if (value === null || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  if (r.status === "sent") return typeof r.providerId === "string";
  if (r.status === "failed") return typeof r.retryable === "boolean" && typeof r.reason === "string";
  return false;
}

// A sender that throws or returns garbage is a retryable failure: the outcome is unknown, not a crash.
export async function sendOnce(sender: ChannelSender, message: OutboundMessage, signal?: AbortSignal): Promise<SendResult> {
  try {
    const answer: unknown = await sender.send(message, signal);
    return isSendResult(answer) ? answer : { status: "failed", retryable: true, reason: "sender returned an invalid result" };
  } catch (error) {
    return { status: "failed", retryable: true, reason: `sender threw: ${(error as Error)?.message ?? String(error)}` };
  }
}

export function recordResult(delivery: Delivery, result: SendResult): void {
  delete delivery.nextAttemptAt;
  if (result.status === "sent") {
    delivery.status = "sent";
    delivery.providerId = result.providerId;
    delete delivery.error;
    delete delivery.retryable;
    return;
  }
  delivery.status = "failed";
  delivery.error = result.reason;
  delivery.retryable = result.retryable;
}
