// The notification record and its deliveries: shared by the in-process Notifier (stage 1) and the QueuedNotifier
// (stage 2).
import type { Receipt } from "./receipts.js";
import type { Category, Channel, DeliveryMode, DeliveryStatus, SkipReason } from "./types.js";

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
  attempts: number; // provider calls made (a call refused by an open circuit is not one)
  notBefore?: number; // deferred (quiet hours): not before this epoch ms
  nextAttemptAt?: number; // stage 2: pending after a retryable failure, the retry is queued for this time
  skipReason?: SkipReason;
  providerId?: string; // sent
  error?: string; // failed, or the last failure of a delivery waiting for a retry
  retryable?: boolean; // failed
  receipt?: Receipt; // stage 3: what the provider reported after accepting it (sent deliveries only)
  devices?: DeviceResult[]; // stage 3, push only: the last answer for each device token tried
}

export interface DeviceResult {
  token: string;
  status: "sent" | "failed";
  providerId?: string; // sent
  error?: string; // failed
  retryable?: boolean; // failed
  removed?: boolean; // the provider said the token is dead; it was removed from the user
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

// in_progress > scheduled > delivered > failed > suppressed. A sent delivery that BOUNCED counts as failed (stage 3).
export function notificationStatus(record: NotificationRecord): NotificationStatus {
  const statuses = record.deliveries.map((d) => (d.status === "sent" && d.receipt?.event === "bounced" ? "failed" : d.status));
  if (statuses.some((s) => s === "pending" || s === "sending")) return "in_progress";
  if (statuses.includes("deferred")) return "scheduled";
  if (statuses.includes("sent")) return "delivered";
  if (statuses.includes("failed")) return "failed";
  return "suppressed";
}

// "first" mode, after a success: every channel still waiting is no longer needed.
export function markRestNotNeeded(record: NotificationRecord): void {
  for (const other of record.deliveries) {
    if (other.status === "pending" || other.status === "deferred") {
      other.status = "skipped";
      other.skipReason = "not_needed";
      delete other.notBefore;
      delete other.nextAttemptAt;
    }
  }
}
