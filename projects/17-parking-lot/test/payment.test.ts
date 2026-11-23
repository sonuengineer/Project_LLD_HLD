import { afterEach, describe, expect, it, vi } from "vitest";
import { FakePaymentGateway } from "../src/fake-gateway.js";
import { chargeWithRetry, type PaymentGateway } from "../src/payment.js";

const req = { idempotencyKey: "k1", amountMinor: 5000, reference: "t1" };
const fast = { retryDelayMs: 0 };
const signal = new AbortController().signal;

describe("FakePaymentGateway", () => {
  it("approves by default and records the charge", async () => {
    const g = new FakePaymentGateway();
    const { paymentId } = await g.charge(req, signal);
    expect(paymentId).toMatch(/^fake_/);
    expect(g.charges).toEqual([expect.objectContaining({ paymentId, amountMinor: 5000, reference: "t1" })]);
  });

  it("the same key returns the first payment and charges once", async () => {
    const g = new FakePaymentGateway();
    const a = await g.charge(req, signal);
    const b = await g.charge(req, signal);
    expect(b.paymentId).toBe(a.paymentId);
    expect(g.totalChargedMinor()).toBe(5000);
  });

  it("refuses a reused key with a different amount", async () => {
    const g = new FakePaymentGateway();
    await g.charge(req, signal);
    await expect(g.charge({ ...req, amountMinor: 1 }, signal)).rejects.toThrow(/different request/);
    expect(g.totalChargedMinor()).toBe(5000);
  });

  it("lose-response charges but answers with an error", async () => {
    const g = new FakePaymentGateway(["lose-response"]);
    await expect(g.charge(req, signal)).rejects.toThrow(/connection reset/);
    expect(g.totalChargedMinor()).toBe(5000);
  });

  it("rejects a zero or fractional amount", async () => {
    const g = new FakePaymentGateway();
    await expect(g.charge({ ...req, amountMinor: 0 }, signal)).rejects.toThrow(/invalid amount/);
    await expect(g.charge({ ...req, amountMinor: 1.5 }, signal)).rejects.toThrow(/invalid amount/);
  });
});

describe("chargeWithRetry", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the payment id on the first success", async () => {
    const g = new FakePaymentGateway();
    expect(await chargeWithRetry(g, req, fast)).toMatch(/^fake_/);
    expect(g.calls).toBe(1);
  });

  it("lost response, then a retry with the same key: one charge, the caller gets its id", async () => {
    const g = new FakePaymentGateway(["lose-response"]);
    const id = await chargeWithRetry(g, req, fast);
    expect(g.calls).toBe(2);
    expect(g.charges).toHaveLength(1);
    expect(g.charges[0]!.paymentId).toBe(id);
  });

  it("a decline is final: no retry, PAYMENT_DECLINED", async () => {
    const g = new FakePaymentGateway(["decline"]);
    await expect(chargeWithRetry(g, req, fast)).rejects.toMatchObject({ code: "PAYMENT_DECLINED" });
    expect(g.calls).toBe(1);
    expect(g.totalChargedMinor()).toBe(0);
  });

  it("transient failures are retried; all attempts failing is PAYMENT_UNKNOWN with the last cause", async () => {
    const g = new FakePaymentGateway(["fail", "fail", "fail"]);
    const e = await chargeWithRetry(g, req, { ...fast, attempts: 3 }).catch((x: unknown) => x);
    expect(e).toMatchObject({ code: "PAYMENT_UNKNOWN" });
    expect((e as Error).cause).toMatchObject({ message: "gateway unavailable" });
    expect(g.calls).toBe(3);
  });

  it("fail, fail, approve: succeeds on the third attempt", async () => {
    const g = new FakePaymentGateway(["fail", "fail", "approve"]);
    await chargeWithRetry(g, req, fast);
    expect(g.calls).toBe(3);
  });

  it("a hanging gateway is timed out and aborted, then retried", async () => {
    vi.useFakeTimers();
    const g = new FakePaymentGateway(["hang"]);
    const p = chargeWithRetry(g, req, { timeoutMs: 1000, retryDelayMs: 0 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await p).toMatch(/^fake_/);
    expect(g.calls).toBe(2);
    expect(g.charges).toHaveLength(1);
  });

  it("waits retryDelayMs between attempts", async () => {
    vi.useFakeTimers();
    const g = new FakePaymentGateway(["fail"]);
    const p = chargeWithRetry(g, req, { retryDelayMs: 200 });
    await vi.advanceTimersByTimeAsync(199);
    expect(g.calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(g.calls).toBe(2);
  });

  it("an answer without a payment id counts as a failure", async () => {
    let calls = 0;
    const g: PaymentGateway = { charge: async () => (calls++ === 0 ? ({} as { paymentId: string }) : { paymentId: "p1" }) };
    expect(await chargeWithRetry(g, req, fast)).toBe("p1");
  });
});
