import { describe, expect, it } from "vitest";
import { ManualClock } from "../src/clock.js";
import { AlwaysFailsProvider, AlwaysSucceedsProvider, FlakyProvider } from "../src/providers.js";
import { SocialScheduler } from "../src/scheduler.js";

const NOW = Date.UTC(2026, 10, 28, 9, 0);

describe("due detection", () => {
  it("a post scheduled 5 minutes in the future does not dispatch on a tick() now", async () => {
    const clock = new ManualClock(NOW);
    const linkedin = new AlwaysSucceedsProvider();
    const scheduler = new SocialScheduler({ providers: { linkedin }, clock });
    const post = scheduler.schedulePost({ clientRequestId: "r1", content: "hi", channels: ["linkedin"], scheduledAt: NOW + 5 * 60_000 });

    const attempted = await scheduler.tick();
    expect(attempted).toBe(0);
    expect(linkedin.attempts).toHaveLength(0);
    expect(scheduler.getPost(post.id)!.deliveries.linkedin!.status).toBe("pending");
  });

  it("dispatches once the clock passes scheduledAt", async () => {
    const clock = new ManualClock(NOW);
    const linkedin = new AlwaysSucceedsProvider();
    const scheduler = new SocialScheduler({ providers: { linkedin }, clock });
    const post = scheduler.schedulePost({ clientRequestId: "r1", content: "hi", channels: ["linkedin"], scheduledAt: NOW + 5 * 60_000 });

    clock.advance(5 * 60_000 + 1);
    const attempted = await scheduler.tick();
    expect(attempted).toBe(1);
    expect(linkedin.attempts).toHaveLength(1);
    const delivery = scheduler.getPost(post.id)!.deliveries.linkedin!;
    expect(delivery.status).toBe("sent");
    expect(delivery.sentAt).toBe(clock.now());
    expect(delivery.providerId).toBeTruthy();
  });

  it("dispatches exactly at scheduledAt (inclusive boundary)", async () => {
    const clock = new ManualClock(NOW);
    const linkedin = new AlwaysSucceedsProvider();
    const scheduler = new SocialScheduler({ providers: { linkedin }, clock });
    scheduler.schedulePost({ clientRequestId: "r1", content: "hi", channels: ["linkedin"], scheduledAt: NOW + 1000 });
    clock.advance(1000);
    expect(await scheduler.tick()).toBe(1);
  });

  it("a second tick() does not re-dispatch an already-sent channel", async () => {
    const clock = new ManualClock(NOW);
    const linkedin = new AlwaysSucceedsProvider();
    const scheduler = new SocialScheduler({ providers: { linkedin }, clock });
    scheduler.schedulePost({ clientRequestId: "r1", content: "hi", channels: ["linkedin"], scheduledAt: NOW });
    await scheduler.tick();
    const attempted = await scheduler.tick();
    expect(attempted).toBe(0);
    expect(linkedin.attempts).toHaveLength(1);
  });
});

