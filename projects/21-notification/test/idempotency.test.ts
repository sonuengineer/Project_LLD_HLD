import { describe, expect, it } from "vitest";
import { gate, rejectCode, setup } from "./helpers.js";

const otp = (key = "k1", code = "123456") => ({ typeId: "otp", userId: "u1", data: { code }, idempotencyKey: key });

describe("idempotency", () => {
  it("a retried request returns the same record and sends nothing more", async () => {
    const { notifier, push } = setup();
    const a = await notifier.notify(otp());
    const b = await notifier.notify(otp());
    expect(b).toEqual(a);
    expect(push.attempts).toHaveLength(1);
    expect(notifier.list()).toHaveLength(1);
  });

  it("20 concurrent identical requests while the provider is slow: one record, one send, all get the final record", async () => {
    const { notifier, push } = setup();
    const slow = gate<{ status: "sent"; providerId: string }>();
    push.willAnswer(() => slow.promise);
    const calls = Array.from({ length: 20 }, () => notifier.notify(otp()));
    slow.resolve({ status: "sent", providerId: "p-1" });
    const results = await Promise.all(calls);
    expect(push.attempts).toHaveLength(1);
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(results.every((r) => r.deliveries[0]!.status === "sent")).toBe(true);
  });

  it("key order inside data does not matter", async () => {
    const { notifier, email } = setup();
    const data1 = { orderId: "1", user: { name: "A", tier: "gold" } };
    const data2 = { user: { tier: "gold", name: "A" }, orderId: "1" };
    await notifier.notify({ typeId: "order_shipped", userId: "u1", data: data1, idempotencyKey: "o" });
    await notifier.notify({ typeId: "order_shipped", userId: "u1", data: data2, idempotencyKey: "o" });
    expect(email.attempts).toHaveLength(1);
  });

  it("same key, different request -> IDEMPOTENCY_CONFLICT; the original is untouched", async () => {
    const { notifier, push } = setup();
    const a = await notifier.notify(otp("k1", "111111"));
    expect(await rejectCode(notifier.notify(otp("k1", "222222")))).toBe("IDEMPOTENCY_CONFLICT");
    expect(await rejectCode(notifier.notify({ ...otp("k1", "111111"), userId: "u2" }))).toBe("IDEMPOTENCY_CONFLICT");
    expect(await rejectCode(notifier.notify({ ...otp("k1", "111111"), typeId: "order_shipped" }))).toBe("IDEMPOTENCY_CONFLICT");
    expect(notifier.list()).toEqual([a]);
    expect(push.attempts).toHaveLength(1);
  });

  it("a conflicting request while the original is still sending is refused too", async () => {
    const { notifier, push } = setup();
    const slow = gate<{ status: "sent"; providerId: string }>();
    push.willAnswer(() => slow.promise);
    const first = notifier.notify(otp("k1", "111111"));
    expect(await rejectCode(notifier.notify(otp("k1", "222222")))).toBe("IDEMPOTENCY_CONFLICT");
    slow.resolve({ status: "sent", providerId: "p" });
    await first;
    expect(push.attempts.map((m) => m.body)).toEqual(["Code 111111"]);
  });

  it("different keys are different notifications, even with the same content", async () => {
    const { notifier, push } = setup();
    await notifier.notify(otp("k1"));
    await notifier.notify(otp("k2"));
    expect(push.attempts).toHaveLength(2);
  });

  it("a duplicate of a FAILED notification does not resend (retrying a failure is stage 2's job, not the key's)", async () => {
    const { notifier, push, sms, email } = setup();
    for (const s of [push, sms, email]) s.willAnswer({ status: "failed", retryable: true, reason: "down" });
    await notifier.notify(otp());
    const again = await notifier.notify(otp());
    expect(again.deliveries.every((d) => d.status === "failed")).toBe(true);
    expect(push.attempts.length + sms.attempts.length + email.attempts.length).toBe(3);
  });
});
