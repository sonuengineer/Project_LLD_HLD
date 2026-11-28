// npm run demo -- schedule a multi-channel post, advance the clock, tick, show the mixed per-channel outcomes
// (one sent immediately, one retried via the flaky provider, one dead-lettered), and one cancel-before-dispatch.
import { AlwaysFailsProvider, AlwaysSucceedsProvider, FlakyProvider, ManualClock, SocialScheduler } from "./index.js";

const clock = new ManualClock(Date.UTC(2026, 10, 28, 9, 0));
const linkedin = new AlwaysSucceedsProvider();
const twitter = new FlakyProvider(2); // fails the first 2 attempts, then succeeds
const mastodon = new AlwaysFailsProvider("mastodon instance is down"); // retryable by default
const instagram = new AlwaysFailsProvider("account disconnected", false); // stage 2: retryable: false (permanent)

const scheduler = new SocialScheduler({
  providers: { linkedin, twitter, mastodon, instagram },
  clock,
  maxAttempts: 3,
  initialBackoffMs: 60_000, // 1 minute
  maxBackoffMs: 10 * 60_000,
});

function show(postId: string): void {
  const post = scheduler.getPost(postId)!;
  for (const channel of post.channels) {
    const d = post.deliveries[channel]!;
    console.log(`  ${channel}: status=${d.status} attempts=${d.attempts}${d.lastError ? ` lastError=${JSON.stringify(d.lastError)}` : ""}`);
  }
}

async function main(): Promise<void> {
  console.log("--- schedule a post 5 minutes from now, targeting 3 channels ---");
  const scheduledAt = clock.now() + 5 * 60_000;
  const post = scheduler.schedulePost({
    clientRequestId: "campaign-launch-1",
    content: "We're live! Check out the Black Friday deals.",
    channels: ["linkedin", "twitter", "mastodon"],
    scheduledAt,
  });
  show(post.id);

  console.log("\n--- tick() right away: nothing is due yet ---");
  console.log("attempted:", await scheduler.tick());
  show(post.id);

  console.log("\n--- advance the clock past scheduledAt, tick() again: all 3 channels get their first attempt ---");
  clock.advance(5 * 60_000 + 1);
  console.log("attempted:", await scheduler.tick());
  show(post.id);
  console.log("linkedin sent immediately; twitter's flaky provider failed attempt 1; mastodon failed too and is in backoff");

  console.log("\n--- tick() again before the backoff delay has passed: nothing new happens ---");
  console.log("attempted:", await scheduler.tick());
  show(post.id);

  console.log("\n--- advance past the backoff delay, tick() again: twitter's 2nd (still failing) and mastodon's 2nd attempt ---");
  clock.advance(60_000 + 1);
  console.log("attempted:", await scheduler.tick());
  show(post.id);

  console.log("\n--- advance again: twitter's 3rd attempt succeeds; mastodon's 3rd attempt exhausts maxAttempts=3 -> dead_letter ---");
  clock.advance(2 * 60_000 + 1);
  console.log("attempted:", await scheduler.tick());
  show(post.id);

  console.log("\n--- a further tick() never touches the dead-lettered channel again ---");
  const callsBefore = mastodon.attempts.length;
  clock.advance(60 * 60_000);
  await scheduler.tick();
  console.log("mastodon provider call count unchanged:", mastodon.attempts.length === callsBefore);

  console.log("\n--- schedule a second post and cancel one channel before it ever dispatches ---");
  const second = scheduler.schedulePost({
    clientRequestId: "campaign-launch-2",
    content: "One more thing...",
    channels: ["linkedin", "twitter"],
    scheduledAt: clock.now() + 60_000,
  });
  scheduler.cancelChannel(second.id, "twitter");
  clock.advance(2 * 60_000);
  await scheduler.tick();
  show(second.id);
  console.log("twitter stayed canceled and was never dispatched; linkedin went out normally");

  console.log("\n--- schedule a third post: instagram's provider reports a PERMANENT failure (stage 2) ---");
  const third = scheduler.schedulePost({
    clientRequestId: "campaign-launch-3",
    content: "Last one for today.",
    channels: ["linkedin", "instagram"],
    scheduledAt: clock.now() + 60_000,
  });
  clock.advance(60_000 + 1);
  console.log("attempted:", await scheduler.tick()); // one attempt each, right away
  show(third.id);
  console.log("instagram dead-lettered on attempt 1 (account disconnected) -- it skipped the whole backoff/retry schedule, unlike mastodon above");
}

await main();
