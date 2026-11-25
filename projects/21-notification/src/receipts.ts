// Stage 3: delivery receipts. "sent" only means the provider ACCEPTED the message; later the provider calls our
// webhook to say what happened: delivered, or bounced (bad number, mailbox does not exist).
//
// Webhooks arrive late, twice, and out of order. Instead of a store of seen event ids, the receipt state itself is
// built so that order and duplicates cannot matter: a receipt only moves UP a fixed ranking, ties keep the earlier
// time. The final state is the "maximum" of every event received, and a maximum is the same in any order and with
// any number of duplicates.
//
// Ranking: delivered < bounced. An email can be accepted by the receiving server ("delivered") and bounce after;
// a late "delivered" must never undo a bounce.
//
// Signatures (the Stripe scheme): header  Notify-Signature: t=<unix seconds>,v1=<hex>  where hex is
// HMAC-SHA256(secret, "<t>.<raw body>"). Signed over the RAW bytes (parsed and re-serialized JSON would not match),
// and the timestamp is part of what is signed, so a captured request cannot be replayed after the tolerance.
import { createHmac, timingSafeEqual } from "node:crypto";

export const RECEIPT_EVENTS = ["delivered", "bounced"] as const;
export type ReceiptEvent = (typeof RECEIPT_EVENTS)[number];

export interface Receipt {
  event: ReceiptEvent;
  at: number; // when it happened, per the provider (epoch ms)
}

const RANK: Record<ReceiptEvent, number> = { delivered: 1, bounced: 2 };

export function isReceiptEvent(value: unknown): value is ReceiptEvent {
  return typeof value === "string" && (RECEIPT_EVENTS as readonly string[]).includes(value);
}

// The higher rank wins; on a tie the earlier time. Associative, commutative and idempotent -- which is the whole
// point: merge(merge(a, b), c) is the same for every order of a, b, c, and merge(a, a) = a.
export function mergeReceipt(current: Receipt | undefined, incoming: Receipt): Receipt {
  if (!current) return { ...incoming };
  if (RANK[incoming.event] !== RANK[current.event]) return RANK[incoming.event] > RANK[current.event] ? { ...incoming } : current;
  return incoming.at < current.at ? { ...incoming } : current;
}

export const SIGNATURE_HEADER = "notify-signature";
export const DEFAULT_TOLERANCE_MS = 5 * 60_000;

const hmac = (secret: string, timestampSeconds: number, rawBody: string | Buffer) =>
  createHmac("sha256", secret).update(`${timestampSeconds}.`).update(rawBody).digest();

// What the provider does (and what tests and the demo use to act as one).
export function signWebhook(secret: string, rawBody: string | Buffer, nowMs: number): string {
  const t = Math.floor(nowMs / 1000);
  return `t=${t},v1=${hmac(secret, t, rawBody).toString("hex")}`;
}

export function verifyWebhook(
  secret: string,
  header: string | undefined,
  rawBody: Buffer,
  nowMs: number,
  toleranceMs = DEFAULT_TOLERANCE_MS,
): boolean {
  const match = /^t=(\d{1,12}),v1=([0-9a-f]{64})$/.exec(header ?? "");
  if (!match) return false;
  const t = Number(match[1]);
  if (Math.abs(nowMs - t * 1000) > toleranceMs) return false; // too old (a replay) or from the future
  return timingSafeEqual(hmac(secret, t, rawBody), Buffer.from(match[2]!, "hex"));
}
