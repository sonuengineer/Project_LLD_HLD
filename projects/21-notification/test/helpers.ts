import { NotificationCatalog, type NotificationTypeDef } from "../src/catalog.js";
import { ManualClock } from "../src/clock.js";
import { Notifier, type NotificationRecord } from "../src/notifier.js";
import { PreferenceStore } from "../src/preferences.js";
import { FakeSender } from "../src/senders.js";
import type { Recipient } from "../src/types.js";
import { InMemoryUsers } from "../src/users.js";

export const T0 = Date.UTC(2026, 10, 23, 12, 0); // 12:00 UTC
export const HOUR = 3_600_000;
export const MIN = 60_000;

export const OTP: NotificationTypeDef = {
  id: "otp",
  category: "transactional",
  mode: "first",
  channels: ["push", "sms", "email"],
  templates: {
    push: { body: "Code {{code}}" },
    sms: { body: "Code {{code}}" },
    email: { subject: "Your code", body: "<p>Code {{code}}</p>" },
  },
};

export const ORDER: NotificationTypeDef = {
  id: "order_shipped",
  category: "transactional",
  mode: "all",
  channels: ["push", "email"],
  templates: {
    push: { body: "Order {{orderId}} shipped" },
    email: { subject: "Order {{orderId}}", body: "<p>Hi {{user.name}}, order {{orderId}} shipped</p>" },
  },
};

export const SALE: NotificationTypeDef = {
  id: "sale",
  category: "marketing",
  mode: "all",
  channels: ["push", "sms", "email"],
  templates: {
    push: { body: "{{pct}}% off" },
    sms: { body: "{{pct}}% off" },
    email: { subject: "Sale", body: "<p>{{pct}}% off</p>" },
  },
};

export const PROMO_FIRST: NotificationTypeDef = { ...SALE, id: "promo_first", mode: "first" };

export const FULL_USER: Recipient = { userId: "u1", email: "u1@example.test", phone: "+10000000001", pushTokens: ["tok-1"] };

export function setup(options: { types?: NotificationTypeDef[]; users?: Recipient[]; now?: number } = {}) {
  const clock = new ManualClock(options.now ?? T0);
  const catalog = new NotificationCatalog();
  for (const t of options.types ?? [OTP, ORDER, SALE, PROMO_FIRST]) catalog.register(t);
  const users = new InMemoryUsers();
  for (const u of options.users ?? [FULL_USER]) users.upsert(u);
  const preferences = new PreferenceStore();
  const push = new FakeSender("push");
  const sms = new FakeSender("sms");
  const email = new FakeSender("email");
  let n = 0;
  const notifier = new Notifier({ catalog, users, preferences, senders: [push, sms, email], clock, newId: () => `n${++n}` });
  return { clock, catalog, users, preferences, push, sms, email, notifier };
}

export function statuses(record: NotificationRecord): string {
  return record.deliveries
    .map((d) => `${d.channel}:${d.status}${d.skipReason ? `(${d.skipReason})` : ""}`)
    .join(" ");
}

export function errorCode(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return undefined;
}

export async function rejectCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return undefined;
}

// A promise you resolve from outside: holds a fake provider "in flight".
export function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
