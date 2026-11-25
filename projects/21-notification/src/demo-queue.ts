// npm run demo:queue -- stage 2 on a manual clock: a retry with backoff, a dead push provider tripping its circuit
// breaker (an OTP then fails over to SMS at once), and a marketing frequency cap.
// Fake senders only: nothing leaves the process.
import { MemoryStore, RateLimiter, slidingWindow } from "ratelimit-kit";
import { exponentialBackoff } from "resilience-kit";
import {
  FakeSender,
  InMemoryJobQueue,
  InMemoryUsers,
  ManualClock,
  NotificationCatalog,
  notificationStatus,
  PreferenceStore,
  QueuedNotifier,
  Worker,
  type NotificationRecord,
} from "./index.js";

const clock = new ManualClock(Date.UTC(2026, 10, 23, 6, 0)); // 06:00 UTC = 11:30 at UTC+5:30, outside quiet hours
const catalog = new NotificationCatalog();
catalog.register({
  id: "otp",
  category: "transactional",
  mode: "first",
  channels: ["push", "sms"],
  templates: { push: { body: "Your code is {{code}}" }, sms: { body: "Your code is {{code}}" } },
});
catalog.register({
  id: "receipt",
  category: "transactional",
  mode: "all",
  channels: ["email"],
  templates: { email: { subject: "Receipt {{orderId}}", body: "<p>Thanks for order {{orderId}}</p>" } },
});
catalog.register({
  id: "sale",
  category: "marketing",
  mode: "all",
  channels: ["sms"],
  templates: { sms: { body: "{{pct}}% off today" } },
});

const users = new InMemoryUsers();
users.upsert({ userId: "u1", email: "u1@example.test", phone: "+10000000001", pushTokens: ["tok-1"], utcOffsetMinutes: 330 });
const preferences = new PreferenceStore();

const down = { status: "failed", retryable: true, reason: "provider 503" } as const;
const push = new FakeSender("push").willAnswer(...Array<typeof down>(20).fill(down)); // down for the whole demo
const sms = new FakeSender("sms");
const email = new FakeSender("email").willAnswer(down); // one failure, then fine

const limiter = new RateLimiter({
  algorithm: slidingWindow({ limit: 1, windowMs: 24 * 3_600_000 }), // 1 marketing SMS per user per day
  store: new MemoryStore({ now: () => clock.now() }),
});
const queue = new InMemoryJobQueue();
const notifier = new QueuedNotifier({
  catalog,
  users,
  preferences,
  senders: [push, sms, email],
  queue,
  clock,
  retry: { maxAttempts: 3, backoff: exponentialBackoff({ initialMs: 1_000, maxMs: 60_000, jitter: "none" }) },
  breaker: { windowSize: 4, minimumCalls: 2, failureRateThreshold: 0.5, openMs: 30_000 },
  sendTimeoutMs: 5_000,
  leaseMs: 30_000,
  frequencyCap: limiter,
});
const worker = new Worker(notifier, { concurrency: 4 });

const show = (label: string, r: NotificationRecord) =>
  console.log(
    label.padEnd(10),
    notificationStatus(notifier.get(r.id)!).padEnd(11),
    notifier
      .get(r.id)!
      .deliveries.map((d) => `${d.channel}:${d.status}${d.skipReason ? `(${d.skipReason})` : ""} x${d.attempts}`)
      .join(" "),
  );

console.log("1. A retryable failure goes back in the queue with a backoff; it is not retried in a loop.");
const receipt = notifier.notify({ typeId: "receipt", userId: "u1", data: { orderId: "A1" }, idempotencyKey: "rcpt-A1" });
await worker.drain();
show("receipt", receipt);
console.log("   jobs waiting:", queue.jobs().map((j) => `${j.channel} at +${(j.runAt - clock.now()) / 1000}s`).join(", "));
clock.advance(1_000);
await worker.drain();
show("receipt", receipt);

console.log("\n2. The push provider is down: its breaker opens, and the next OTP fails over to SMS without waiting.");
for (const key of ["otp-1", "otp-2"]) {
  const otp = notifier.notify({ typeId: "otp", userId: "u1", data: { code: "482913" }, idempotencyKey: key });
  for (let i = 0; i < 5; i++) {
    await worker.drain();
    clock.advance(2_000);
  }
  show(key, otp);
}
console.log("   push breaker:", notifier.breakerState("push"), "| push provider calls:", push.attempts.length);
const otp3 = notifier.notify({ typeId: "otp", userId: "u1", data: { code: "777001" }, idempotencyKey: "otp-3" });
await worker.drain();
show("otp-3", otp3);
console.log("   push provider calls still:", push.attempts.length, "(the open circuit refused the call)");

console.log("\n3. Marketing: at most 1 sale SMS per user per day; the second one is skipped, not delayed.");
const sale1 = notifier.notify({ typeId: "sale", userId: "u1", data: { pct: 20 }, idempotencyKey: "sale-1" });
await worker.drain();
show("sale-1", sale1);
const sale2 = notifier.notify({ typeId: "sale", userId: "u1", data: { pct: 30 }, idempotencyKey: "sale-2" });
await worker.drain();
show("sale-2", sale2);

console.log("\nstats:", JSON.stringify(notifier.stats));
