// npm run demo -- one OTP with fallback, one marketing message in quiet hours, then the quiet hours end.
// Fake senders only: nothing leaves the process.
import {
  FakeSender,
  InMemoryUsers,
  ManualClock,
  NotificationCatalog,
  Notifier,
  notificationStatus,
  PreferenceStore,
} from "./index.js";

const clock = new ManualClock(Date.UTC(2026, 10, 23, 17, 0)); // 17:00 UTC = 22:30 at UTC+5:30
const catalog = new NotificationCatalog();
catalog.register({
  id: "otp",
  category: "transactional",
  mode: "first",
  channels: ["push", "sms", "email"],
  templates: {
    push: { body: "Your code is {{code}}" },
    sms: { body: "Your code is {{code}}" },
    email: { subject: "Your code", body: "<p>Your code is <b>{{code}}</b></p>" },
  },
});
catalog.register({
  id: "sale",
  category: "marketing",
  mode: "all",
  channels: ["push", "email"],
  templates: {
    push: { body: "{{percent}}% off today" },
    email: { subject: "Sale: {{percent}}% off", body: "<p>{{percent}}% off today</p>" },
  },
});

const users = new InMemoryUsers();
users.upsert({ userId: "u1", email: "u1@example.test", phone: "+10000000001", pushToken: "tok-1", utcOffsetMinutes: 330 });
const preferences = new PreferenceStore();
preferences.set("u1", { mutedMarketing: [], quietHours: { start: "22:00", end: "07:00" } });

const push = new FakeSender("push").willAnswer({ status: "failed", retryable: false, reason: "token expired" });
const sms = new FakeSender("sms");
const email = new FakeSender("email");
const notifier = new Notifier({ catalog, users, preferences, senders: [push, sms, email], clock });

const show = (label: string, r: Awaited<ReturnType<Notifier["notify"]>>) =>
  console.log(label, notificationStatus(r), r.deliveries.map((d) => `${d.channel}:${d.status}${d.skipReason ? `(${d.skipReason})` : ""}`).join(" "));

const otp = await notifier.notify({ typeId: "otp", userId: "u1", data: { code: "482913" }, idempotencyKey: "login-1" });
show("otp     ", otp);
const again = await notifier.notify({ typeId: "otp", userId: "u1", data: { code: "482913" }, idempotencyKey: "login-1" });
console.log("retry of the same request -> same record:", again.id === otp.id, "| sms sends:", sms.sent.length);

const sale = await notifier.notify({ typeId: "sale", userId: "u1", data: { percent: 20 }, idempotencyKey: "sale-1" });
show("sale    ", sale);
clock.set(Date.UTC(2026, 10, 24, 1, 30)); // 07:00 local
console.log("flushDue attempted:", await notifier.flushDue());
show("sale now", notifier.get(sale.id)!);
