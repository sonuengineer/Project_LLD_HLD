# B22 Social Media Post Scheduler (low-level design)

A TypeScript library (no runtime dependencies, in memory) for the core of a social media post scheduler
(Postiz/Buffer style): schedule a post for one or more channels, dispatch it at the right time with retries, and
track per-channel delivery status. There are no real providers: nothing in this project ever sends a real post
over a network.

Status (2026-11-28): stage 1 DONE -- 84 tests, 35 mutation checks, all caught (see "Mutation checks"). Details in
[PLAN.md](PLAN.md).

```
npm ci
npm test        # 84 tests
npm run demo    # a multi-channel post: one sent immediately, one retried via a flaky provider, one dead-lettered,
                # plus a cancel-before-dispatch
```

## Usage

```ts
import { AlwaysFailsProvider, AlwaysSucceedsProvider, FlakyProvider, ManualClock, SocialScheduler } from "./src/index.js";

const clock = new ManualClock(Date.now());
const scheduler = new SocialScheduler({
  providers: {
    linkedin: new AlwaysSucceedsProvider(),
    twitter: new FlakyProvider(2),              // fails the first 2 attempts, then succeeds
    mastodon: new AlwaysFailsProvider("instance is down"),
  },
  clock,
  maxAttempts: 3,
  initialBackoffMs: 60_000,
  maxBackoffMs: 10 * 60_000,
});

const post = scheduler.schedulePost({
  clientRequestId: "campaign-launch-1",          // retry this call unchanged; it will not double-schedule
  content: "We're live!",
  channels: ["linkedin", "twitter", "mastodon"],
  scheduledAt: clock.now() + 5 * 60_000,
});

clock.advance(5 * 60_000 + 1);
await scheduler.tick();                          // dispatches every channel that is now due

scheduler.getPost(post.id)!.deliveries;
// linkedin: sent | twitter: pending, attempts 1 (will retry) | mastodon: pending, attempts 1 (will retry)
```

## The rules

- **A channel is a string key into the `providers` map given to the constructor.** `schedulePost` rejects any
  channel with no registered provider (`UNKNOWN_CHANNEL`); this project never calls a real platform API.
- **One status per channel: `pending -> sent | dead_letter | canceled`.** There is no separate `failed` status: a
  failed attempt with retries left just stays `pending` (awaiting its next attempt); only exhausting every
  attempt is terminal (`dead_letter`). `attempts` and `lastError` are kept even after a terminal state, for
  diagnostics.
- **One independent `ChannelDelivery` per channel.** A post targeting 3 channels gets 3 delivery records, each
  with its own `status`, `attempts` and `nextAttemptAt`. One channel's provider failing, throwing, or
  dead-lettering never affects another channel's counters or status, of the same post or any other.
- **Idempotent scheduling.** The caller supplies `clientRequestId`. The same id with the same content, the same
  set of channels (order does not matter) and the same `scheduledAt` returns the ORIGINAL post and creates
  nothing new. The same id with anything different is `IDEMPOTENCY_CONFLICT`. `schedulePost()` has no `await`
  anywhere on its path, so a plain map lookup is enough to dedupe it correctly -- see PLAN.md for why that is a
  deliberate decision, not an oversight, and how it differs from project 22 (messaging) stage 2's async case.
- **`tick()` dispatches every channel, of every post, that is `pending` and due** (`nextAttemptAt <= now`, driven
  by the injected `Clock`, never a real timer). Due detection is per CHANNEL, not per post: a post with one sent
  channel and one still-pending channel keeps showing up to `tick()` until every channel is terminal.
- **Retry with exponential backoff, capped, up to `maxAttempts`; exhausting it dead-letters that channel only.**
  `backoffMs(attempt) = min(maxBackoffMs, initialBackoffMs * 2^(attempt-1))`. A channel that reaches
  `dead_letter` is never dispatched again by any later `tick()`, however far the clock advances.
- **A provider that throws is treated as a failed attempt, not a crash.** It counts as an attempt and goes
  through the normal retry path; it never rejects `tick()`'s batch and never affects a sibling channel dispatched
  in the same `tick()` call.
- **Cancel: `cancelChannel`/`cancelPost` work on any channel that is still `pending`**, including one that already
  failed once and is waiting for its next retry. Canceling an already-`sent` or `dead_letter` channel is a clean
  `CHANNEL_NOT_PENDING` error, changing nothing. `cancelPost` cancels every currently-pending channel of a post;
  if nothing is pending (everything already terminal) it is `NOTHING_PENDING`, not a silent no-op.
