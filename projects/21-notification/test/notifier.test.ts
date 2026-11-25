import { describe, expect, it } from "vitest";
import { notificationStatus } from "../src/notifier.js";
import { FakeSender } from "../src/senders.js";
import { FULL_USER, gate, HOUR, ORDER, rejectCode, setup, statuses, T0 } from "./helpers.js";

const otp = (key = "k1", code = "123456") => ({ typeId: "otp", userId: "u1", data: { code }, idempotencyKey: key });
const sale = (key = "s1") => ({ typeId: "sale", userId: "u1", data: { pct: 20 }, idempotencyKey: key });
const fail = (retryable = false) => ({ status: "failed" as const, retryable, reason: "nope" });

describe("delivery modes", () => {
  it('"all" sends every channel, rendered and addressed; email body escaped, push not', async () => {
    const { notifier, push, email } = setup();
    const r = await notifier.notify({
      typeId: "order_shipped",
      userId: "u1",
      data: { orderId: "A<7>", user: { name: "Asha" } },
      idempotencyKey: "o1",
    });
    expect(statuses(r)).toBe("push:sent email:sent");
    expect(notificationStatus(r)).toBe("delivered");
    expect(push.sent).toEqual([
      { notificationId: r.id, channel: "push", to: "tok-1", idempotencyKey: `${r.id}:push`, body: "Order A<7> shipped" },
    ]);
    expect(email.sent).toEqual([
      {
        notificationId: r.id,
        channel: "email",
        to: FULL_USER.email,
        idempotencyKey: `${r.id}:email`,
        subject: "Order A<7>",
        body: "<p>Hi Asha, order A&lt;7&gt; shipped</p>",
      },
    ]);
    expect(r.deliveries.every((d) => d.attempts === 1 && typeof d.providerId === "string")).toBe(true);
  });

  it('"first" stops at the first success: later channels are not_needed and never called', async () => {
    const { notifier, push, sms, email } = setup();
    const r = await notifier.notify(otp());
    expect(statuses(r)).toBe("push:sent sms:skipped(not_needed) email:skipped(not_needed)");
    expect([push.attempts.length, sms.attempts.length, email.attempts.length]).toEqual([1, 0, 0]);
  });

  it('"first" falls through failures, permanent or retryable, and a throwing sender', async () => {
    const { notifier, push, sms, email } = setup();
    push.willAnswer(fail(false));
    sms.willAnswer("throw");
    const r = await notifier.notify(otp());
    expect(statuses(r)).toBe("push:failed sms:failed email:sent");
    expect(r.deliveries[0]).toMatchObject({ error: "nope", retryable: false });
    expect(r.deliveries[1]).toMatchObject({ retryable: true, error: "sender threw: sms provider exploded" });
    expect(email.sent).toHaveLength(1);
  });

  it('"first": every channel failing -> failed, each tried once in order', async () => {
    const { notifier, push, sms, email } = setup();
    const order: string[] = [];
    for (const s of [push, sms, email]) s.willAnswer((m) => (order.push(m.channel), fail(true)));
    const r = await notifier.notify(otp());
    expect(order).toEqual(["push", "sms", "email"]);
    expect(notificationStatus(r)).toBe("failed");
  });

  it('"all": one channel failing does not stop the others', async () => {
    const { notifier, push, email } = setup();
    push.willAnswer(fail());
    const r = await notifier.notify({ typeId: "order_shipped", userId: "u1", data: { orderId: "1", user: { name: "A" } }, idempotencyKey: "o" });
    expect(statuses(r)).toBe("push:failed email:sent");
    expect(notificationStatus(r)).toBe("delivered");
    expect(email.sent).toHaveLength(1);
  });

  it('"all" sends in parallel: a slow push does not hold the email back', async () => {
    const { notifier, push, email } = setup();
    const slow = gate<{ status: "sent"; providerId: string }>();
    push.willAnswer(() => slow.promise);
    const done = notifier.notify({ typeId: "order_shipped", userId: "u1", data: { orderId: "1", user: { name: "A" } }, idempotencyKey: "o" });
    await Promise.resolve();
    await Promise.resolve();
    expect(email.sent).toHaveLength(1);
    expect(notificationStatus(notifier.list()[0]!)).toBe("in_progress");
    slow.resolve({ status: "sent", providerId: "p" });
    expect(notificationStatus(await done)).toBe("delivered");
  });

  it("a sender returning garbage is a retryable failure, not a crash", async () => {
    const { notifier, push } = setup();
    push.willAnswer({ status: "ok" } as never);
    const r = await notifier.notify(otp());
    expect(r.deliveries[0]).toMatchObject({ status: "failed", retryable: true, error: "sender returned an invalid result" });
    expect(r.deliveries[1]!.status).toBe("sent");
  });

  it("no address: skipped; a user with no address for any channel -> suppressed, nothing sent", async () => {
    const { notifier, push, sms, email } = setup({ users: [{ userId: "u1", phone: "+1000" }, { userId: "u2" }] });
    expect(statuses(await notifier.notify(otp()))).toBe("push:skipped(no_address) sms:sent email:skipped(no_address)");
    const r = await notifier.notify({ ...otp("k2"), userId: "u2" });
    expect(notificationStatus(r)).toBe("suppressed");
    expect(push.attempts.length + sms.attempts.length + email.attempts.length).toBe(1);
  });
});

