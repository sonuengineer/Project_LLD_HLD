// tick() is the only place this project ever awaits anything. Every provider in the other test files resolves
// its promise immediately, so an in-flight send never overlaps with anything else in a sequential test -- these
// tests use a deferred (manually-resolved) provider to actually create that overlap, so the `dispatching` guard
// (cancelChannel/cancelPost's DISPATCH_IN_PROGRESS) and "a channel is claimed for exactly one dispatch at a time"
// are exercised for real, not just by inspection.
import { describe, expect, it } from "vitest";
import { ManualClock } from "../src/clock.js";
import type { FakeChannelProvider } from "../src/providers.js";
import { AlwaysSucceedsProvider } from "../src/providers.js";
import { SocialScheduler } from "../src/scheduler.js";
import type { OutboundPost, ProviderResult } from "../src/types.js";

const NOW = Date.UTC(2026, 10, 28, 9, 0);

function deferredProvider(): { provider: FakeChannelProvider; calls: OutboundPost[]; resolve: (r: ProviderResult) => void } {
  let resolve!: (r: ProviderResult) => void;
  const calls: OutboundPost[] = [];
  const provider: FakeChannelProvider = {
    send(message: OutboundPost) {
      calls.push({ ...message });
      return new Promise<ProviderResult>((res) => {
        resolve = res;
      });
    },
  };
  return { provider, calls, resolve: (r) => resolve(r) };
}

describe("the dispatching guard", () => {
  it("cancelChannel refuses with DISPATCH_IN_PROGRESS while tick() is mid-send for that exact channel", async () => {
    const clock = new ManualClock(NOW);
    const { provider, resolve } = deferredProvider();
    const scheduler = new SocialScheduler({ providers: { slow: provider }, clock });
    const post = scheduler.schedulePost({ clientRequestId: "r1", content: "hi", channels: ["slow"], scheduledAt: NOW });

    const tickPromise = scheduler.tick(); // starts the send, does not resolve yet
    await Promise.resolve(); // let the microtask that calls provider.send() run

    expect(() => scheduler.cancelChannel(post.id, "slow")).toThrowError(/DISPATCH_IN_PROGRESS|is being dispatched/);

    resolve({ status: "sent", providerId: "slow-1" });
    await tickPromise;
    expect(scheduler.getPost(post.id)!.deliveries.slow!.status).toBe("sent");
  });

  it("cancelPost refuses while any of its channels is mid-send", async () => {
    const clock = new ManualClock(NOW);
    const { provider, resolve } = deferredProvider();
    const scheduler = new SocialScheduler({ providers: { slow: provider, fast: new AlwaysSucceedsProvider() }, clock });
    const post = scheduler.schedulePost({ clientRequestId: "r1", content: "hi", channels: ["slow", "fast"], scheduledAt: NOW + 10_000 });
    // cancel "fast" ahead of time so only "slow" is pending when we tick a later due time for it
    scheduler.cancelChannel(post.id, "fast");
    const post2 = scheduler.schedulePost({ clientRequestId: "r2", content: "hi", channels: ["slow"], scheduledAt: NOW });

    const tickPromise = scheduler.tick();
    await Promise.resolve();

    expect(() => scheduler.cancelPost(post2.id)).toThrowError(/DISPATCH_IN_PROGRESS|is being dispatched/);

    resolve({ status: "sent", providerId: "slow-1" });
    await tickPromise;
  });

  it("two overlapping tick() calls never dispatch the same due channel twice", async () => {
    const clock = new ManualClock(NOW);
    const { provider, calls, resolve } = deferredProvider();
    const scheduler = new SocialScheduler({ providers: { slow: provider }, clock });
    scheduler.schedulePost({ clientRequestId: "r1", content: "hi", channels: ["slow"], scheduledAt: NOW });

    const first = scheduler.tick();
    await Promise.resolve();
    const second = scheduler.tick(); // the channel is already in `dispatching`, so this sees nothing due

    resolve({ status: "sent", providerId: "slow-1" });
    const [firstCount, secondCount] = await Promise.all([first, second]);
    expect(firstCount).toBe(1);
    expect(secondCount).toBe(0);
    expect(calls).toHaveLength(1);
  });
});