- **Edit is stricter than cancel.** `editPost` (content and/or `scheduledAt`) is only allowed while EVERY
  non-canceled channel still has zero attempts -- once any channel has been tried even once (even if it is still
  `pending`, awaiting a retry), the whole post is `POST_ALREADY_DISPATCHED` and cannot be edited. A channel that
  was explicitly canceled is skipped by this check (it is not holding anything up).
- **An error means nothing happened.** Every validation -- content length, channel list shape, unknown channel,
  a `scheduledAt` in the past, a malformed `clientRequestId` -- throws before anything is stored; the idempotency
  key stays free for a later valid retry with the same id.
- **In-flight protection without a job queue.** `tick()`'s only `await` is `provider.send()`. `attempts` is
  incremented SYNCHRONOUSLY right before that await, so a racing `editPost` sees `attempts > 0` immediately.
  `cancelChannel`/`cancelPost` have no such signal and use an explicit `dispatching` guard instead
  (`DISPATCH_IN_PROGRESS`); the same guard also stops two overlapping `tick()` calls from dispatching the same due
  channel twice. See `test/dispatch-guard.test.ts`, which uses a provider whose promise is resolved by hand --
  every other provider in this project resolves immediately, so nothing else in the suite actually overlaps.

## Design choices

See [PLAN.md](PLAN.md) for the reasoning behind each choice. In short:

- Channels are a Strategy (`FakeChannelProvider`); the scheduler never knows which fake (or, one day, real)
  provider is behind a channel key.
- Per-channel delivery is a map keyed by channel, not a single status on the post, for the same reason project 22
  keeps receipts per recipient: "delivered" is a property of a (post, channel) pair, not of the post alone.
- Time comes from an injected `Clock`; every due-time and backoff test sits exactly on its boundary without a
  real sleep.
- `tick()` is a poll, not a job queue with leases: stage 1 has one caller driving dispatch, never several workers
  racing for the same job, so a lease (for when ANOTHER caller might steal the job) is not needed. A lightweight
  `dispatching` set covers the one race that IS possible (the same caller's `tick()` called again, or a cancel,
  while a slow provider is still pending).
- Not used on purpose: a `failed` status next to `dead_letter` (one is always just a slower way to say
  "pending"), a retryable-vs-permanent distinction on provider failures (every failure retries until
  `maxAttempts`), the State pattern for a delivery (a status field with guarded transitions is enough).

## Tests

| File | Tests | What |
|---|---|---|
| test/schedule.test.ts | 35 | `schedulePost` validation (content, channels, scheduledAt, clientRequestId, each boundary), idempotency (replay, channel-order-independent, conflicts on each field, invalid request leaves nothing behind), fan-out, copies returned by `getPost`, constructor retry-policy validation |
| test/tick.test.ts | 12 | due detection (future post does not dispatch, exact boundary, no re-dispatch of a sent channel), per-channel independence (one succeeds while a sibling fails-then-retries-then-succeeds, a throwing provider does not affect a sibling), retry/backoff (respects the delay, grows, capped), dead-letter (exhausts attempts, never retried again, does not affect a sibling channel) |
| test/cancel-edit.test.ts | 22 | `cancelChannel` (cancel-before-dispatch, leaves siblings alone, rejects sent/dead_letter/already-canceled, unknown post/channel), `cancelPost` (cancels every pending channel, `NOTHING_PENDING`, unknown post), `editPost` (content and/or scheduledAt, rejects after any attempt on any channel including mid-retry, allows editing around a canceled channel incl. one canceled mid-retry, validates the new content/scheduledAt, requires at least one field) |
| test/dispatch-guard.test.ts | 3 | a deferred (manually-resolved) provider proves `cancelChannel`/`cancelPost` refuse with `DISPATCH_IN_PROGRESS` while a send is actually in flight, and that two overlapping `tick()` calls never dispatch the same due channel twice |
| test/providers.test.ts | 7 | the three fake providers themselves: always-succeeds records attempts/sent, always-fails returns the configured reason, flaky fails exactly K times then succeeds per (postId, channel) independently, input validation |
| test/invariants.test.ts | 5 | randomized, 5 seeds x 250 operations (schedule, cancel-channel, cancel-post, tick-with-clock-advance) across many posts and 3 providers (always-succeeds, flaky, always-fails), settled to a fixed point, then: every channel is in exactly one of `pending/sent/dead_letter/canceled`; nothing terminal ever changes again or calls its provider again even far in the future; every post's delivery keys exactly match its channel list; every non-canceled channel is terminal after settling; each terminal state carries the fields it must (`sent` has `providerId`/`sentAt`, `dead_letter` has `lastError` and used every attempt, `canceled` has `canceledAt`) |

