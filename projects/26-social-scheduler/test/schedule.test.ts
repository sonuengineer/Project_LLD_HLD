import { describe, expect, it } from "vitest";
import { ManualClock } from "../src/clock.js";
import { SchedulerError } from "../src/errors.js";
import { AlwaysSucceedsProvider } from "../src/providers.js";
import { MAX_CHANNELS_PER_POST, MAX_CLIENT_REQUEST_ID_LENGTH, MAX_CONTENT_LENGTH, SocialScheduler } from "../src/scheduler.js";

const NOW = Date.UTC(2026, 10, 28, 9, 0);

function makeScheduler() {
  const clock = new ManualClock(NOW);
  const linkedin = new AlwaysSucceedsProvider();
  const twitter = new AlwaysSucceedsProvider();
  const scheduler = new SocialScheduler({ providers: { linkedin, twitter }, clock });
  return { scheduler, clock, linkedin, twitter };
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
    throw new Error("expected to throw");
  } catch (err) {
    if (err instanceof SchedulerError) return err.code;
    throw err;
  }
}

describe("schedulePost validation", () => {
  it("accepts a valid request", () => {
    const { scheduler } = makeScheduler();
    const post = scheduler.schedulePost({ clientRequestId: "r1", content: "hello world", channels: ["linkedin"], scheduledAt: NOW + 1000 });
    expect(post.id).toBeTruthy();
    expect(post.content).toBe("hello world");
    expect(post.channels).toEqual(["linkedin"]);
    expect(post.scheduledAt).toBe(NOW + 1000);
    expect(Object.keys(post.deliveries)).toEqual(["linkedin"]);
    expect(post.deliveries.linkedin).toMatchObject({ channel: "linkedin", status: "pending", attempts: 0, nextAttemptAt: NOW + 1000 });
  });

  it("rejects empty content", () => {
    const { scheduler } = makeScheduler();
    expect(codeOf(() => scheduler.schedulePost({ clientRequestId: "r1", content: "   ", channels: ["linkedin"], scheduledAt: NOW + 1000 }))).toBe("INVALID_REQUEST");
  });

  it("rejects non-string content", () => {
    const { scheduler } = makeScheduler();
    expect(codeOf(() => scheduler.schedulePost({ clientRequestId: "r1", content: 42 as unknown as string, channels: ["linkedin"], scheduledAt: NOW + 1000 }))).toBe(
      "INVALID_REQUEST",
    );
  });

  it("accepts content at exactly the max length", () => {
    const { scheduler } = makeScheduler();
    const content = "x".repeat(MAX_CONTENT_LENGTH);
    const post = scheduler.schedulePost({ clientRequestId: "r1", content, channels: ["linkedin"], scheduledAt: NOW + 1000 });
    expect(post.content.length).toBe(MAX_CONTENT_LENGTH);
  });

  it("rejects content one character over the max length", () => {
    const { scheduler } = makeScheduler();
    const content = "x".repeat(MAX_CONTENT_LENGTH + 1);
    expect(codeOf(() => scheduler.schedulePost({ clientRequestId: "r1", content, channels: ["linkedin"], scheduledAt: NOW + 1000 }))).toBe("INVALID_REQUEST");
  });

  it("rejects an empty channel list", () => {
    const { scheduler } = makeScheduler();
    expect(codeOf(() => scheduler.schedulePost({ clientRequestId: "r1", content: "hi", channels: [], scheduledAt: NOW + 1000 }))).toBe("INVALID_REQUEST");
  });

  it("rejects a non-array channel list", () => {
    const { scheduler } = makeScheduler();
    expect(codeOf(() => scheduler.schedulePost({ clientRequestId: "r1", content: "hi", channels: "linkedin" as unknown as string[], scheduledAt: NOW + 1000 }))).toBe(
      "INVALID_REQUEST",
    );
  });

  it("rejects duplicate channels in the list", () => {
    const { scheduler } = makeScheduler();
    expect(codeOf(() => scheduler.schedulePost({ clientRequestId: "r1", content: "hi", channels: ["linkedin", "linkedin"], scheduledAt: NOW + 1000 }))).toBe(
      "INVALID_REQUEST",
    );
  });

  it("rejects more channels than the per-post bound", () => {
    const { scheduler } = makeScheduler();
    const channels = Array.from({ length: MAX_CHANNELS_PER_POST + 1 }, (_, i) => `linkedin-${i}`);
    expect(codeOf(() => scheduler.schedulePost({ clientRequestId: "r1", content: "hi", channels, scheduledAt: NOW + 1000 }))).toBe("INVALID_REQUEST");
  });

  it("rejects an unknown channel key", () => {
    const { scheduler } = makeScheduler();
    expect(codeOf(() => scheduler.schedulePost({ clientRequestId: "r1", content: "hi", channels: ["tiktok"], scheduledAt: NOW + 1000 }))).toBe("UNKNOWN_CHANNEL");
  });

  it("rejects an unknown channel even when mixed with valid ones (nothing is created)", () => {
    const { scheduler } = makeScheduler();
    expect(codeOf(() => scheduler.schedulePost({ clientRequestId: "r1", content: "hi", channels: ["linkedin", "tiktok"], scheduledAt: NOW + 1000 }))).toBe(
      "UNKNOWN_CHANNEL",
    );
    expect(scheduler.list()).toHaveLength(0);
  });

  it("rejects a scheduledAt in the past", () => {
    const { scheduler } = makeScheduler();
    expect(codeOf(() => scheduler.schedulePost({ clientRequestId: "r1", content: "hi", channels: ["linkedin"], scheduledAt: NOW - 1 }))).toBe("SCHEDULED_AT_IN_PAST");
  });

  it("accepts a scheduledAt of exactly now", () => {
    const { scheduler } = makeScheduler();
    const post = scheduler.schedulePost({ clientRequestId: "r1", content: "hi", channels: ["linkedin"], scheduledAt: NOW });
    expect(post.scheduledAt).toBe(NOW);
  });

  it("rejects a non-integer scheduledAt", () => {
    const { scheduler } = makeScheduler();
    expect(codeOf(() => scheduler.schedulePost({ clientRequestId: "r1", content: "hi", channels: ["linkedin"], scheduledAt: NOW + 0.5 }))).toBe("INVALID_REQUEST");
  });

  it("rejects an empty clientRequestId", () => {
    const { scheduler } = makeScheduler();
    expect(codeOf(() => scheduler.schedulePost({ clientRequestId: "  ", content: "hi", channels: ["linkedin"], scheduledAt: NOW + 1000 }))).toBe("INVALID_REQUEST");
  });

  it("rejects a clientRequestId over the max length", () => {
    const { scheduler } = makeScheduler();
    const clientRequestId = "x".repeat(MAX_CLIENT_REQUEST_ID_LENGTH + 1);
    expect(codeOf(() => scheduler.schedulePost({ clientRequestId, content: "hi", channels: ["linkedin"], scheduledAt: NOW + 1000 }))).toBe("INVALID_REQUEST");
  });

  it("an invalid request leaves nothing behind: a later valid request with the same clientRequestId succeeds", () => {
    const { scheduler } = makeScheduler();
    expect(() => scheduler.schedulePost({ clientRequestId: "r1", content: "", channels: ["linkedin"], scheduledAt: NOW + 1000 })).toThrow();
    const post = scheduler.schedulePost({ clientRequestId: "r1", content: "ok now", channels: ["linkedin"], scheduledAt: NOW + 1000 });
    expect(post.content).toBe("ok now");
  });

  it("fans out one independent delivery per channel", () => {
    const { scheduler } = makeScheduler();
    const post = scheduler.schedulePost({ clientRequestId: "r1", content: "hi", channels: ["linkedin", "twitter"], scheduledAt: NOW + 1000 });
    expect(Object.keys(post.deliveries).sort()).toEqual(["linkedin", "twitter"]);
    expect(post.deliveries.linkedin).not.toBe(post.deliveries.twitter);
  });

  it("getPost returns a copy, not the live record", () => {
    const { scheduler } = makeScheduler();
    const post = scheduler.schedulePost({ clientRequestId: "r1", content: "hi", channels: ["linkedin"], scheduledAt: NOW + 1000 });
    post.content = "mutated by caller";
    (post.deliveries.linkedin as { status: string }).status = "sent";
    const fresh = scheduler.getPost(post.id)!;
    expect(fresh.content).toBe("hi");
    expect(fresh.deliveries.linkedin!.status).toBe("pending");
  });

  it("getPost returns undefined for an unknown id", () => {
    const { scheduler } = makeScheduler();
    expect(scheduler.getPost("nope")).toBeUndefined();
  });

  it("the constructor requires at least one provider", () => {
    expect(() => new SocialScheduler({ providers: {} })).toThrow(RangeError);
  });
});

