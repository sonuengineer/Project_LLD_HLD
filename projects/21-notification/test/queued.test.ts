import { describe, expect, it } from "vitest";
import { MemoryStore, RateLimiter, slidingWindow } from "ratelimit-kit";
import { notificationStatus } from "../src/record.js";
import { InMemoryJobQueue } from "../src/queue.js";
import { errorCode, FULL_USER, gate, statuses, T0 } from "./helpers.js";
import { failed, orderReq, otpReq, saleReq, setupQueued } from "./queued-helpers.js";

const NIGHT = { start: "22:00", end: "07:00" };

describe("QueuedNotifier: notify queues, workers send", () => {
  it("notify returns at once (in_progress), nothing is sent until a worker runs", async () => {
    const { notifier, worker, push, queue } = setupQueued();
    const r = notifier.notify(otpReq());
    expect(notificationStatus(r)).toBe("in_progress");
    expect(push.attempts).toHaveLength(0);
    expect(queue.size).toBe(1); // "first": one job at a time
    expect(await worker.drain()).toBe(1);
    expect(statuses(notifier.get(r.id)!)).toBe("push:sent sms:skipped(not_needed) email:skipped(not_needed)");
    expect(queue.size).toBe(0);
  });

  it('"all" queues one job per channel; they run in the same batch', async () => {
    const { notifier, worker, queue, push, email } = setupQueued();
    const r = notifier.notify(orderReq());
    expect(queue.jobs().map((j) => j.channel)).toEqual(["push", "email"]);
    expect(await worker.runOnce()).toBe(2);
    expect(statuses(notifier.get(r.id)!)).toBe("push:sent email:sent");
    expect([push.sent.length, email.sent.length]).toEqual([1, 1]);
  });

  it("transactional jobs are claimed before marketing jobs queued earlier", async () => {
    const { notifier, worker, push } = setupQueued({ concurrency: 1 });
    for (let i = 0; i < 5; i++) notifier.notify(saleReq(`s${i}`));
    notifier.notify(otpReq());
    await worker.runOnce();
    expect(push.attempts.map((m) => m.body)).toEqual(["Code 123456"]);
  });

  it("errors throw before anything is stored or queued", () => {
    const { notifier, queue } = setupQueued();
    expect(errorCode(() => notifier.notify({ ...otpReq(), typeId: "nope" }))).toBe("UNKNOWN_TYPE");
    expect(errorCode(() => notifier.notify({ ...otpReq(), data: {} }))).toBe("TEMPLATE_VARIABLE_MISSING");
    expect(queue.size).toBe(0);
    expect(notifier.list()).toEqual([]);
  });

  it("rejects leaseMs <= sendTimeoutMs and a bad maxAttempts", () => {
    expect(errorCode(() => setupQueued({ sendTimeoutMs: 30_000, leaseMs: 30_000 }))).toBe("INVALID_REQUEST");
    expect(errorCode(() => setupQueued({ retry: { maxAttempts: 0 } }))).toBe("INVALID_REQUEST");
  });
});

