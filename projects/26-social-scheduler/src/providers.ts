// Channels are a Strategy: the scheduler knows FakeChannelProvider, never linkedin/twitter/whatever's real API.
// Every provider here is a fake: nothing in this project sends a real post over a network. A provider must not
// throw for an ordinary "the platform said no" -- it returns `{ status: "failed", reason }`. A provider that DOES
// throw is still handled by the scheduler (treated as a failed attempt, the same as resilience-kit-style designs
// in this repo): the outcome is unknown, not "nothing happened".
import type { OutboundPost, ProviderResult } from "./types.js";

export interface FakeChannelProvider {
  send(message: OutboundPost): Promise<ProviderResult>;
}

// Always succeeds. The default shape for "this channel just works".
export class AlwaysSucceedsProvider implements FakeChannelProvider {
  readonly attempts: OutboundPost[] = [];
  readonly sent: OutboundPost[] = [];
  private counter = 0;

  async send(message: OutboundPost): Promise<ProviderResult> {
    this.attempts.push({ ...message });
    const result: ProviderResult = { status: "sent", providerId: `ok-${++this.counter}` };
    this.sent.push({ ...message });
    return result;
  }
}

// Always fails. Used to exercise the dead-letter path: a channel on this provider exhausts its attempts and is
// never retried again.
export class AlwaysFailsProvider implements FakeChannelProvider {
  readonly attempts: OutboundPost[] = [];

  constructor(private readonly reason: string = "platform rejected the post") {}

  async send(message: OutboundPost): Promise<ProviderResult> {
    this.attempts.push({ ...message });
    return { status: "failed", reason: this.reason };
  }
}

// Fails the first `failCount` attempts, then succeeds -- per (postId, channel), not globally, so every post that
// uses this provider sees the same "fails K times then works" behaviour independently of any other post.
export class FlakyProvider implements FakeChannelProvider {
  readonly attempts: OutboundPost[] = [];
  private readonly seen = new Map<string, number>(); // "postId:channel" -> attempts seen so far
  private counter = 0;

  constructor(private readonly failCount: number) {
    if (!Number.isInteger(failCount) || failCount < 0) {
      throw new RangeError("failCount must be a non-negative integer");
    }
  }

  async send(message: OutboundPost): Promise<ProviderResult> {
    this.attempts.push({ ...message });
    const key = `${message.postId}:${message.channel}`;
    const count = (this.seen.get(key) ?? 0) + 1;
    this.seen.set(key, count);
    if (count <= this.failCount) return { status: "failed", reason: `flaky provider: attempt ${count} of ${this.failCount} failed on purpose` };
    return { status: "sent", providerId: `flaky-${++this.counter}` };
  }
}
