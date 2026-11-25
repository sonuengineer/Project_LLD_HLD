// Randomized, stage 2: three workers on one queue, random provider answers (sent / retryable / permanent / throw),
// duplicates, workers that die holding jobs, the clock jumping around quiet windows. Rules are checked at the moment
// of every provider call (re-computed here, not taken from src/), and the end state is checked once everything has
// drained.
import { describe, expect, it } from "vitest";
import { exponentialBackoff } from "resilience-kit";
import { notificationStatus } from "../src/record.js";
import type { Preferences } from "../src/preferences.js";
import { CHANNELS, type Channel, type OutboundMessage, type Recipient, type SendResult } from "../src/types.js";
import { Worker } from "../src/worker.js";
import { MIN } from "./helpers.js";
import { setupQueued } from "./queued-helpers.js";

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
const MAX_ATTEMPTS = 3;
const KEY_TTL_MS = 24 * 3_600_000; // QueuedNotifier's default

describe("randomized invariants, queued", () => {
  for (const seed of [11, 12, 13, 14, 15, 16]) {
    it(`seed ${seed}: 250 requests, 3 workers, dying workers, the rules hold`, async () => {
      const rand = prng(seed);
      const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!;

      const users: Recipient[] = [];
      const prefsOf = new Map<string, Preferences>();
      for (let i = 0; i < 10; i++) {
        const u: Recipient = { userId: `u${i}`, utcOffsetMinutes: pick([-300, 0, 330, 600]) };
        if (rand() < 0.8) u.email = `u${i}@example.test`;
        if (rand() < 0.6) u.phone = `+1000000${i}`;
        if (rand() < 0.6) u.pushTokens = [`tok-${i}`];
        users.push(u);
        const p: Preferences = { mutedMarketing: CHANNELS.filter(() => rand() < 0.3) };
        if (rand() < 0.6) {
          const start = Math.floor(rand() * 96) * 15;
          let end = Math.floor(rand() * 96) * 15;
          if (end === start) end = (start + 60) % 1440;
          p.quietHours = { start: HHMM(start), end: HHMM(end) };
        }
        prefsOf.set(u.userId, p);
      }
      const s = setupQueued({
        users,
        retry: { maxAttempts: MAX_ATTEMPTS, backoff: exponentialBackoff({ initialMs: 30_000, maxMs: 600_000, jitter: "full" }) },
        random: rand,
        leaseMs: 60_000,
      });
      for (const [id, p] of prefsOf) s.preferences.set(id, p);
      const userById = new Map(users.map((u) => [u.userId, u]));

      const violations: string[] = [];
      const successes = new Map<string, number>(); // provider idempotency key -> successful sends
      const outcome = (m: OutboundMessage): SendResult => {
        const rec = s.notifier.get(m.notificationId)!;
        const user = userById.get(rec.userId)!;
        const prefs = prefsOf.get(rec.userId)!;
        if (m.to !== ADDRESS(user, m.channel)) violations.push(`wrong address ${m.channel}`);
        if (m.idempotencyKey !== (m.channel === "push" ? `${rec.id}:push:${m.to}` : `${rec.id}:${m.channel}`)) violations.push("wrong provider idempotency key");
        if (rec.category === "marketing") {
          if (prefs.mutedMarketing.includes(m.channel)) violations.push(`muted ${m.channel} sent`);
          if (m.channel !== "email" && inQuiet(s.clock.now(), user.utcOffsetMinutes ?? 0, prefs)) {
            violations.push(`${m.channel} sent in quiet hours`);
          }
        }
        if (rec.mode === "first" && rec.deliveries.some((d) => d.status === "sent")) violations.push("first: send after success");
        const r = rand();
        if (r < 0.2) return { status: "failed", retryable: true, reason: "503" };
        if (r < 0.25) return { status: "failed", retryable: false, reason: "invalid" };
        if (r < 0.3) throw new Error("boom");
        successes.set(m.idempotencyKey, (successes.get(m.idempotencyKey) ?? 0) + 1);
        return { status: "sent", providerId: `p-${m.idempotencyKey}` };
      };
      for (const sender of [s.push, s.sms, s.email]) sender.willAnswer(...Array.from({ length: 3000 }, () => outcome));

      const workers = [1, 2, 4].map((c) => new Worker(s.notifier, { concurrency: c }));
      const requests: { key: string; request: { typeId: string; userId: string; data: Record<string, unknown> } }[] = [];
      const keySetAt = new Map<string, number>();
      let expectedRecords = 0;
      let dropped = 0;
      for (let i = 0; i < 250; i++) {
        s.clock.advance(Math.floor(rand() * 20) * MIN);
        const roll = rand();
        if (requests.length > 0 && roll < 0.1) {
          const old = pick(requests);
          // A client retry: the same record within the key's 24 h TTL, a NEW notification after it (documented).
          if (s.clock.now() - keySetAt.get(old.key)! >= KEY_TTL_MS) {
            expectedRecords++;
            keySetAt.set(old.key, s.clock.now());
          }
          s.notifier.notify({ ...old.request, idempotencyKey: old.key });
        } else {
          const request = {
            typeId: pick(TYPES),
            userId: pick(users).userId,
            data: { code: String(i), orderId: `o${i}`, user: { name: "N" }, pct: i % 50 },
          };
          requests.push({ key: `key-${i}`, request });
          keySetAt.set(`key-${i}`, s.clock.now());
          expectedRecords++;
          s.notifier.notify({ ...request, idempotencyKey: `key-${i}` });
        }
        const action = rand();
        if (action < 0.08) dropped += s.notifier.claim(1 + Math.floor(rand() * 3)).length; // a worker dies holding these
        else if (action < 0.7) await pick(workers).runOnce();
      }
      // Drain: every 15 minutes for 3 days, all workers until idle (leases of dead workers run out on the way).
      for (let q = 0; q < 3 * 24 * 4; q++) {
        s.clock.advance(15 * MIN);
        while ((await Promise.all(workers.map((w) => w.runOnce()))).some((n) => n > 0)) {
          // until every worker is idle at this time
        }
      }

      expect(violations).toEqual([]);
      expect(s.queue.size).toBe(0);
      if (dropped > 0) expect(s.queue.stats.reclaimed).toBeGreaterThanOrEqual(dropped);
      const records = s.notifier.list();
      expect(records).toHaveLength(expectedRecords);
      let attempts = 0;
      for (const r of records) {
        expect(["delivered", "failed", "suppressed"]).toContain(notificationStatus(r));
        if (r.mode === "first") expect(r.deliveries.filter((d) => d.status === "sent").length).toBeLessThanOrEqual(1);
        for (const d of r.deliveries) {
          attempts += d.attempts;
          expect(d.attempts).toBeLessThanOrEqual(MAX_ATTEMPTS);
          if (d.status === "failed") {
            // failed only for a reason: permanent, attempts used up, or failed over from an open circuit
            expect(d.retryable === false || d.attempts === MAX_ATTEMPTS || d.error === "circuit open").toBe(true);
          }
          if (d.status === "sent") expect(successes.get(d.channel === "push" ? `${r.id}:push:${d.to}` : `${r.id}:${d.channel}`)).toBe(1); // dead workers never sent
        }
      }
      expect(s.push.attempts.length + s.sms.attempts.length + s.email.attempts.length).toBe(attempts);
      expect([...successes.values()].every((n) => n === 1)).toBe(true);
    });
  }
});