describe("preferences in the notifier", () => {
  it("marketing respects mutes; transactional ignores them", async () => {
    const { notifier, preferences, sms } = setup();
    preferences.set("u1", { mutedMarketing: ["sms", "push", "email"] });
    expect(notificationStatus(await notifier.notify(sale()))).toBe("suppressed");
    expect(statuses(await notifier.notify(sale("s2")))).toBe("push:skipped(opted_out) sms:skipped(opted_out) email:skipped(opted_out)");
    sms.willAnswer(); // default: sent
    const r = await notifier.notify(otp());
    expect(r.deliveries[0]!.status).toBe("sent");
  });

  it("quiet hours defer marketing sms/push, flushDue sends them when due, not before", async () => {
    const night = Date.UTC(2026, 10, 23, 23, 0);
    const { notifier, preferences, clock, push, sms, email } = setup({ now: night });
    preferences.set("u1", { mutedMarketing: [], quietHours: { start: "22:00", end: "07:00" } });
    const r = await notifier.notify(sale());
    expect(statuses(r)).toBe("push:deferred sms:deferred email:sent");
    expect(notificationStatus(r)).toBe("scheduled");
    expect(r.deliveries[0]!.notBefore).toBe(Date.UTC(2026, 10, 24, 7, 0));

    clock.set(Date.UTC(2026, 10, 24, 6, 59, 59, 999));
    expect(await notifier.flushDue()).toBe(0);
    expect(push.attempts).toHaveLength(0);

    clock.set(Date.UTC(2026, 10, 24, 7, 0));
    expect(await notifier.flushDue()).toBe(2);
    const after = notifier.get(r.id)!;
    expect(statuses(after)).toBe("push:sent sms:sent email:sent");
    expect(after.deliveries[0]!.notBefore).toBeUndefined();
    expect([push.sent.length, sms.sent.length, email.sent.length]).toEqual([1, 1, 1]);
    expect(await notifier.flushDue()).toBe(0); // nothing sent twice
  });

  it('"first" marketing in quiet hours: email (not deferred) delivers now, the deferred channels become not_needed', async () => {
    const { notifier, preferences, push } = setup({ now: Date.UTC(2026, 10, 23, 23, 0) });
    preferences.set("u1", { mutedMarketing: [], quietHours: { start: "22:00", end: "07:00" } });
    const r = await notifier.notify({ ...sale(), typeId: "promo_first" });
    expect(statuses(r)).toBe("push:skipped(not_needed) sms:skipped(not_needed) email:sent");
    expect(r.deliveries[0]!.notBefore).toBeUndefined();
    expect(notificationStatus(r)).toBe("delivered");
    expect(await notifier.flushDue()).toBe(0);
    expect(push.attempts).toHaveLength(0);
  });

  it('"first" with email failing in quiet hours: deferred channels wait, and at flush stop at the first success', async () => {
    const { notifier, preferences, clock, push, sms, email } = setup({ now: Date.UTC(2026, 10, 23, 23, 0) });
    preferences.set("u1", { mutedMarketing: [], quietHours: { start: "22:00", end: "07:00" } });
    email.willAnswer(fail());
    const r = await notifier.notify({ ...sale(), typeId: "promo_first" });
    expect(statuses(r)).toBe("push:deferred sms:deferred email:failed");
    clock.set(Date.UTC(2026, 10, 24, 7, 0));
    expect(await notifier.flushDue()).toBe(1);
    expect(statuses(notifier.get(r.id)!)).toBe("push:sent sms:skipped(not_needed) email:failed");
    expect(sms.attempts).toHaveLength(0);
    expect(push.sent).toHaveLength(1);
  });

  it("deferred delivery failing at flush stays failed (stage 1 has no retries)", async () => {
    const { notifier, preferences, clock, push } = setup({ now: Date.UTC(2026, 10, 23, 23, 0) });
    preferences.set("u1", { mutedMarketing: ["sms", "email"], quietHours: { start: "22:00", end: "07:00" } });
    push.willAnswer(fail(true));
    const r = await notifier.notify(sale());
    clock.advance(9 * HOUR);
    expect(await notifier.flushDue()).toBe(1);
    expect(notificationStatus(notifier.get(r.id)!)).toBe("failed");
    expect(await notifier.flushDue()).toBe(0);
  });

  it("two concurrent flushDue calls send a deferred delivery once", async () => {
    const { notifier, preferences, clock, push } = setup({ now: Date.UTC(2026, 10, 23, 23, 0) });
    preferences.set("u1", { mutedMarketing: ["sms", "email"], quietHours: { start: "22:00", end: "07:00" } });
    await notifier.notify(sale());
    clock.advance(9 * HOUR);
    const slow = gate<{ status: "sent"; providerId: string }>();
    push.willAnswer(() => slow.promise);
    const a = notifier.flushDue();
    const b = notifier.flushDue();
    slow.resolve({ status: "sent", providerId: "p" });
    expect([await a, await b]).toEqual([1, 0]);
    expect(push.attempts).toHaveLength(1);
  });

  it("flushDue skips a record whose sends are still running, and picks it up next time", async () => {
    // "first" record: email (not deferred) is slow; push is deferred and comes due meanwhile.
    const { notifier, preferences, clock, push, email } = setup({ now: Date.UTC(2026, 10, 23, 23, 0) });
    preferences.set("u1", { mutedMarketing: ["sms"], quietHours: { start: "22:00", end: "07:00" } });
    const slow = gate<{ status: "failed"; retryable: boolean; reason: string }>();
    email.willAnswer(() => slow.promise);
    const done = notifier.notify({ ...sale(), typeId: "promo_first" });
    clock.advance(9 * HOUR);
    expect(await notifier.flushDue()).toBe(0); // record busy: push NOT sent alongside the email
    expect(push.attempts).toHaveLength(0);
    slow.resolve(fail(false));
    await done;
    expect(await notifier.flushDue()).toBe(1);
    expect(push.sent).toHaveLength(1);
  });
});

