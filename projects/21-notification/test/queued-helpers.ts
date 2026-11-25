import { exponentialBackoff } from "resilience-kit";
import { NotificationCatalog } from "../src/catalog.js";
import { ManualClock, type Clock } from "../src/clock.js";
import { PreferenceStore } from "../src/preferences.js";
import { InMemoryJobQueue } from "../src/queue.js";
import { QueuedNotifier, type QueuedNotifierOptions } from "../src/queued-notifier.js";
import { FakeSender } from "../src/senders.js";
import type { Recipient } from "../src/types.js";
import { InMemoryUsers } from "../src/users.js";
import { Worker } from "../src/worker.js";
import { FULL_USER, OTP, ORDER, PROMO_FIRST, SALE, T0 } from "./helpers.js";

export function setupQueued(
  options: { users?: Recipient[]; now?: number; queue?: InMemoryJobQueue; concurrency?: number; clock?: Clock } & Partial<
    Omit<QueuedNotifierOptions, "catalog" | "users" | "preferences" | "senders" | "queue" | "clock">
  > = {},
) {
  const manual = new ManualClock(options.now ?? T0);
  const clock = manual;
  const notifierClock: Clock = options.clock ?? manual;
  const catalog = new NotificationCatalog();
  for (const t of [OTP, ORDER, SALE, PROMO_FIRST]) catalog.register(t);
  const users = new InMemoryUsers();
  for (const u of options.users ?? [FULL_USER]) users.upsert(u);
  const preferences = new PreferenceStore();
  const push = new FakeSender("push");
  const sms = new FakeSender("sms");
  const email = new FakeSender("email");
  const queue = options.queue ?? new InMemoryJobQueue();
  let n = 0;
  const { users: _u, now: _n, queue: _q, concurrency, clock: _c, ...rest } = options;
  const notifier = new QueuedNotifier({
    catalog,
    users,
    preferences,
    senders: [push, sms, email],
    queue,
    clock: notifierClock,
    newId: () => `n${++n}`,
    retry: { maxAttempts: 3, backoff: exponentialBackoff({ initialMs: 1_000, maxMs: 60_000, jitter: "none" }) },
    sendTimeoutMs: 5_000,
    leaseMs: 30_000,
    ...rest,
  });
  const worker = new Worker(notifier, { concurrency: concurrency ?? 4 });
  return { clock, catalog, users, preferences, push, sms, email, queue, notifier, worker };
}

export const otpReq = (key = "k1", code = "123456") => ({ typeId: "otp", userId: "u1", data: { code }, idempotencyKey: key });
export const saleReq = (key = "s1") => ({ typeId: "sale", userId: "u1", data: { pct: 20 }, idempotencyKey: key });
export const orderReq = (key = "o1") => ({
  typeId: "order_shipped",
  userId: "u1",
  data: { orderId: "A1", user: { name: "Asha" } },
  idempotencyKey: key,
});
export const failed = (retryable: boolean, reason = "nope") => ({ status: "failed" as const, retryable, reason });
