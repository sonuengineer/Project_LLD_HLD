// The shared vocabulary. Channels and categories are closed lists: adding one is a change here plus a sender.

export const CHANNELS = ["email", "sms", "push"] as const;
export type Channel = (typeof CHANNELS)[number];

export const CATEGORIES = ["transactional", "marketing"] as const;
export type Category = (typeof CATEGORIES)[number];

// "all": every allowed channel. "first": channels in order, stop at the first that succeeds.
export type DeliveryMode = "all" | "first";

export interface Recipient {
  userId: string;
  email?: string;
  phone?: string;
  pushToken?: string;
  utcOffsetMinutes?: number; // the user's local time = UTC + offset (fixed; DST not handled). Default 0.
}

// What a sender receives: already rendered, already addressed.
export interface OutboundMessage {
  notificationId: string;
  channel: Channel;
  to: string; // email address, phone number or push token
  idempotencyKey: string; // "<notificationId>:<channel>", the same on every attempt: lets a provider drop a duplicate
  subject?: string; // email only
  body: string;
}

export type SendResult =
  | { status: "sent"; providerId: string }
  | { status: "failed"; retryable: boolean; reason: string };

export type DeliveryStatus = "pending" | "sending" | "sent" | "failed" | "skipped" | "deferred";

// capped: stage 2's per-user frequency cap for marketing was reached.
export type SkipReason = "no_address" | "opted_out" | "not_needed" | "capped";

export function isChannel(value: unknown): value is Channel {
  return typeof value === "string" && (CHANNELS as readonly string[]).includes(value);
}

export function isCategory(value: unknown): value is Category {
  return typeof value === "string" && (CATEGORIES as readonly string[]).includes(value);
}

export function addressFor(recipient: Recipient, channel: Channel): string | undefined {
  const value = channel === "email" ? recipient.email : channel === "sms" ? recipient.phone : recipient.pushToken;
  return value && value.trim() !== "" ? value : undefined;
}
