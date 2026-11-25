import { describe, expect, it } from "vitest";
import { systemClock } from "../src/clock.js";
import { notificationStatus } from "../src/record.js";
import { Worker } from "../src/worker.js";
import { gate } from "./helpers.js";
import { orderReq, otpReq, setupQueued } from "./queued-helpers.js";

async function until(check: () => boolean, ms = 2_000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("Worker loop (real timers)", () => {
  it("start() picks up work that arrives later; stop() resolves", async () => {
    const { notifier, push } = setupQueued({ clock: systemClock });
    const worker = new Worker(notifier, { pollMs: 10 });
    worker.start();
    worker.start(); // a second start is a no-op
    const r = notifier.notify(otpReq());
    await until(() => notificationStatus(notifier.get(r.id)!) === "delivered");
    await worker.stop();
    expect(push.sent).toHaveLength(1);
  });

  it("start() twice runs ONE loop: with concurrency 1 a second job waits for the first", async () => {
    const { notifier, push } = setupQueued({ clock: systemClock });
    const slow = gate<{ status: "sent"; providerId: string }>();
    push.willAnswer(() => slow.promise, () => slow.promise);
    const worker = new Worker(notifier, { concurrency: 1, pollMs: 10 });
    notifier.notify(otpReq("k1"));
    notifier.notify(otpReq("k2"));
    worker.start();
    worker.start();
    await until(() => push.attempts.length === 1);
    await new Promise((res) => setTimeout(res, 50));
    expect(push.attempts).toHaveLength(1);
    slow.resolve({ status: "sent", providerId: "p" });
    await until(() => push.sent.length === 2);
    await worker.stop();
  });

  it("stop() waits for the job in progress instead of abandoning it", async () => {
    const { notifier, push } = setupQueued({ clock: systemClock });
    const slow = gate<{ status: "sent"; providerId: string }>();
    push.willAnswer(() => slow.promise);
    const worker = new Worker(notifier, { pollMs: 10 });
    const r = notifier.notify(orderReq());
    worker.start();
    await until(() => push.attempts.length === 1);
    let stopped = false;
    const stopping = worker.stop().then(() => (stopped = true));
    await new Promise((res) => setTimeout(res, 20));
    expect(stopped).toBe(false);
    slow.resolve({ status: "sent", providerId: "p" });
    await stopping;
    expect(notifier.get(r.id)!.deliveries[0]!.status).toBe("sent");
  });

  it("several workers on one queue never process the same job twice", async () => {
    const { notifier, push, email } = setupQueued();
    for (let i = 0; i < 30; i++) notifier.notify(orderReq(`o${i}`));
    const workers = [1, 2, 3].map(() => new Worker(notifier, { concurrency: 4 }));
    while ((await Promise.all(workers.map((w) => w.runOnce()))).some((n) => n > 0)) {
      // keep going until every worker finds nothing
    }
    expect(push.attempts).toHaveLength(30);
    expect(email.attempts).toHaveLength(30);
    expect(new Set(push.attempts.map((m) => m.idempotencyKey)).size).toBe(30);
  });

  it("rejects bad options", () => {
    const { notifier } = setupQueued();
    expect(() => new Worker(notifier, { concurrency: 0 })).toThrow(RangeError);
    expect(() => new Worker(notifier, { pollMs: 0 })).toThrow(RangeError);
  });
});