describe("retries", () => {
  it("a retry that is skipped when it runs (address removed meanwhile) keeps no nextAttemptAt", async () => {
    const { notifier, worker, clock, users, push, sms } = setupQueued();
    push.willAnswer(failed(true));
    const r = notifier.notify(otpReq());
    await worker.drain();
    expect(notifier.get(r.id)!.deliveries[0]).toMatchObject({ status: "pending", nextAttemptAt: clock.now() + 1_000 });
    users.upsert({ ...FULL_USER, pushTokens: undefined });
    clock.advance(1_000);
    await worker.drain();
    const pushDelivery = notifier.get(r.id)!.deliveries[0]!;
    expect(pushDelivery).toMatchObject({ status: "skipped", skipReason: "no_address" });
    expect(pushDelivery).not.toHaveProperty("nextAttemptAt");
    expect(sms.sent).toHaveLength(1);
  });

  it("a retryable failure goes back in the queue after the backoff (1 s, 2 s), not before", async () => {
    const { notifier, worker, clock, push } = setupQueued();
    push.willAnswer(failed(true, "503"), failed(true, "503"));
    const r = notifier.notify(orderReq());
    await worker.drain();
    let push1 = notifier.get(r.id)!.deliveries[0]!;
    expect(push1).toMatchObject({ status: "pending", attempts: 1, error: "503", nextAttemptAt: T0 + 1_000 });
    expect(notificationStatus(notifier.get(r.id)!)).toBe("in_progress");

    clock.advance(999);
    expect(await worker.drain()).toBe(0);
    clock.advance(1);
    await worker.drain();
    push1 = notifier.get(r.id)!.deliveries[0]!;
    expect(push1).toMatchObject({ attempts: 2, nextAttemptAt: T0 + 1_000 + 2_000 });
    clock.advance(2_000);
    await worker.drain();
    push1 = notifier.get(r.id)!.deliveries[0]!;
    expect(push1.status).toBe("sent");
    expect(push1.attempts).toBe(3);
    expect(push1.nextAttemptAt).toBeUndefined();
    expect(push1.error).toBeUndefined();
    expect(push.attempts.map((m) => m.idempotencyKey)).toEqual([`${r.id}:push:tok-1`, `${r.id}:push:tok-1`, `${r.id}:push:tok-1`]);
  });

  it('"all": attempts used up -> failed (the other channel is unaffected)', async () => {
    const { notifier, worker, clock, push } = setupQueued();
    push.willAnswer(failed(true), failed(true), failed(true), failed(true));
    const r = notifier.notify(orderReq());
    for (let i = 0; i < 5; i++) {
      await worker.drain();
      clock.advance(60_000);
    }
    expect(statuses(notifier.get(r.id)!)).toBe("push:failed email:sent");
    expect(push.attempts).toHaveLength(3);
    expect(notifier.get(r.id)!.deliveries[0]).toMatchObject({ retryable: true, attempts: 3 });
  });

  it('"first": attempts used up on push -> the sms job is queued and sends', async () => {
    const { notifier, worker, clock, push, sms } = setupQueued();
    push.willAnswer(failed(true), failed(true), failed(true));
    const r = notifier.notify(otpReq());
    for (let i = 0; i < 3; i++) {
      await worker.drain();
      clock.advance(60_000);
    }
    expect(statuses(notifier.get(r.id)!)).toBe("push:failed sms:sent email:skipped(not_needed)");
    expect(sms.sent).toHaveLength(1);
  });

  it("a permanent failure is not retried: \"first\" moves to the next channel at once", async () => {
    const { notifier, worker, push, sms } = setupQueued();
    push.willAnswer(failed(false, "token unregistered"));
    const r = notifier.notify(otpReq());
    await worker.drain();
    expect(push.attempts).toHaveLength(1);
    expect(sms.sent).toHaveLength(1);
    expect(notifier.get(r.id)!.deliveries[0]).toMatchObject({ status: "failed", retryable: false, error: "token unregistered" });
  });

  it("a hanging provider times out: retryable failure, the signal given to the sender is aborted", async () => {
    const { notifier, worker, push } = setupQueued({ sendTimeoutMs: 30, leaseMs: 1_000 });
    let seen: AbortSignal | undefined;
    push.willAnswer((_m, signal) => {
      seen = signal;
      return new Promise(() => {}); // never answers
    });
    const r = notifier.notify(orderReq());
    await worker.drain();
    expect(notifier.get(r.id)!.deliveries[0]).toMatchObject({ status: "pending", attempts: 1, error: "timed out after 30 ms" });
    expect(seen?.aborted).toBe(true);
  });

  it("a sender that throws is retried like any retryable failure", async () => {
    const { notifier, worker, clock, push } = setupQueued();
    push.willAnswer("throw");
    const r = notifier.notify(orderReq());
    await worker.drain();
    expect(notifier.get(r.id)!.deliveries[0]!.error).toBe("sender threw: push provider exploded");
    clock.advance(1_000);
    await worker.drain();
    expect(notifier.get(r.id)!.deliveries[0]!.status).toBe("sent");
  });
});

