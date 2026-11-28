// Randomized: many posts, many channels, a mix of succeeding/flaky/failing providers and cancellations, across
// several seeds and many tick() calls with the clock advancing. Every step is awaited in turn (this project has
// no concurrent callers in stage 1), so this proves the sequential rules hold over a long random run, not a
// specific hand-picked scenario.
import { describe, expect, it } from "vitest";
import { ManualClock } from "../src/clock.js";
import { AlwaysFailsProvider, AlwaysSucceedsProvider, FlakyProvider } from "../src/providers.js";
import { SocialScheduler } from "../src/scheduler.js";
import type { ScheduledPost } from "../src/types.js";

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

const NOW = Date.UTC(2026, 10, 28, 9, 0);
const CHANNELS = ["alpha", "beta", "gamma"] as const; // always-succeeds, flaky(2), always-fails

// Advances the clock to each pending channel's next due time and ticks, until nothing is pending anymore (every
// channel has reached sent/dead_letter/canceled) or the round budget runs out. maxAttempts is finite, so every
// channel not canceled along the way is guaranteed to reach a terminal state within a bounded number of rounds.
async function settle(scheduler: SocialScheduler, clock: ManualClock, maxRounds = 200): Promise<void> {
  for (let round = 0; round < maxRounds; round++) {
    const posts = scheduler.list();
    let nextDue = Infinity;
    let anyPending = false;
    for (const post of posts) {
      for (const delivery of Object.values(post.deliveries)) {
        if (delivery.status === "pending") {
          anyPending = true;
          nextDue = Math.min(nextDue, delivery.nextAttemptAt);
        }
      }
    }
    if (!anyPending) return;
    if (nextDue > clock.now()) clock.advance(nextDue - clock.now());
    await scheduler.tick();
  }
}

for (const seed of [1, 2, 3, 4, 5]) {
  it(`seed ${seed}: many posts and channels, mixed providers and cancellations, every channel ends consistent`, async () => {
    const rand = prng(seed);
    const clock = new ManualClock(NOW);
    const alpha = new AlwaysSucceedsProvider();
    const beta = new FlakyProvider(2);
    const gamma = new AlwaysFailsProvider();
    const scheduler = new SocialScheduler({
      providers: { alpha, beta, gamma },
      clock,
      maxAttempts: 3,
      initialBackoffMs: 500,
      maxBackoffMs: 4000,
    });

    const postIds: string[] = [];
    let counter = 0;

    for (let step = 0; step < 250; step++) {
      const action = rand();

      if (action < 0.45 || postIds.length === 0) {
        // Schedule a new post targeting a random non-empty subset of the 3 channels.
        const channels = CHANNELS.filter(() => rand() < 0.6);
        const finalChannels = channels.length > 0 ? channels : [CHANNELS[Math.floor(rand() * CHANNELS.length)]!];
        const scheduledAt = clock.now() + Math.floor(rand() * 4000);
        const post = scheduler.schedulePost({
          clientRequestId: `req-${++counter}`,
          content: `post body ${counter}`,
          channels: [...new Set(finalChannels)],
          scheduledAt,
        });
        postIds.push(post.id);
      } else if (action < 0.6) {
        // Cancel one random pending channel of a random existing post (ignore if none pending right now).
        const postId = postIds[Math.floor(rand() * postIds.length)]!;
        const post = scheduler.getPost(postId);
        if (post) {
          const pending = Object.values(post.deliveries).filter((d) => d.status === "pending");
          if (pending.length > 0) {
            const target = pending[Math.floor(rand() * pending.length)]!;
            const after = scheduler.cancelChannel(postId, target.channel);
            expect(after.deliveries[target.channel]!.status).toBe("canceled");
          }
        }
      } else if (action < 0.7) {
        // Cancel the whole post, if anything on it is still pending.
        const postId = postIds[Math.floor(rand() * postIds.length)]!;
        const post = scheduler.getPost(postId);
        if (post && Object.values(post.deliveries).some((d) => d.status === "pending")) {
          scheduler.cancelPost(postId);
        }
      } else {
        // Advance the clock a little and tick.
        clock.advance(Math.floor(rand() * 1500));
        await scheduler.tick();
      }
    }

    await settle(scheduler, clock);

    // Snapshot every channel's terminal attempts/status, then run the clock far forward with more ticks: nothing
    // that already reached a terminal state may ever change again, and a terminal channel's provider must never
    // be called again (attempts frozen).
    const before: { postId: string; channel: string; status: string; attempts: number }[] = [];
    for (const post of scheduler.list()) {
      for (const delivery of Object.values(post.deliveries)) {
        expect(["pending", "sent", "dead_letter", "canceled"]).toContain(delivery.status);
        if (delivery.status !== "pending") before.push({ postId: post.id, channel: delivery.channel, status: delivery.status, attempts: delivery.attempts });
      }
    }

    clock.advance(10 * 60 * 60_000);
    for (let i = 0; i < 5; i++) await scheduler.tick();

    for (const snap of before) {
      const after = scheduler.getPost(snap.postId)!.deliveries[snap.channel]!;
      expect(after.status).toBe(snap.status); // never changes once terminal
      expect(after.attempts).toBe(snap.attempts); // the provider was never called again
    }

    // Every post still has exactly one delivery per channel it was scheduled on, and no stray ones.
    for (const post of scheduler.list()) {
      expect(Object.keys(post.deliveries).sort()).toEqual([...post.channels].sort());
    }

    // After settle(), every channel that is not canceled is terminal (sent or dead_letter): maxAttempts is finite,
    // so nothing but an explicit cancel can leave a channel pending forever.
    for (const post of scheduler.list()) {
      for (const delivery of Object.values(post.deliveries)) {
        expect(delivery.status).not.toBe("pending");
      }
    }

    // A channel that is "sent" always carries a providerId and sentAt; "dead_letter" always carries a lastError
    // and used up every attempt; "canceled" always carries canceledAt.
    function checkPost(post: ScheduledPost) {
      for (const d of Object.values(post.deliveries)) {
        if (d.status === "sent") {
          expect(d.providerId).toBeTruthy();
          expect(d.sentAt).toBeDefined();
        } else if (d.status === "dead_letter") {
          expect(d.lastError).toBeTruthy();
          expect(d.attempts).toBe(d.maxAttempts);
        } else if (d.status === "canceled") {
          expect(d.canceledAt).toBeDefined();
        }
      }
    }
    for (const post of scheduler.list()) checkPost(post);
  });
}