describe("a due delivery is planned again at send time", () => {
  const NIGHT = { start: "22:00", end: "07:00" };
  const night = Date.UTC(2026, 10, 23, 23, 0);

  async function deferredPush() {
    const s = setup({ now: night });
    s.preferences.set("u1", { mutedMarketing: ["sms", "email"], quietHours: NIGHT });
    const r = await s.notifier.notify(sale());
    expect(statuses(r)).toBe("push:deferred sms:skipped(opted_out) email:skipped(opted_out)");
    return { ...s, id: r.id };
  }

  it("a late flush that lands in the NEXT night's quiet hours defers again instead of sending", async () => {
    const { notifier, clock, push, id } = await deferredPush();
    clock.set(Date.UTC(2026, 10, 24, 23, 0)); // next night
    expect(await notifier.flushDue()).toBe(0);
    expect(push.attempts).toHaveLength(0);
    const r = notifier.get(id)!;
    expect(r.deliveries[0]).toMatchObject({ status: "deferred", notBefore: Date.UTC(2026, 10, 25, 7, 0) });
    clock.set(Date.UTC(2026, 10, 25, 7, 0));
    expect(await notifier.flushDue()).toBe(1);
    expect(push.sent).toHaveLength(1);
  });

  it("muted after it was deferred -> skipped (opted_out), never sent", async () => {
    const { notifier, clock, preferences, push, id } = await deferredPush();
    preferences.set("u1", { mutedMarketing: ["sms", "email", "push"] });
    clock.set(Date.UTC(2026, 10, 24, 8, 0));
    expect(await notifier.flushDue()).toBe(0);
    expect(push.attempts).toHaveLength(0);
    expect(notifier.get(id)!.deliveries[0]).toMatchObject({ status: "skipped", skipReason: "opted_out" });
    expect(notificationStatus(notifier.get(id)!)).toBe("suppressed");
  });

  it("address changed meanwhile -> sent to the CURRENT address; address removed -> skipped (no_address)", async () => {
    const a = await deferredPush();
    a.users.upsert({ ...FULL_USER, pushToken: "tok-new" });
    a.clock.set(Date.UTC(2026, 10, 24, 8, 0));
    await a.notifier.flushDue();
    expect(a.push.sent.map((m) => m.to)).toEqual(["tok-new"]);

    const b = await deferredPush();
    b.users.upsert({ ...FULL_USER, pushToken: undefined });
    b.clock.set(Date.UTC(2026, 10, 24, 8, 0));
    expect(await b.notifier.flushDue()).toBe(0);
    expect(b.notifier.get(b.id)!.deliveries[0]).toMatchObject({ status: "skipped", skipReason: "no_address" });
    expect(b.notifier.get(b.id)!.deliveries[0]!.to).toBeUndefined();
  });
});