describe("circuit breaker per channel", () => {
  const breaker = { windowSize: 4, minimumCalls: 2, failureRateThreshold: 0.5, openMs: 30_000 };

  async function openPushBreaker() {
    const s = setupQueued({ breaker, retry: { maxAttempts: 1 } });
    s.push.willAnswer(failed(true), failed(true));
    s.notifier.notify(orderReq("o1"));
    s.notifier.notify(orderReq("o2"));
    await s.worker.drain();
    expect(s.notifier.breakerState("push")).toBe("open");
    return s;
  }

  it('"first": circuit open -> no provider call, fail over to sms immediately', async () => {
    const { notifier, worker, push, sms } = await openPushBreaker();
    const before = push.attempts.length;
    const r = notifier.notify(otpReq());
    await worker.drain();
    expect(push.attempts).toHaveLength(before);
    expect(notifier.get(r.id)!.deliveries[0]).toMatchObject({ status: "failed", error: "circuit open", attempts: 0 });
    expect(sms.sent).toHaveLength(1);
    expect(notifier.stats.failedOver).toBe(1);
  });

  it('"all": circuit open -> requeued for when a probe is allowed, no attempt used; then sent', async () => {
    const { notifier, worker, clock, push } = await openPushBreaker();
    const before = push.attempts.length;
    const r = notifier.notify(orderReq("o3"));
    await worker.drain();
    const d = notifier.get(r.id)!.deliveries[0]!;
    expect(d).toMatchObject({ status: "pending", attempts: 0, error: "circuit open", nextAttemptAt: T0 + 30_000 });
    expect(push.attempts).toHaveLength(before);
    clock.advance(30_000);
    await worker.drain();
    expect(notifier.get(r.id)!.deliveries[0]).toMatchObject({ status: "sent", attempts: 1 });
    expect(notifier.breakerState("push")).toBe("closed");
  });

  it("a permanent failure does not count against the breaker (the provider is working)", async () => {
    const { notifier, worker, push } = setupQueued({ breaker, retry: { maxAttempts: 1 } });
    push.willAnswer(failed(false), failed(false), failed(false), failed(false));
    for (let i = 0; i < 4; i++) notifier.notify(orderReq(`o${i}`));
    await worker.drain();
    expect(notifier.breakerState("push")).toBe("closed");
  });
});

describe("leases: at-least-once, never a lost job", () => {
  it("cap store fails AFTER the worker lost its lease: the late error is not written over the new owner's send", async () => {
    let failFirst!: (e: Error) => void;
    const first = new Promise<never>((_, reject) => (failFirst = reject));
    let calls = 0;
    const { notifier, worker, clock, preferences, push } = setupQueued({
      frequencyCap: { consume: () => (++calls === 1 ? first : Promise.resolve({ allowed: true } as never)) },
    });
    preferences.set("u1", { mutedMarketing: ["sms", "email"] });
    const r = notifier.notify(saleReq());
    const [job] = notifier.claim(1);
    const stalled = notifier.process(job!); // waits on the cap store
    clock.advance(30_000); // the lease runs out
    await worker.drain(); // another worker gets the job and sends
    expect(notifier.get(r.id)!.deliveries[0]!.status).toBe("sent");
    failFirst(new Error("redis down"));
    await stalled;
    expect(notifier.get(r.id)!.deliveries[0]).toMatchObject({ status: "sent" });
    expect(notifier.get(r.id)!.deliveries[0]).not.toHaveProperty("error");
    expect(notifier.stats.leaseLost).toBe(1);
    expect(push.sent).toHaveLength(1);
  });

  it("a worker that dies holding a job: after the lease the job is claimed again and sent", async () => {
    const { notifier, worker, clock, push, queue } = setupQueued();
    notifier.notify(orderReq());
    const dead = notifier.claim(10); // a worker claims ... and is never heard from again
    expect(dead).toHaveLength(2);
    expect(await worker.drain()).toBe(0); // leased
    clock.advance(30_000);
    expect(await worker.drain()).toBe(2);
    expect(push.sent).toHaveLength(1);
    expect(queue.stats.reclaimed).toBe(2);
  });

  it("a worker that stalls past its lease: the job goes to another worker; the late result is dropped", async () => {
    const { notifier, clock, push } = setupQueued();
    const slow = gate<{ status: "sent"; providerId: string }>();
    push.willAnswer(() => slow.promise); // worker A's call hangs (inside the timeout, which is real time)
    const r = notifier.notify({ ...otpReq() });
    const [jobA] = notifier.claim(1);
    const a = notifier.process(jobA!);
    clock.advance(30_000); // A's lease runs out
    const [jobB] = notifier.claim(1);
    expect(jobB!.claims).toBe(2);
    await notifier.process(jobB!); // B sends (default answer)
    slow.resolve({ status: "sent", providerId: "late-A" });
    await a;
    const d = notifier.get(r.id)!.deliveries[0]!;
    expect(d.providerId).toBe("push-1"); // B's result, not A's
    expect(notifier.stats.leaseLost).toBe(1);
    // the provider was called twice -- at-least-once -- with the SAME idempotency key, so it can drop one
    expect(push.attempts.map((m) => m.idempotencyKey)).toEqual([`${r.id}:push:tok-1`, `${r.id}:push:tok-1`]);
  });

  it("a job redelivered after its delivery finished (crash before complete) sends nothing", async () => {
    class ForgetfulQueue extends InMemoryJobQueue {
      forget = 1;
      override complete(id: string, token: number, now: number): boolean {
        if (this.forget-- > 0) return true; // the worker died between writing the result and acknowledging
        return super.complete(id, token, now);
      }
    }
    const queue = new ForgetfulQueue();
    const { notifier, worker, clock, push } = setupQueued({ queue });
    notifier.notify(otpReq());
    await worker.drain();
    clock.advance(30_000);
    expect(await worker.drain()).toBe(1);
    expect(push.attempts).toHaveLength(1);
    expect(notifier.stats.duplicateJobs).toBe(1);
    expect(queue.size).toBe(0);
  });

  it("an unexpected error inside a job does not escape: the job stays leased and is retried after the lease", async () => {
    const { notifier, worker, clock, users, push } = setupQueued();
    notifier.notify(orderReq());
    const original = users.get.bind(users);
    let broken = true;
    users.get = (id: string) => {
      if (broken) throw new Error("directory down");
      return original(id);
    };
    expect(await worker.drain()).toBe(2);
    expect(notifier.stats.unexpectedErrors).toBe(2);
    broken = false;
    clock.advance(30_000);
    await worker.drain();
    expect(push.sent).toHaveLength(1);
  });
});