describe("constructor retry-policy validation", () => {
  const providers = { linkedin: new AlwaysSucceedsProvider() };

  it("rejects maxAttempts under 1", () => {
    expect(() => new SocialScheduler({ providers, maxAttempts: 0 })).toThrow(RangeError);
    expect(() => new SocialScheduler({ providers, maxAttempts: -1 })).toThrow(RangeError);
  });

  it("rejects a non-integer maxAttempts", () => {
    expect(() => new SocialScheduler({ providers, maxAttempts: 1.5 })).toThrow(RangeError);
  });

  it("accepts maxAttempts of exactly 1", () => {
    expect(() => new SocialScheduler({ providers, maxAttempts: 1 })).not.toThrow();
  });

  it("rejects a negative initialBackoffMs", () => {
    expect(() => new SocialScheduler({ providers, initialBackoffMs: -1 })).toThrow(RangeError);
  });

  it("accepts an initialBackoffMs of exactly 0", () => {
    expect(() => new SocialScheduler({ providers, initialBackoffMs: 0, maxBackoffMs: 0 })).not.toThrow();
  });

  it("rejects maxBackoffMs below initialBackoffMs", () => {
    expect(() => new SocialScheduler({ providers, initialBackoffMs: 1000, maxBackoffMs: 999 })).toThrow(RangeError);
  });

  it("accepts maxBackoffMs equal to initialBackoffMs", () => {
    expect(() => new SocialScheduler({ providers, initialBackoffMs: 1000, maxBackoffMs: 1000 })).not.toThrow();
  });
});