describe("per-channel independence", () => {
  it("one channel succeeds while another fails-then-retries-then-succeeds, independently", async () => {
    const clock = new ManualClock(NOW);
    const linkedin = new AlwaysSucceedsProvider();
    const twitter = new FlakyProvider(2);
    const scheduler = new SocialScheduler({ providers: { linkedin, twitter }, clock, maxAttempts: 5, initialBackoffMs: 1000, maxBackoffMs: 60_000 });
    const post = scheduler.schedulePost({ clientRequestId: "r1", content: "hi", channels: ["linkedin", "twitter"], scheduledAt: NOW });

    await scheduler.tick(); // attempt 1 for both
    let p = scheduler.getPost(post.id)!;
    expect(p.deliveries.linkedin!.status).toBe("sent");
    expect(p.deliveries.twitter!.status).toBe("pending");
    expect(p.deliveries.twitter!.attempts).toBe(1);

    clock.advance(1000 + 1); // backoff for attempt 1 is 1000ms
    await scheduler.tick(); // attempt 2 for twitter only (linkedin already sent, not due)
    p = scheduler.getPost(post.id)!;
    expect(p.deliveries.linkedin!.attempts).toBe(1); // untouched by twitter's retries
    expect(p.deliveries.twitter!.status).toBe("pending");
    expect(p.deliveries.twitter!.attempts).toBe(2);

    clock.advance(2000 + 1); // backoff for attempt 2 is 2000ms
    await scheduler.tick(); // attempt 3 for twitter succeeds
    p = scheduler.getPost(post.id)!;
    expect(p.deliveries.twitter!.status).toBe("sent");
    expect(p.deliveries.linkedin!.attempts).toBe(1);
  });

  it("a failing channel never blocks or affects another channel's dispatch in the same tick", async () => {
    const clock = new ManualClock(NOW);
    const linkedin = new AlwaysSucceedsProvider();
    const mastodon = new AlwaysFailsProvider();
    const scheduler = new SocialScheduler({ providers: { linkedin, mastodon }, clock });
    const post = scheduler.schedulePost({ clientRequestId: "r1", content: "hi", channels: ["linkedin", "mastodon"], scheduledAt: NOW });

    await scheduler.tick();
    const p = scheduler.getPost(post.id)!;
    expect(p.deliveries.linkedin!.status).toBe("sent");
    expect(p.deliveries.mastodon!.status).toBe("pending");
    expect(p.deliveries.mastodon!.lastError).toBeTruthy();
  });

  it("a provider that throws is treated as a failed attempt, not a crash, and does not affect other channels", async () => {
    const clock = new ManualClock(NOW);
    const linkedin = new AlwaysSucceedsProvider();
    const throwing = { send: async () => { throw new Error("boom"); } };
    const scheduler = new SocialScheduler({ providers: { linkedin, flaky: throwing }, clock, maxAttempts: 2, initialBackoffMs: 1000, maxBackoffMs: 1000 });
    const post = scheduler.schedulePost({ clientRequestId: "r1", content: "hi", channels: ["linkedin", "flaky"], scheduledAt: NOW });

    await expect(scheduler.tick()).resolves.toBe(2);
    const p = scheduler.getPost(post.id)!;
    expect(p.deliveries.linkedin!.status).toBe("sent");
    expect(p.deliveries.flaky!.status).toBe("pending");
    expect(p.deliveries.flaky!.lastError).toContain("provider threw");
  });
});