describe("quiet hours and caps in the queue", () => {
  it("a deferred delivery is a delayed job; a late run inside the next window defers it again", async () => {
    const night = Date.UTC(2026, 10, 23, 23, 0);
    const { notifier, worker, clock, preferences, push, queue } = setupQueued({ now: night });
    preferences.set("u1", { mutedMarketing: ["sms", "email"], quietHours: NIGHT });
    const r = notifier.notify(saleReq());
    expect(queue.jobs()[0]!.runAt).toBe(Date.UTC(2026, 10, 24, 7, 0));
    expect(await worker.drain()).toBe(0);
    clock.set(Date.UTC(2026, 10, 24, 23, 30)); // the workers were down all day; it is night again
    expect(await worker.drain()).toBe(1);
    expect(push.attempts).toHaveLength(0);
    expect(notifier.get(r.id)!.deliveries[0]).toMatchObject({ status: "deferred", notBefore: Date.UTC(2026, 10, 25, 7, 0) });
    clock.set(Date.UTC(2026, 10, 25, 7, 0));
    await worker.drain();
    expect(push.sent).toHaveLength(1);
  });

  it('"first" marketing at night: email now, the deferred channels are not_needed and get no job', async () => {
    const { notifier, worker, preferences, queue } = setupQueued({ now: Date.UTC(2026, 10, 23, 23, 0) });
    preferences.set("u1", { mutedMarketing: [], quietHours: NIGHT });
    const r = notifier.notify({ ...saleReq(), typeId: "promo_first" });
    expect(queue.jobs().map((j) => j.channel)).toEqual(["email"]);
    await worker.drain();
    expect(statuses(notifier.get(r.id)!)).toBe("push:skipped(not_needed) sms:skipped(not_needed) email:sent");
    expect(queue.size).toBe(0);
  });

  // The limiter's store reads the SAME manual clock as the notifier (bound after setup creates it).
  function capped(limit: number) {
    let now = () => T0;
    const limiter = new RateLimiter({
      algorithm: slidingWindow({ limit, windowMs: 24 * 3_600_000 }),
      store: new MemoryStore({ now: () => now() }),
    });
    const s = setupQueued({ frequencyCap: limiter });
    now = () => s.clock.now();
    return s;
  }

  // ratelimit-kit's sliding window COUNTER weights the previous (day-aligned) window by how much of it is still inside
  // the sliding day. With a cap of 1 per day, a send at 12:00 on day N blocks until 00:00 UTC on day N+2 -- 36 h,
  // not 24 h. Pinned here because it surprises; a small cap may want a different algorithm (see README).
  it("cap of 1/day with the sliding window counter: still capped 24 h later, free at the second midnight", async () => {
    const { notifier, worker, clock, preferences, push } = capped(1);
    preferences.set("u1", { mutedMarketing: ["sms", "email"] });
    notifier.notify(saleReq("s1")); // day N 12:00
    const second = notifier.notify(saleReq("s2"));
    await worker.drain();
    expect(notifier.get(second.id)!.deliveries[0]!.skipReason).toBe("capped");
    clock.advance(24 * 3_600_000); // day N+1 12:00: previous day weighted 0.5 -> 0.5 + 1 > 1
    const third = notifier.notify(saleReq("s3"));
    await worker.drain();
    expect(notifier.get(third.id)!.deliveries[0]!.skipReason).toBe("capped");
    clock.set(Date.UTC(2026, 10, 25, 0, 0)); // day N+2 00:00: day N is out of the sliding window
    notifier.notify(saleReq("s4"));
    await worker.drain();
    expect(push.sent).toHaveLength(2);
  });

  it("marketing over the per-user, per-channel cap is skipped (capped); transactional is never capped", async () => {
    const { notifier, worker, preferences, push, email } = capped(2);
    preferences.set("u1", { mutedMarketing: ["sms"] });
    const ids = [1, 2, 3].map((i) => notifier.notify(saleReq(`s${i}`)).id);
    await worker.drain();
    expect(statuses(notifier.get(ids[2]!)!)).toBe("push:skipped(capped) sms:skipped(opted_out) email:skipped(capped)");
    expect([push.sent.length, email.sent.length]).toEqual([2, 2]);
    for (let i = 0; i < 3; i++) notifier.notify(otpReq(`k${i}`));
    await worker.drain();
    expect(push.sent).toHaveLength(5);
    expect(notifier.stats.capped).toBe(2);
  });

  it("a retry of an admitted delivery does not use the cap again", async () => {
    const { notifier, worker, clock, preferences, push } = capped(1);
    preferences.set("u1", { mutedMarketing: ["sms", "email"] });
    push.willAnswer(failed(true));
    const r = notifier.notify(saleReq());
    await worker.drain();
    clock.advance(1_000);
    await worker.drain();
    expect(notifier.get(r.id)!.deliveries[0]).toMatchObject({ status: "sent", attempts: 2 });
  });

  it("cap store unavailable: the job waits (no send, no attempt used), then goes through", async () => {
    let down = true;
    const limiter = new RateLimiter({ algorithm: slidingWindow({ limit: 5, windowMs: 60_000 }), store: new MemoryStore() });
    const { notifier, worker, clock, preferences, push } = setupQueued({
      frequencyCap: { consume: (key) => (down ? Promise.reject(new Error("redis down")) : limiter.consume(key)) },
    });
    preferences.set("u1", { mutedMarketing: ["sms", "email"] });
    const r = notifier.notify(saleReq());
    await worker.drain();
    expect(notifier.get(r.id)!.deliveries[0]).toMatchObject({ status: "pending", attempts: 0, error: "frequency cap unavailable" });
    expect(push.attempts).toHaveLength(0);
    down = false;
    clock.advance(1_000);
    await worker.drain();
    expect(notifier.get(r.id)!.deliveries[0]!.status).toBe("sent");
  });
});

