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
//
// Retryable by default (`retryable = true`), unchanged from stage 1: a channel on this provider dead-letters only
// after exhausting maxAttempts. Pass `retryable = false` to model a PERMANENT failure instead (account
// disconnected, invalid credentials) -- the channel dead-letters on its very first attempt. This is a constructor
// option rather than a separate provider class because "always fails" is already the one behavior this class
// models; whether that failure is retryable or permanent is a configuration of it, the same way FlakyProvider's
// `failCount` configures how many times it fails before succeeding -- not a reason to add a second class.
export class AlwaysFailsProvider implements FakeChannelProvider {
  readonly attempts: OutboundPost[] = [];

  constructor(
    private readonly reason: string = "platform rejected the post",
    private readonly retryable: boolean = true,
  ) {}

  async send(message: OutboundPost): Promise<ProviderResult> {
    this.attempts.push({ ...message });
    // `retryable: true` is never emitted explicitly -- omitting the field IS "retryable" (see types.ts), and
    // stage 1 code/tests that only ever constructed this with one argument must see the exact same shape back.
    return this.retryable ? { status: "failed", reason: this.reason } : { status: "failed", reason: this.reason, retryable: false };
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
