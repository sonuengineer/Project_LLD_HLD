// npm start -- the API with a worker, fake senders and one demo user. Configuration from the environment:
//   NOTIFY_API_KEY  required, at least 16 characters (never in the code or the repo)
//   PORT            default 3000
//   HOST            default 127.0.0.1 (this process only; nothing is exposed to the network unless you change it)
// Fake senders only: nothing leaves the process. Ctrl+C shuts down cleanly.
import { exponentialBackoff } from "resilience-kit";
import { createApp, MIN_API_KEY_LENGTH } from "./http/app.js";
import { startServer } from "./http/server.js";
import { FakeSender, InMemoryJobQueue, InMemoryUsers, NotificationCatalog, PreferenceStore, QueuedNotifier, Worker } from "./index.js";

const apiKey = process.env.NOTIFY_API_KEY;
if (!apiKey || apiKey.length < MIN_API_KEY_LENGTH) {
  console.error(`Set NOTIFY_API_KEY (at least ${MIN_API_KEY_LENGTH} characters) to start the server.`);
  process.exit(1);
}
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "127.0.0.1";

const catalog = new NotificationCatalog();
catalog.register({
  id: "otp",
  category: "transactional",
  mode: "first",
  channels: ["push", "sms"],
  templates: { push: { body: "Your code is {{code}}" }, sms: { body: "Your code is {{code}}" } },
});
catalog.register({
  id: "sale",
  category: "marketing",
  mode: "all",
  channels: ["push", "email"],
  templates: { push: { body: "{{pct}}% off today" }, email: { subject: "Sale: {{pct}}% off", body: "<p>{{pct}}% off today</p>" } },
});
const users = new InMemoryUsers();
users.upsert({ userId: "u1", email: "u1@example.test", phone: "+10000000001", pushToken: "tok-1", utcOffsetMinutes: 330 });
const preferences = new PreferenceStore();
const senders = [new FakeSender("push"), new FakeSender("sms"), new FakeSender("email")];
const notifier = new QueuedNotifier({
  catalog,
  users,
  preferences,
  senders,
  queue: new InMemoryJobQueue(),
  retry: { maxAttempts: 3, backoff: exponentialBackoff({ initialMs: 1_000, maxMs: 60_000 }) },
});

const running = await startServer(createApp({ notifier, users, preferences, apiKey }), new Worker(notifier), { port, host });
console.log(`notification API on ${running.url} (fake senders; types: ${catalog.ids().join(", ")}; user: u1)`);

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    console.log(`${signal}: finishing requests and sends in progress...`);
    running.close().then(
      () => process.exit(0),
      (error) => {
        console.error(error);
        process.exit(1);
      },
    );
  });
}
