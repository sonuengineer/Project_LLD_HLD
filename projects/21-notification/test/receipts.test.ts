// Delivery receipts: the merge rule, webhook signatures, and the QueuedNotifier side (applied / unchanged / parked).
import { describe, expect, it } from "vitest";
import { mergeReceipt, signWebhook, verifyWebhook, type Receipt, type ReceiptEvent } from "../src/receipts.js";
import { notificationStatus } from "../src/record.js";
import { T0 } from "./helpers.js";
import { orderReq, otpReq, setupQueued } from "./queued-helpers.js";

const SECRET = "whsec-0123456789abcdef";
const d = (at: number): Receipt => ({ event: "delivered", at });
const b = (at: number): Receipt => ({ event: "bounced", at });

function prng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("mergeReceipt", () => {
  it("bounced outranks delivered in either order; a tie keeps the earlier time; merging twice changes nothing", () => {
    expect(mergeReceipt(d(5), b(9))).toEqual(b(9));
    expect(mergeReceipt(b(9), d(5))).toEqual(b(9)); // a late "delivered" never undoes a bounce
    expect(mergeReceipt(d(5), d(3))).toEqual(d(3));
    expect(mergeReceipt(d(3), d(5))).toEqual(d(3));
    expect(mergeReceipt(undefined, d(1))).toEqual(d(1));
    const x = d(7);
    expect(mergeReceipt(x, d(7))).toBe(x); // unchanged returns the SAME object (that is how "unchanged" is detected)
  });

  it("randomized: any order and any duplicates of the same events give the same result (the maximum)", () => {
    const rand = prng(42);
    for (let round = 0; round < 300; round++) {
      const events: Receipt[] = Array.from({ length: 1 + Math.floor(rand() * 6) }, () => ({
        event: (rand() < 0.5 ? "delivered" : "bounced") as ReceiptEvent,
        at: Math.floor(rand() * 5),
      }));
      // Independent answer: bounced if any bounce, the earliest time among the winning event.
      const winner: ReceiptEvent = events.some((e) => e.event === "bounced") ? "bounced" : "delivered";
      const expected = { event: winner, at: Math.min(...events.filter((e) => e.event === winner).map((e) => e.at)) };
      for (let shuffle = 0; shuffle < 5; shuffle++) {
        const withDuplicates = [...events, ...events.filter(() => rand() < 0.5)].sort(() => rand() - 0.5);
        expect(withDuplicates.reduce<Receipt | undefined>((acc, e) => mergeReceipt(acc, e), undefined)).toEqual(expected);
      }
    }
  });
});

describe("webhook signatures", () => {
  const body = Buffer.from('{"providerId":"p1","event":"delivered","occurredAt":1}');

  it("a correct signature verifies; a wrong secret, a changed body or a changed timestamp does not", () => {
    const header = signWebhook(SECRET, body, T0);
    expect(verifyWebhook(SECRET, header, body, T0)).toBe(true);
    expect(verifyWebhook(`${SECRET}x`, header, body, T0)).toBe(false);
    expect(verifyWebhook(SECRET, header, Buffer.from(body.toString().replace("delivered", "bounced")), T0)).toBe(false);
    const t = Math.floor(T0 / 1000);
    expect(verifyWebhook(SECRET, header.replace(`t=${t}`, `t=${t + 1}`), body, T0)).toBe(false); // the time is signed too
  });

  it("timestamps: up to 5 minutes either way is accepted, beyond is refused (replays, clocks far off)", () => {
    const header = signWebhook(SECRET, body, T0);
    expect(verifyWebhook(SECRET, header, body, T0 + 5 * 60_000)).toBe(true);
    expect(verifyWebhook(SECRET, header, body, T0 + 5 * 60_000 + 1)).toBe(false);
    expect(verifyWebhook(SECRET, header, body, T0 - 5 * 60_000)).toBe(true);
    expect(verifyWebhook(SECRET, header, body, T0 - 5 * 60_000 - 1)).toBe(false);
  });

  it("malformed headers are refused, not thrown on", () => {
    const good = signWebhook(SECRET, body, T0);
    for (const header of [undefined, "", "t=1", `v1=${"a".repeat(64)}`, good.replace("v1=", "v2="), `${good},x=1`, good.slice(0, -2), ` ${good}`]) {
      expect(verifyWebhook(SECRET, header, body, T0)).toBe(false);
    }
  });
});