describe("retry, backoff and dead-letter", () => {
  it("respects the backoff delay: a tick() before it has elapsed does not retry", async () => {
    const clock = new ManualClock(NOW);
    const twitter = new FlakyProvider(1);
    const scheduler = new SocialScheduler({ providers: { twitter }, clock, maxAttempts: 5, initialBackoffMs: 5000, maxBackoffMs: 60_000 });
    scheduler.schedulePost({ clientRequestId: "r1", content: "hi", channels: ["twitter"], scheduledAt: NOW });

    await scheduler.tick(); // attempt 1 fails, nextAttemptAt = now + 5000
    expect(twitter.attempts).toHaveLength(1);

    clock.advance(4999);
    await scheduler.tick(); // still not due
    expect(twitter.attempts).toHaveLength(1);

    clock.advance(2);
    await scheduler.tick(); // now due
    expect(twitter.attempts).toHaveLength(2);
  });

  it("backoff grows between attempts (exponential)", async () => {
    const clock = new ManualClock(NOW);
    const mastodon = new AlwaysFailsProvider();
    const scheduler = new SocialScheduler({ providers: { mastodon }, clock, maxAttempts: 5, initialBackoffMs: 1000, maxBackoffMs: 1_000_000 });
    const post = scheduler.schedulePost({ clientRequestId: "r1", content: "hi", channels: ["mastodon"], scheduledAt: NOW });

    await scheduler.tick(); // attempt 1
    const after1 = scheduler.getPost(post.id)!.deliveries.mastodon!.nextAttemptAt - clock.now();
    clock.advance(after1 + 1);
    await scheduler.tick(); // attempt 2
    const after2 = scheduler.getPost(post.id)!.deliveries.mastodon!.nextAttemptAt - clock.now();
    expect(after2).toBeGreaterThan(after1);
  });

  it("backoff is capped at maxBackoffMs", async () => {
    const clock = new ManualClock(NOW);
    const mastodon = new AlwaysFailsProvider();
    const scheduler = new SocialScheduler({ providers: { mastodon }, clock, maxAttempts: 10, initialBackoffMs: 1000, maxBackoffMs: 3000 });
    const post = scheduler.schedulePost({ clientRequestId: "r1", content: "hi", channels: ["mastodon"], scheduledAt: NOW });

    for (let i = 0; i < 6; i++) {
      await scheduler.tick();
      const delivery = scheduler.getPost(post.id)!.deliveries.mastodon!;
      if (delivery.status !== "pending") break;
      const delay = delivery.nextAttemptAt - clock.now();
      expect(delay).toBeLessThanOrEqual(3000);
      clock.advance(delay + 1);
    }
  });

  it("exhausting maxAttempts moves the channel to dead_letter and it is never retried again", async () => {
    const clock = new ManualClock(NOW);
    const mastodon = new AlwaysFailsProvider();
    const scheduler = new SocialScheduler({ providers: { mastodon }, clock, maxAttempts: 3, initialBackoffMs: 100, maxBackoffMs: 1000 });
    const post = scheduler.schedulePost({ clientRequestId: "r1", content: "hi", channels: ["mastodon"], scheduledAt: NOW });

    for (let i = 0; i < 3; i++) {
      await scheduler.tick();
      const delivery = scheduler.getPost(post.id)!.deliveries.mastodon!;
      if (delivery.status === "pending") clock.advance(delivery.nextAttemptAt - clock.now() + 1);
    }
    const delivery = scheduler.getPost(post.id)!.deliveries.mastodon!;
    expect(delivery.status).toBe("dead_letter");
    expect(delivery.attempts).toBe(3);
    expect(mastodon.attempts).toHaveLength(3);

    // further ticks, even far in the future, never call the provider again
    clock.advance(10 * 60 * 60_000);
    await scheduler.tick();
    expect(mastodon.attempts).toHaveLength(3);
    expect(scheduler.getPost(post.id)!.deliveries.mastodon!.status).toBe("dead_letter");
  });

  it("dead-lettering one channel does not affect a sibling channel that keeps succeeding", async () => {
    const clock = new ManualClock(NOW);
    const linkedin = new AlwaysSucceedsProvider();
    const mastodon = new AlwaysFailsProvider();
    const scheduler = new SocialScheduler({ providers: { linkedin, mastodon }, clock, maxAttempts: 2, initialBackoffMs: 100, maxBackoffMs: 1000 });
    const post = scheduler.schedulePost({ clientRequestId: "r1", content: "hi", channels: ["linkedin", "mastodon"], scheduledAt: NOW });

    await scheduler.tick();
    clock.advance(1000);
    await scheduler.tick();
    const p = scheduler.getPost(post.id)!;
    expect(p.deliveries.linkedin!.status).toBe("sent");
    expect(p.deliveries.mastodon!.status).toBe("dead_letter");
  });
});

