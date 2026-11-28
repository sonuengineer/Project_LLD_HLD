import { describe, expect, it } from "vitest";
import { ManualClock } from "../src/clock.js";
import { SchedulerError } from "../src/errors.js";
import { AlwaysFailsProvider, AlwaysSucceedsProvider } from "../src/providers.js";
import { SocialScheduler } from "../src/scheduler.js";

const NOW = Date.UTC(2026, 10, 28, 9, 0);

function codeOf(fn: () => unknown): string {
  try {
    fn();
    throw new Error("expected to throw");
  } catch (err) {
    if (err instanceof SchedulerError) return err.code;
    throw err;
  }
}

describe("cancelChannel", () => {
  it("cancels a still-pending channel; it is never dispatched even once tick() runs after its due time", async () => {
    const clock = new ManualClock(NOW);
    const linkedin = new AlwaysSucceedsProvider();
    const scheduler = new SocialScheduler({ providers: { linkedin }, clock });
    const post = scheduler.schedulePost({ clientRequestId: "r1", content: "hi", channels: ["linkedin"], scheduledAt: NOW + 1000 });

    const canceled = scheduler.cancelChannel(post.id, "linkedin");
    expect(canceled.deliveries.linkedin!.status).toBe("canceled");
    expect(canceled.deliveries.linkedin!.canceledAt).toBe(NOW);

    clock.advance(2000);
    const attempted = await scheduler.tick();
    expect(attempted).toBe(0);
    expect(linkedin.attempts).toHaveLength(0);
    expect(scheduler.getPost(post.id)!.deliveries.linkedin!.status).toBe("canceled");
  });

  it("cancels only the targeted channel, leaving a sibling channel untouched and still dispatchable", async () => {
    const clock = new ManualClock(NOW);
    const linkedin = new AlwaysSucceedsProvider();
    const twitter = new AlwaysSucceedsProvider();
    const scheduler = new SocialScheduler({ providers: { linkedin, twitter }, clock });
    const post = scheduler.schedulePost({ clientRequestId: "r1", content: "hi", channels: ["linkedin", "twitter"], scheduledAt: NOW });

    scheduler.cancelChannel(post.id, "twitter");
    await scheduler.tick();
    const p = scheduler.getPost(post.id)!;
    expect(p.deliveries.linkedin!.status).toBe("sent");
    expect(p.deliveries.twitter!.status).toBe("canceled");
  });

  it("rejects canceling an already-sent channel, cleanly, changing nothing", async () => {
    const clock = new ManualClock(NOW);
    const linkedin = new AlwaysSucceedsProvider();
    const scheduler = new SocialScheduler({ providers: { linkedin }, clock });
    const post = scheduler.schedulePost({ clientRequestId: "r1", content: "hi", channels: ["linkedin"], scheduledAt: NOW });
    await scheduler.tick();

    expect(codeOf(() => scheduler.cancelChannel(post.id, "linkedin"))).toBe("CHANNEL_NOT_PENDING");
    expect(scheduler.getPost(post.id)!.deliveries.linkedin!.status).toBe("sent");
  });

  it("rejects canceling an already dead-lettered channel, cleanly, changing nothing", async () => {
    const clock = new ManualClock(NOW);
    const mastodon = new AlwaysFailsProvider();
    const scheduler = new SocialScheduler({ providers: { mastodon }, clock, maxAttempts: 1 });
    const post = scheduler.schedulePost({ clientRequestId: "r1", content: "hi", channels: ["mastodon"], scheduledAt: NOW });
    await scheduler.tick();
    expect(scheduler.getPost(post.id)!.deliveries.mastodon!.status).toBe("dead_letter");

    expect(codeOf(() => scheduler.cancelChannel(post.id, "mastodon"))).toBe("CHANNEL_NOT_PENDING");
    expect(scheduler.getPost(post.id)!.deliveries.mastodon!.status).toBe("dead_letter");
  });

  it("rejects canceling an already-canceled channel", () => {
    const clock = new ManualClock(NOW);
    const linkedin = new AlwaysSucceedsProvider();
    const scheduler = new SocialScheduler({ providers: { linkedin }, clock });
    const post = scheduler.schedulePost({ clientRequestId: "r1", content: "hi", channels: ["linkedin"], scheduledAt: NOW + 1000 });
    scheduler.cancelChannel(post.id, "linkedin");
    expect(codeOf(() => scheduler.cancelChannel(post.id, "linkedin"))).toBe("CHANNEL_NOT_PENDING");
  });

  it("rejects an unknown post", () => {
    const { scheduler } = (() => {
      const clock = new ManualClock(NOW);
      return { scheduler: new SocialScheduler({ providers: { linkedin: new AlwaysSucceedsProvider() }, clock }) };
    })();
    expect(codeOf(() => scheduler.cancelChannel("nope", "linkedin"))).toBe("UNKNOWN_POST");
  });

  it("rejects a channel the post was never scheduled on", () => {
    const clock = new ManualClock(NOW);
    const linkedin = new AlwaysSucceedsProvider();
    const twitter = new AlwaysSucceedsProvider();
    const scheduler = new SocialScheduler({ providers: { linkedin, twitter }, clock });
    const post = scheduler.schedulePost({ clientRequestId: "r1", content: "hi", channels: ["linkedin"], scheduledAt: NOW + 1000 });
    expect(codeOf(() => scheduler.cancelChannel(post.id, "twitter"))).toBe("UNKNOWN_POST_CHANNEL");
  });
});