describe("QueuedNotifier.applyReceipt", () => {
  async function sentOrder() {
    const s = setupQueued();
    const r = s.notifier.notify(orderReq()); // push + email, "all"
    await s.worker.drain();
    const pushId = s.notifier.get(r.id)!.deliveries[0]!.providerId!;
    return { ...s, id: r.id, pushId };
  }

  it("after the send: applied; the same again unchanged; a late delivered after a bounce unchanged", async () => {
    const { notifier, id, pushId } = await sentOrder();
    expect(notifier.applyReceipt("push", pushId, d(T0 + 1))).toBe("applied");
    expect(notifier.applyReceipt("push", pushId, d(T0 + 1))).toBe("unchanged");
    expect(notifier.applyReceipt("push", pushId, b(T0 + 5))).toBe("applied");
    expect(notifier.applyReceipt("push", pushId, d(T0 + 9))).toBe("unchanged");
    expect(notifier.get(id)!.deliveries[0]!.receipt).toEqual(b(T0 + 5));
    expect(notifier.stats).toMatchObject({ receiptsApplied: 2, receiptsUnchanged: 2, receiptsParked: 0 });
  });

  it("a bounce makes the notification failed unless another channel still counts as delivered", async () => {
    const { notifier, id, pushId } = await sentOrder();
    const emailId = notifier.get(id)!.deliveries[1]!.providerId!;
    notifier.applyReceipt("push", pushId, b(T0));
    expect(notificationStatus(notifier.get(id)!)).toBe("delivered"); // email was sent and did not bounce
    notifier.applyReceipt("email", emailId, b(T0));
    expect(notificationStatus(notifier.get(id)!)).toBe("failed");
  });

  it("the channel is part of the key: the same provider id on another channel is a different message", async () => {
    const { notifier, id, pushId } = await sentOrder();
    expect(notifier.applyReceipt("sms", pushId, d(T0))).toBe("parked");
    expect(notifier.get(id)!.deliveries[0]).not.toHaveProperty("receipt");
  });

  it("a receipt that beats the send result is parked, then applied when the send is recorded", async () => {
    const { notifier, worker, push } = setupQueued();
    const r = notifier.notify(otpReq());
    // The provider will answer with this id; its webhook arrives before our worker has recorded the answer.
    push.willAnswer(() => {
      expect(notifier.applyReceipt("push", "early-1", b(T0 + 2))).toBe("parked");
      expect(notifier.applyReceipt("push", "early-1", d(T0 + 1))).toBe("parked"); // merged, not overwritten: still bounced
      return { status: "sent", providerId: "early-1" };
    });
    await worker.drain();
    expect(notifier.get(r.id)!.deliveries[0]!.receipt).toEqual(b(T0 + 2));
    expect(notifier.applyReceipt("push", "early-1", d(T0 + 3))).toBe("unchanged"); // no longer parked
    expect(notifier.stats).toMatchObject({ receiptsParked: 2, receiptsApplied: 1 });
  });

  it("an unknown id stays parked only for the TTL", async () => {
    const { notifier, worker, push, clock } = setupQueued({ receipts: { parkTtlMs: 60_000 } });
    notifier.applyReceipt("push", "late-1", d(T0));
    clock.advance(60_001);
    push.willAnswer({ status: "sent", providerId: "late-1" });
    const r = notifier.notify(otpReq());
    await worker.drain();
    expect(notifier.get(r.id)!.deliveries[0]).not.toHaveProperty("receipt");
  });
});
