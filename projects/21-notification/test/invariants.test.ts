// Randomized: many users, preferences, times, duplicate keys and provider failures. The rules are re-computed here
// independently of src/policy.ts (Date arithmetic instead of modulo), and every send is checked AT THE MOMENT the
// fake provider is called.
import { describe, expect, it } from "vitest";
import { notificationStatus, type NotificationRecord } from "../src/notifier.js";
import type { Preferences } from "../src/preferences.js";
import { CHANNELS, type Channel, type OutboundMessage, type Recipient, type SendResult } from "../src/types.js";
import { MIN, setup } from "./helpers.js";

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

const HHMM = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

function inQuiet(now: number, offset: number, prefs: Preferences): boolean {
  if (!prefs.quietHours) return false;
  const d = new Date(now + offset * MIN);
  const m = d.getUTCHours() * 60 + d.getUTCMinutes();
  const [sh, sm] = prefs.quietHours.start.split(":").map(Number);
  const [eh, em] = prefs.quietHours.end.split(":").map(Number);
  const s = sh! * 60 + sm!;
  const e = eh! * 60 + em!;
  return s < e ? m >= s && m < e : m >= s || m < e;
}

const ADDRESS = (user: Recipient, channel: Channel): string | undefined =>
  channel === "email" ? user.email : channel === "sms" ? user.phone : user.pushTokens?.[0];
const TYPES = ["otp", "order_shipped", "sale", "promo_first"] as const;

describe("randomized invariants", () => {
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    it(`seed ${seed}: 300 requests, the rules hold at every send`, async () => {
      const rand = prng(seed);
      const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!;

      const users: Recipient[] = [];
      const prefsOf = new Map<string, Preferences>();
      for (let i = 0; i < 12; i++) {
        const u: Recipient = { userId: `u${i}`, utcOffsetMinutes: pick([-300, 0, 60, 330, 345, 600]) };
        if (rand() < 0.8) u.email = `u${i}@example.test`;
        if (rand() < 0.6) u.phone = `+1000000${i}`;
        if (rand() < 0.6) u.pushTokens = [`tok-${i}`];
        users.push(u);
        const p: Preferences = { mutedMarketing: CHANNELS.filter(() => rand() < 0.3) };
        if (rand() < 0.6) {
          const start = Math.floor(rand() * 24 * 4) * 15;
          let end = Math.floor(rand() * 24 * 4) * 15;
          if (end === start) end = (start + 60) % 1440;
          p.quietHours = { start: HHMM(start), end: HHMM(end) };
        }
        prefsOf.set(u.userId, p);
      }
      const s = setup({ users });
      for (const [id, p] of prefsOf) s.preferences.set(id, p);
      const userById = new Map(users.map((u) => [u.userId, u]));
      const typeOf = (typeId: string) => s.catalog.get(typeId)!;

      // Every provider call is checked here, at the time it happens.
      const violations: string[] = [];
      const recordOfMsg = (m: OutboundMessage) => s.notifier.get(m.notificationId)!;
      const outcome = (m: OutboundMessage): SendResult => {
        const rec = recordOfMsg(m);
        const user = userById.get(rec.userId)!;
        const prefs = prefsOf.get(rec.userId)!;
        if (m.to !== ADDRESS(user, m.channel)) violations.push(`wrong address ${m.channel}`);
        if (rec.category === "marketing") {
          if (prefs.mutedMarketing.includes(m.channel)) violations.push(`muted ${m.channel} sent`);
          if (m.channel !== "email" && inQuiet(s.clock.now(), user.utcOffsetMinutes ?? 0, prefs)) {
            violations.push(`${m.channel} sent in quiet hours`);
          }
        }
        if (rec.mode === "first" && rec.deliveries.some((d) => d.status === "sent")) {
          violations.push("first mode: a send after a success");
        }
        const r = rand();
        if (r < 0.15) return { status: "failed", retryable: rand() < 0.5, reason: "random" };
        if (r < 0.2) throw new Error("random throw");
        return { status: "sent", providerId: `p-${m.channel}` };
      };
      for (const sender of [s.push, s.sms, s.email]) {
        sender.willAnswer(...Array.from({ length: 2000 }, () => outcome));
      }

      const keys: { key: string; request: { typeId: string; userId: string; data: Record<string, unknown> } }[] = [];
      const pending: Promise<NotificationRecord>[] = [];
      for (let i = 0; i < 300; i++) {
        s.clock.advance(Math.floor(rand() * 40) * MIN);
        if (keys.length > 0 && rand() < 0.15) {
          const old = pick(keys); // a retry of an earlier request
          pending.push(s.notifier.notify({ ...old.request, idempotencyKey: old.key }));
        } else {
          const typeId = pick(TYPES);
          const data = { code: String(i), orderId: `o${i}`, user: { name: "N" }, pct: i % 50 };
          const request = { typeId, userId: pick(users).userId, data };
          const key = `key-${i}`;
          keys.push({ key, request });
          pending.push(s.notifier.notify({ ...request, idempotencyKey: key }));
        }
        if (rand() < 0.3) await Promise.all(pending.splice(0));
        if (rand() < 0.2) await s.notifier.flushDue();
      }
      await Promise.all(pending);
      // Flushes every 15 minutes for two days. Windows and offsets are multiples of 15 minutes, so even a 23h45m
      // window's 15-minute gap gets a flush (hourly flushes can miss such a gap forever -- seed 5 did).
      for (let q = 0; q < 2 * 24 * 4; q++) {
        s.clock.advance(15 * MIN);
        await s.notifier.flushDue();
      }

      expect(violations).toEqual([]);
      const records = s.notifier.list();
      expect(records).toHaveLength(keys.length); // one record per key, duplicates made none
      expect(new Set(records.map((r) => r.idempotencyKey)).size).toBe(keys.length);

      let sentDeliveries = 0;
      let attemptsInRecords = 0;
      for (const r of records) {
        const user = userById.get(r.userId)!;
        const prefs = prefsOf.get(r.userId)!;
        const type = typeOf(r.typeId);
        expect(r.deliveries.map((d) => d.channel)).toEqual(type.channels);
        expect(["delivered", "failed", "suppressed"]).toContain(notificationStatus(r)); // nothing left waiting
        for (const d of r.deliveries) {
          expect(d.attempts).toBeLessThanOrEqual(1);
          attemptsInRecords += d.attempts;
          if (d.status === "sent") sentDeliveries++;
          const hasAddress = Boolean(ADDRESS(user, d.channel)?.trim());
          expect(d.skipReason === "no_address").toBe(!hasAddress);
          const muted = r.category === "marketing" && hasAddress && prefs.mutedMarketing.includes(d.channel);
          expect(d.skipReason === "opted_out").toBe(muted);
        }
        if (r.mode === "first") expect(r.deliveries.filter((d) => d.status === "sent").length).toBeLessThanOrEqual(1);
      }
      const providerAttempts = s.push.attempts.length + s.sms.attempts.length + s.email.attempts.length;
      expect(providerAttempts).toBe(attemptsInRecords);
      expect(s.push.sent.length + s.sms.sent.length + s.email.sent.length).toBe(sentDeliveries);
    });
  }
});