describe("errors mean nothing happened", () => {
  it.each([
    ["unknown type", { typeId: "nope" }, "UNKNOWN_TYPE"],
    ["unknown user", { userId: "nobody" }, "UNKNOWN_USER"],
    ["missing variable", { data: {} }, "TEMPLATE_VARIABLE_MISSING"],
    ["data not a plain object", { data: [] as never }, "INVALID_REQUEST"],
    ["data a class instance", { data: new Date() as never }, "INVALID_REQUEST"],
    ["empty key", { idempotencyKey: "  " }, "INVALID_REQUEST"],
    ["key too long", { idempotencyKey: "k".repeat(256) }, "INVALID_REQUEST"],
  ])("%s -> %s; no record, no send, and the key is still free", async (_name, patch, code) => {
    const { notifier, push, sms, email } = setup();
    const request = { ...otp(), ...patch };
    expect(await rejectCode(notifier.notify(request as never))).toBe(code);
    expect(notifier.list()).toEqual([]);
    expect(push.attempts.length + sms.attempts.length + email.attempts.length).toBe(0);
    if (request.idempotencyKey.trim() !== "" && request.idempotencyKey.length <= 255) {
      const ok = await notifier.notify({ ...otp(), idempotencyKey: request.idempotencyKey });
      expect(notificationStatus(ok)).toBe("delivered");
    }
  });

  it("a variable missing only from a channel the user would skip is still an error (validity does not depend on the user)", async () => {
    const { notifier } = setup({
      types: [{ ...ORDER, templates: { ...ORDER.templates, email: { subject: "x", body: "{{onlyEmail}}" } } }],
      users: [{ userId: "u1", pushToken: "t" }], // no email address
    });
    const request = { typeId: "order_shipped", userId: "u1", data: { orderId: "1" }, idempotencyKey: "o" };
    expect(await rejectCode(notifier.notify(request))).toBe("TEMPLATE_VARIABLE_MISSING");
  });

  it("a type channel without a sender -> NO_SENDER, even if this user has no address for it", async () => {
    const s = setup({ users: [{ userId: "u1", pushToken: "t" }] });
    const { Notifier } = await import("../src/notifier.js");
    const n = new Notifier({ catalog: s.catalog, users: s.users, preferences: s.preferences, senders: [new FakeSender("push")] });
    expect(await rejectCode(n.notify(otp()))).toBe("NO_SENDER");
    expect(n.list()).toEqual([]);
  });

  it("two senders for one channel are refused", async () => {
    const s = setup();
    const { Notifier } = await import("../src/notifier.js");
    expect(() => new Notifier({ ...s, senders: [new FakeSender("sms"), new FakeSender("sms")] })).toThrow(/two senders/);
  });

  it("records returned are copies: changing one does not change the notifier", async () => {
    const { notifier } = setup();
    const r = await notifier.notify(otp());
    r.deliveries[0]!.status = "failed";
    expect(notifier.get(r.id)!.deliveries[0]!.status).toBe("sent");
    expect(notifier.get("missing")).toBeUndefined();
    expect(notifier.getByKey("k1")?.id).toBe(r.id);
    expect(notifier.getByKey("nope")).toBeUndefined();
    expect(r.createdAt).toBe(T0);
  });
});