// Stage 2: a provider can mark a failure PERMANENT (ProviderResult.retryable === false) -- that channel
// dead-letters immediately, skipping the remaining backoff/retry schedule, instead of retrying until maxAttempts.
describe("permanent failures (retryable: false)", () => {
  it("dead-letters on the very first attempt, skipping the retry schedule entirely", async () => {
    const clock = new ManualClock(NOW);
    const mastodon = new AlwaysFailsProvider("account disconnected", false);
    const scheduler = new SocialScheduler({ providers: { mastodon }, clock, maxAttempts: 5, initialBackoffMs: 1000, maxBackoffMs: 60_000 });
    const post = scheduler.schedulePost({ clientRequestId: "r1", content: "hi", channels: ["mastodon"], scheduledAt: NOW });

    await scheduler.tick(); // attempt 1
    const delivery = scheduler.getPost(post.id)!.deliveries.mastodon!;
    expect(delivery.status).toBe("dead_letter");
    expect(delivery.attempts).toBe(1); // not 5 -- no backoff/retry schedule was ever consumed
    expect(delivery.lastError).toBe("account disconnected");
    expect(mastodon.attempts).toHaveLength(1);

    // a further tick(), even with no clock advance at all, never calls the provider again
    await scheduler.tick();
    expect(mastodon.attempts).toHaveLength(1);
  });

  it("does not affect a sibling channel that succeeds", async () => {
    const clock = new ManualClock(NOW);
    const linkedin = new AlwaysSucceedsProvider();
    const mastodon = new AlwaysFailsProvider("invalid credentials", false);
    const scheduler = new SocialScheduler({ providers: { linkedin, mastodon }, clock, maxAttempts: 5, initialBackoffMs: 1000, maxBackoffMs: 60_000 });
    const post = scheduler.schedulePost({ clientRequestId: "r1", content: "hi", channels: ["linkedin", "mastodon"], scheduledAt: NOW });

    await scheduler.tick();
    const p = scheduler.getPost(post.id)!;
    expect(p.deliveries.linkedin!.status).toBe("sent");
    expect(p.deliveries.mastodon!.status).toBe("dead_letter");
    expect(p.deliveries.mastodon!.attempts).toBe(1);
  });

  it("does not affect a sibling channel that is still retrying via a flaky provider", async () => {
    const clock = new ManualClock(NOW);
    const twitter = new FlakyProvider(2);
    const mastodon = new AlwaysFailsProvider("account disconnected", false);
    const scheduler = new SocialScheduler({ providers: { twitter, mastodon }, clock, maxAttempts: 5, initialBackoffMs: 1000, maxBackoffMs: 60_000 });
    const post = scheduler.schedulePost({ clientRequestId: "r1", content: "hi", channels: ["twitter", "mastodon"], scheduledAt: NOW });

    await scheduler.tick(); // attempt 1 for both
    let p = scheduler.getPost(post.id)!;
    expect(p.deliveries.mastodon!.status).toBe("dead_letter");
    expect(p.deliveries.mastodon!.attempts).toBe(1);
    expect(p.deliveries.twitter!.status).toBe("pending");
    expect(p.deliveries.twitter!.attempts).toBe(1);

    clock.advance(1000 + 1);
    await scheduler.tick(); // attempt 2 for twitter only; mastodon is terminal and never due again
    p = scheduler.getPost(post.id)!;
    expect(p.deliveries.mastodon!.attempts).toBe(1); // untouched
    expect(p.deliveries.twitter!.attempts).toBe(2);

    clock.advance(2000 + 1);
    await scheduler.tick(); // attempt 3 for twitter succeeds
    expect(scheduler.getPost(post.id)!.deliveries.twitter!.status).toBe("sent");
  });

  it("attempt 1 retryable, attempt 2 permanent: dead-letters after exactly 2 attempts, not maxAttempts", async () => {
    const clock = new ManualClock(NOW);
    let calls = 0;
    const mastodon = {
      send: async () => {
        calls += 1;
        return calls === 1
          ? ({ status: "failed", reason: "temporary glitch" } as const)
          : ({ status: "failed", reason: "account disconnected", retryable: false } as const);
      },
    };
    const scheduler = new SocialScheduler({ providers: { mastodon }, clock, maxAttempts: 5, initialBackoffMs: 1000, maxBackoffMs: 60_000 });
    const post = scheduler.schedulePost({ clientRequestId: "r1", content: "hi", channels: ["mastodon"], scheduledAt: NOW });

    await scheduler.tick(); // attempt 1: ordinary retryable failure, behaves exactly like stage 1
    let delivery = scheduler.getPost(post.id)!.deliveries.mastodon!;
    expect(delivery.status).toBe("pending");
    expect(delivery.attempts).toBe(1);
    expect(delivery.lastError).toBe("temporary glitch");
    expect(delivery.nextAttemptAt).toBeGreaterThan(clock.now());

    clock.advance(1000 + 1);
    await scheduler.tick(); // attempt 2: permanent failure -- dead-letters right away
    delivery = scheduler.getPost(post.id)!.deliveries.mastodon!;
    expect(delivery.status).toBe("dead_letter");
    expect(delivery.attempts).toBe(2); // not 5 (maxAttempts)
    expect(delivery.lastError).toBe("account disconnected");
    expect(calls).toBe(2);
  });
});