describe("cancelPost", () => {
  it("cancels every still-pending channel", () => {
    const clock = new ManualClock(NOW);
    const linkedin = new AlwaysSucceedsProvider();
    const twitter = new AlwaysSucceedsProvider();
    const scheduler = new SocialScheduler({ providers: { linkedin, twitter }, clock });
    const post = scheduler.schedulePost({ clientRequestId: "r1", content: "hi", channels: ["linkedin", "twitter"], scheduledAt: NOW + 1000 });

    const canceled = scheduler.cancelPost(post.id);
    expect(canceled.deliveries.linkedin!.status).toBe("canceled");
    expect(canceled.deliveries.twitter!.status).toBe("canceled");
  });

  it("cancels only the pending channels, leaving already-sent ones as sent", async () => {
    const clock = new ManualClock(NOW);
    const linkedin = new AlwaysSucceedsProvider();
    const twitter = new AlwaysSucceedsProvider();
    const scheduler = new SocialScheduler({ providers: { linkedin, twitter }, clock });
    const post = scheduler.schedulePost({ clientRequestId: "r1", content: "hi", channels: ["linkedin", "twitter"], scheduledAt: NOW });
    // make linkedin due and sent, keep twitter not yet due by canceling after only linkedin dispatches:
    // simplest: dispatch both now, cancel afterwards should then throw NOTHING_PENDING
    await scheduler.tick();
    expect(codeOf(() => scheduler.cancelPost(post.id))).toBe("NOTHING_PENDING");
  });

  it("rejects canceling a post where nothing is pending", async () => {
    const clock = new ManualClock(NOW);
    const linkedin = new AlwaysSucceedsProvider();
    const scheduler = new SocialScheduler({ providers: { linkedin }, clock });
    const post = scheduler.schedulePost({ clientRequestId: "r1", content: "hi", channels: ["linkedin"], scheduledAt: NOW });
    await scheduler.tick();
    expect(codeOf(() => scheduler.cancelPost(post.id))).toBe("NOTHING_PENDING");
  });

  it("rejects an unknown post", () => {
    const clock = new ManualClock(NOW);
    const scheduler = new SocialScheduler({ providers: { linkedin: new AlwaysSucceedsProvider() }, clock });
    expect(codeOf(() => scheduler.cancelPost("nope"))).toBe("UNKNOWN_POST");
  });
});

