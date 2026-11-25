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
  pushTokens?: string[]; // one per device (app install); several devices = several tokens (stage 3)
  utcOffsetMinutes?: number; // the user's local time = UTC + offset (fixed; DST not handled). Default 0.
}

// What a sender receives: already rendered, already addressed.
export interface OutboundMessage {
  notificationId: string;
  channel: Channel;
  to: string; // email address, phone number or push token
  idempotencyKey: string; // "<notificationId>:<channel>" (push: "<notificationId>:push:<token>"), the same on every
  // attempt to that address: lets a provider drop a duplicate
  subject?: string; // email only
  body: string;
}

export type SendResult =
  | { status: "sent"; providerId: string }
  // invalidAddress: the address will never work again (an uninstalled app: FCM UNREGISTERED, APNs 410). Push tokens
  // reported this way are removed from the user (stage 3).
  | { status: "failed"; retryable: boolean; reason: string; invalidAddress?: boolean };

export type DeliveryStatus = "pending" | "sending" | "sent" | "failed" | "skipped" | "deferred";

// capped: stage 2's per-user frequency cap for marketing was reached.
export type SkipReason = "no_address" | "opted_out" | "not_needed" | "capped";

export function isChannel(value: unknown): value is Channel {
  return typeof value === "string" && (CHANNELS as readonly string[]).includes(value);
}

export function isCategory(value: unknown): value is Category {
  return typeof value === "string" && (CATEGORIES as readonly string[]).includes(value);
}

// Every address the channel can reach: one email or phone, or each of the user's push tokens. Blank ones do not
// count; duplicates are dropped.
export function addressesFor(recipient: Recipient, channel: Channel): string[] {
  const values = channel === "email" ? [recipient.email] : channel === "sms" ? [recipient.phone] : (recipient.pushTokens ?? []);
  return [...new Set(values.filter((v): v is string => typeof v === "string" && v.trim() !== ""))];
}

export function addressFor(recipient: Recipient, channel: Channel): string | undefined {
  return addressesFor(recipient, channel)[0];
}