describe("idempotent scheduling", () => {
  it("the same clientRequestId with the same content/channels/time returns the original, creates nothing new", () => {
    const { scheduler } = makeScheduler();
    const first = scheduler.schedulePost({ clientRequestId: "camp-1", content: "hello", channels: ["linkedin", "twitter"], scheduledAt: NOW + 1000 });
    const second = scheduler.schedulePost({ clientRequestId: "camp-1", content: "hello", channels: ["linkedin", "twitter"], scheduledAt: NOW + 1000 });
    expect(second.id).toBe(first.id);
    expect(scheduler.list()).toHaveLength(1);
  });

  it("channel order does not matter for the replay match", () => {
    const { scheduler } = makeScheduler();
    const first = scheduler.schedulePost({ clientRequestId: "camp-2", content: "hello", channels: ["linkedin", "twitter"], scheduledAt: NOW + 1000 });
    const second = scheduler.schedulePost({ clientRequestId: "camp-2", content: "hello", channels: ["twitter", "linkedin"], scheduledAt: NOW + 1000 });
    expect(second.id).toBe(first.id);
    expect(scheduler.list()).toHaveLength(1);
  });

  it("the same clientRequestId with different content is a conflict and creates nothing new", () => {
    const { scheduler } = makeScheduler();
    scheduler.schedulePost({ clientRequestId: "camp-3", content: "hello", channels: ["linkedin"], scheduledAt: NOW + 1000 });
    expect(codeOf(() => scheduler.schedulePost({ clientRequestId: "camp-3", content: "goodbye", channels: ["linkedin"], scheduledAt: NOW + 1000 }))).toBe(
      "IDEMPOTENCY_CONFLICT",
    );
    expect(scheduler.list()).toHaveLength(1);
  });

  it("the same clientRequestId with different channels is a conflict", () => {
    const { scheduler } = makeScheduler();
    scheduler.schedulePost({ clientRequestId: "camp-4", content: "hello", channels: ["linkedin"], scheduledAt: NOW + 1000 });
    expect(codeOf(() => scheduler.schedulePost({ clientRequestId: "camp-4", content: "hello", channels: ["twitter"], scheduledAt: NOW + 1000 }))).toBe(
      "IDEMPOTENCY_CONFLICT",
    );
  });

  it("the same clientRequestId with a different scheduledAt is a conflict", () => {
    const { scheduler } = makeScheduler();
    scheduler.schedulePost({ clientRequestId: "camp-5", content: "hello", channels: ["linkedin"], scheduledAt: NOW + 1000 });
    expect(codeOf(() => scheduler.schedulePost({ clientRequestId: "camp-5", content: "hello", channels: ["linkedin"], scheduledAt: NOW + 2000 }))).toBe(
      "IDEMPOTENCY_CONFLICT",
    );
  });

  it("a replay is answered even with an otherwise-invalid-looking payload shape difference that still fingerprints the same", () => {
    const { scheduler } = makeScheduler();
    const first = scheduler.schedulePost({ clientRequestId: "camp-6", content: "hello", channels: ["linkedin", "twitter"], scheduledAt: NOW + 1000 });
    // duplicate-looking list that dedupes to the same set
    const second = scheduler.schedulePost({ clientRequestId: "camp-6", content: "hello", channels: ["linkedin", "twitter"], scheduledAt: NOW + 1000 });
    expect(second.id).toBe(first.id);
  });

  it("different clientRequestIds with identical bodies create two separate posts", () => {
    const { scheduler } = makeScheduler();
    const a = scheduler.schedulePost({ clientRequestId: "a", content: "hello", channels: ["linkedin"], scheduledAt: NOW + 1000 });
    const b = scheduler.schedulePost({ clientRequestId: "b", content: "hello", channels: ["linkedin"], scheduledAt: NOW + 1000 });
    expect(a.id).not.toBe(b.id);
    expect(scheduler.list()).toHaveLength(2);
  });
});