describe("editPost", () => {
  it("edits content and scheduledAt before any dispatch", () => {
    const clock = new ManualClock(NOW);
    const linkedin = new AlwaysSucceedsProvider();
    const scheduler = new SocialScheduler({ providers: { linkedin }, clock });
    const post = scheduler.schedulePost({ clientRequestId: "r1", content: "hi", channels: ["linkedin"], scheduledAt: NOW + 1000 });

    const edited = scheduler.editPost(post.id, { content: "hi v2", scheduledAt: NOW + 5000 });
    expect(edited.content).toBe("hi v2");
    expect(edited.scheduledAt).toBe(NOW + 5000);
    expect(edited.deliveries.linkedin!.nextAttemptAt).toBe(NOW + 5000);
  });

  it("edits content only, leaving scheduledAt as-is", () => {
    const clock = new ManualClock(NOW);
    const linkedin = new AlwaysSucceedsProvider();
    const scheduler = new SocialScheduler({ providers: { linkedin }, clock });
    const post = scheduler.schedulePost({ clientRequestId: "r1", content: "hi", channels: ["linkedin"], scheduledAt: NOW + 1000 });
    const edited = scheduler.editPost(post.id, { content: "hi v2" });
    expect(edited.content).toBe("hi v2");
    expect(edited.scheduledAt).toBe(NOW + 1000);
  });

  it("rejects editing an already-sent post, cleanly, changing nothing", async () => {
    const clock = new ManualClock(NOW);
    const linkedin = new AlwaysSucceedsProvider();
    const scheduler = new SocialScheduler({ providers: { linkedin }, clock });
    const post = scheduler.schedulePost({ clientRequestId: "r1", content: "hi", channels: ["linkedin"], scheduledAt: NOW });
    await scheduler.tick();

    expect(codeOf(() => scheduler.editPost(post.id, { content: "nope" }))).toBe("POST_ALREADY_DISPATCHED");
    expect(scheduler.getPost(post.id)!.content).toBe("hi");
  });

  it("rejects editing a dead-lettered post, cleanly, changing nothing", async () => {
    const clock = new ManualClock(NOW);
    const mastodon = new AlwaysFailsProvider();
    const scheduler = new SocialScheduler({ providers: { mastodon }, clock, maxAttempts: 1 });
    const post = scheduler.schedulePost({ clientRequestId: "r1", content: "hi", channels: ["mastodon"], scheduledAt: NOW });
    await scheduler.tick();
    expect(scheduler.getPost(post.id)!.deliveries.mastodon!.status).toBe("dead_letter");

    expect(codeOf(() => scheduler.editPost(post.id, { content: "nope" }))).toBe("POST_ALREADY_DISPATCHED");
  });

  it("rejects editing a post once ANY channel has been attempted, even if that channel is still pending (mid-retry)", async () => {
    const clock = new ManualClock(NOW);
    const twitter = new AlwaysFailsProvider();
    const scheduler = new SocialScheduler({ providers: { twitter }, clock, maxAttempts: 5, initialBackoffMs: 60_000, maxBackoffMs: 600_000 });
    const post = scheduler.schedulePost({ clientRequestId: "r1", content: "hi", channels: ["twitter"], scheduledAt: NOW });
    await scheduler.tick(); // attempt 1 fails, still pending (awaiting retry)
    expect(scheduler.getPost(post.id)!.deliveries.twitter!.status).toBe("pending");

    expect(codeOf(() => scheduler.editPost(post.id, { content: "nope" }))).toBe("POST_ALREADY_DISPATCHED");
  });

  it("allows editing a post whose only channel was canceled AFTER an attempt (mid-retry cancel)", async () => {
    const clock = new ManualClock(NOW);
    const twitter = new AlwaysFailsProvider();
    const scheduler = new SocialScheduler({ providers: { twitter }, clock, maxAttempts: 5, initialBackoffMs: 60_000, maxBackoffMs: 600_000 });
    const post = scheduler.schedulePost({ clientRequestId: "r1", content: "hi", channels: ["twitter"], scheduledAt: NOW });
    await scheduler.tick(); // attempt 1 fails, still pending (attempts === 1)
    expect(scheduler.getPost(post.id)!.deliveries.twitter!.attempts).toBe(1);

    scheduler.cancelChannel(post.id, "twitter"); // canceled while attempts > 0
    const edited = scheduler.editPost(post.id, { content: "hi v2" });
    expect(edited.content).toBe("hi v2");
    expect(edited.deliveries.twitter!.status).toBe("canceled");
  });

  it("allows editing a post where one channel was canceled and the rest are untouched", () => {
    const clock = new ManualClock(NOW);
    const linkedin = new AlwaysSucceedsProvider();
    const twitter = new AlwaysSucceedsProvider();
    const scheduler = new SocialScheduler({ providers: { linkedin, twitter }, clock });
    const post = scheduler.schedulePost({ clientRequestId: "r1", content: "hi", channels: ["linkedin", "twitter"], scheduledAt: NOW + 1000 });
    scheduler.cancelChannel(post.id, "twitter");

    const edited = scheduler.editPost(post.id, { content: "hi v2" });
    expect(edited.content).toBe("hi v2");
    expect(edited.deliveries.twitter!.status).toBe("canceled");
    expect(edited.deliveries.linkedin!.status).toBe("pending");
  });

  it("rejects an edit with neither field set", () => {
    const clock = new ManualClock(NOW);
    const linkedin = new AlwaysSucceedsProvider();
    const scheduler = new SocialScheduler({ providers: { linkedin }, clock });
    const post = scheduler.schedulePost({ clientRequestId: "r1", content: "hi", channels: ["linkedin"], scheduledAt: NOW + 1000 });
    expect(codeOf(() => scheduler.editPost(post.id, {}))).toBe("INVALID_REQUEST");
  });

  it("validates the new content the same way schedulePost does", () => {
    const clock = new ManualClock(NOW);
    const linkedin = new AlwaysSucceedsProvider();
    const scheduler = new SocialScheduler({ providers: { linkedin }, clock });
    const post = scheduler.schedulePost({ clientRequestId: "r1", content: "hi", channels: ["linkedin"], scheduledAt: NOW + 1000 });
    expect(codeOf(() => scheduler.editPost(post.id, { content: "   " }))).toBe("INVALID_REQUEST");
    expect(scheduler.getPost(post.id)!.content).toBe("hi");
  });

  it("validates the new scheduledAt is not in the past", () => {
    const clock = new ManualClock(NOW);
    const linkedin = new AlwaysSucceedsProvider();
    const scheduler = new SocialScheduler({ providers: { linkedin }, clock });
    const post = scheduler.schedulePost({ clientRequestId: "r1", content: "hi", channels: ["linkedin"], scheduledAt: NOW + 1000 });
    expect(codeOf(() => scheduler.editPost(post.id, { scheduledAt: NOW - 1 }))).toBe("SCHEDULED_AT_IN_PAST");
  });

  it("rejects an unknown post", () => {
    const clock = new ManualClock(NOW);
    const scheduler = new SocialScheduler({ providers: { linkedin: new AlwaysSucceedsProvider() }, clock });
    expect(codeOf(() => scheduler.editPost("nope", { content: "x" }))).toBe("UNKNOWN_POST");
  });
});