describe("bounded idempotency keys (cache-kit)", () => {
  it("a duplicate within the TTL returns the same record and queues nothing", async () => {
    const { notifier, queue } = setupQueued();
    const a = notifier.notify(otpReq());
    const b = notifier.notify(otpReq());
    expect(b.id).toBe(a.id);
    expect(queue.size).toBe(1);
    expect(errorCode(() => notifier.notify(otpReq("k1", "999999")))).toBe("IDEMPOTENCY_CONFLICT");
    expect(notifier.getByKey("k1")?.id).toBe(a.id);
  });

  it("after the TTL the key is forgotten: the same key is a NEW notification (documented trade-off)", async () => {
    const { notifier, clock } = setupQueued({ idempotency: { ttlMs: 60_000 } });
    const a = notifier.notify(otpReq());
    clock.advance(60_000);
    const b = notifier.notify(otpReq("k1", "different"));
    expect(b.id).not.toBe(a.id);
  });

  it("maxEntries bounds memory: the least recently used key is evicted first", () => {
    const { notifier } = setupQueued({ idempotency: { maxEntries: 2 } });
    const a = notifier.notify(otpReq("k1"));
    notifier.notify(otpReq("k2"));
    notifier.notify(otpReq("k3")); // evicts k1
    expect(notifier.getByKey("k1")).toBeUndefined();
    expect(notifier.notify(otpReq("k1")).id).not.toBe(a.id);
  });
});