## Mutation checks

35 deliberate breaks, each applied alone via a throwaway script (never committed) with the full suite run against
it, the file restored byte for byte. All 35 are caught. Four survived the first run and were real test gaps, now
closed:

- **E3** (editPost's `canceled`-skip removed): the existing "edit around a canceled channel" test canceled that
  channel BEFORE any attempt (`attempts === 0`), so removing the skip did not change the outcome -- the
  `attempts > 0` check never even looked at it either way. A new test cancels a channel AFTER one failed attempt
  (mid-retry, `attempts > 0`, status still `pending`) and then edits the post; added.
- **K1/K2/K3** (constructor's `maxAttempts >= 1` / `initialBackoffMs >= 0` / `maxBackoffMs >= initialBackoffMs`
  checks removed): there were no tests at all for the constructor's own validation. Added.

| Area | Breaks |
|---|---|
| idempotency | I1 fingerprint mismatch check inverted, I2 key never stored, I3 lookup always misses |
| schedulePost validation | V1 empty content accepted, V2 content max length ignored, V3 empty channel list accepted, V4 duplicate channels accepted, V5 unknown channel accepted, V6 past scheduledAt accepted, V7 non-integer scheduledAt accepted, V8 empty clientRequestId accepted |
| fan-out | F1 a new channel's nextAttemptAt ignores scheduledAt |
| cancelChannel | C1 pending check removed, C2 dispatching guard removed |
| cancelPost | P1 nothing-pending check removed, P2 dispatching guard removed |
| editPost | E1 at-least-one-field check removed, E2 attempts>0 check removed, E3 canceled-skip removed |
| tick / dispatching | T1 pending-status filter removed, T2 due-time filter removed, T3 dispatching-dedup filter removed, T4 dispatching.add() removed, T5 dispatching.delete() removed |
| dispatchChannel | A1 attempts never incremented, A2 dead-letter threshold off by one, A3 backoff never grows, A4 backoff cap not applied, A5 lastError never recorded, A6 providerId/sentAt never recorded, A7 sent/failed check inverted, A9 a provider throw not caught |
| constructor | K1 maxAttempts >= 1 removed, K2 initialBackoffMs >= 0 removed, K3 maxBackoffMs >= initialBackoffMs removed |

## Known and NOT handled

- **Everything is in memory.** A restart loses every post, delivery and idempotency key. A real version stores
  posts in a database and the idempotency keys with a TTL (as projects 21/22 eventually do).
- **No distinction between a retryable and a permanent provider failure.** Every failure retries until
  `maxAttempts`, then dead-letters -- a real provider failure like "account disconnected" or "invalid credentials"
  will never succeed no matter how many times it is retried, and should skip straight to `dead_letter` instead of
  waiting through the full backoff schedule. `ProviderResult` has room to add this (an extra field, same shape as
  project 21's `SendResult.retryable`) without a redesign.
- **One content length limit for every channel.** Real platforms differ wildly (Twitter-style short-form vs a
  long-form post); this project uses a single `MAX_CONTENT_LENGTH` for all channels, not a per-channel limit.
- **`tick()` is polled.** How quickly a due post actually dispatches depends on how often the caller calls
  `tick()`, same as project 21's `flushDue()`. There is no internal scheduler loop.
- **No job queue, no leases, one implicit caller.** `tick()` assumes a single caller driving dispatch (the
  `dispatching` set only protects against that SAME caller overlapping itself, e.g. a slow provider plus a second
  `tick()` call). Multiple worker processes racing to call `tick()` on a SHARED scheduler is not supported; that
  would need the lease/claim-token queue design project 21 (notification) stage 2 already built.
- **Idempotency keys never expire.** Memory grows with traffic; a real version bounds this with a TTL and a size
  cap (project 21 stage 2 does this with an LRU).
- **Editing the channel list itself is not supported.** `editPost` only changes `content`/`scheduledAt`; to add
  or remove a channel, cancel that one channel (or the whole post) and schedule a new one.
- **No per-post or per-user rate limiting**, and no cap on how many posts can be scheduled.
- **No HTTP API.** This is a plain library, same as projects 21/22's stage 1.
