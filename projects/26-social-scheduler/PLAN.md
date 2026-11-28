# B22 Social Media Post Scheduler (low-level design): plan

Status (2026-11-28): stage 1 DONE -- 84 tests, 35 mutation checks, all caught. Stage 2 DONE -- 90 tests (+6),
13 new mutation checks (+13), all caught, no survivors.

## Why this project

"Build your own Buffer/Postiz" is a realistic LLD prompt that shows up whenever a system needs to DO something at
a future time, independently, per target, with retries -- the same shape as a cron-like job runner, a webhook
delivery system, or a multi-region deployment fan-out. The interesting follow-ups are: what does "scheduled" mean
precisely (validate now or at send time?), what happens when one of several targets is temporarily down (does it
block the others?), how many times do you retry before giving up, and can the caller take it back before it goes
out? Stage 1 builds the core so each of those is one rule with a test, following this repo's project 21
(notification) and project 22 (messaging) philosophy exactly: fake providers, nothing is ever really sent over a
real network.

## Decisions (one recommendation each)

- **TypeScript, zero runtime dependencies, in memory.** Same toolchain as the rest of this repo's B-series
  projects. Channels are a Strategy (`FakeChannelProvider`); no real LinkedIn/Twitter/Mastodon API is ever called.
- **A channel is just a string key into a `providers` map the caller supplies at construction.** Recommended over
  a closed enum of named platforms: the whole point of "these are fake providers" is that the scheduler does not
  care what a channel IS, only that something is registered to handle it. `schedulePost` rejects any channel key
  with no registered provider (`UNKNOWN_CHANNEL`) -- caught at request time, not at dispatch time.
- **One status enum per channel, not two.** A channel's `status` is `pending | sent | dead_letter | canceled` --
  there is deliberately no separate `failed` status sitting next to `dead_letter`. A failed attempt that still has
  retries left stays `pending` (it is awaiting its next attempt, same as before its first attempt); only
  EXHAUSTING every attempt is terminal, and that terminal state is `dead_letter`. Recommended over a transient
  `failed` status with a boolean "will retry" flag: it would just be a second way to say "pending", and this repo's
  rule is "a status field with guarded transitions is enough" (see projects 21/22) rather than two fields that have
  to agree.
- **Per-channel fan-out: one independent `ChannelDelivery` per channel, keyed by channel in a plain object.**
  Mirrors project 22's per-recipient receipt map. One channel's provider failing, throwing, or exhausting retries
  must never touch another channel's `attempts`, `status` or `nextAttemptAt` -- verified directly (two providers,
  asserting one's counters are untouched by the other's retries) and by the randomized invariant test.
- **Idempotent scheduling via a caller-supplied `clientRequestId`, with NO synchronous claim needed.** Unlike
  project 22 (messaging) stage 2, where a REAL `await` before the commit meant a plain map lookup could not dedupe
  truly concurrent duplicates and a synchronous *claim* (`pendingOps`/placeholder entry) was required first,
  `schedulePost()` here is fully synchronous end to end: validate, build the record, store it, register the key --
  no `await` anywhere in that path. A plain "check the map, then set it" is therefore already safe: JavaScript
  runs the whole function body as one turn, so a second call with the same key can only start after the first one
  has already returned and the key is already set. This is a DELIBERATE decision (see messaging's PLAN.md for the
  contrast), not an oversight -- `tick()` is the only place this project ever awaits anything, and `tick()` is not
  on the scheduling path at all. The same `clientRequestId` with the same (content, channels-as-a-set, scheduledAt)
  fingerprint returns the original post and creates nothing new; a different fingerprint is `IDEMPOTENCY_CONFLICT`
  (channel order does not matter, mirroring project 21's "key order inside `data` does not matter").
- **Due-post dispatch is a polled `tick()`, not a queue with leases.** Recommended over project 21 stage 2's job
  queue (leases, workers, priorities) because stage 1 has exactly one caller driving dispatch in a loop, never
  several workers racing for the same job -- a lease (a timeout that lets ANOTHER caller steal the job) solves a
  problem this stage does not have. What stage 1 does need is protection against the SAME caller's `tick()` being
  called again before a slow provider resolves (or a cancel racing an in-flight send); a lightweight `dispatching`
  set (`"postId:channel"` currently awaiting `provider.send()`) covers exactly that, at a fraction of a queue's
  complexity. A real multi-worker version (stage 2, if it happens) would need the lease/claim-token design project
  21 already built, reused wholesale rather than redesigned.
- **Retry: exponential backoff via the injected Clock, capped, with a fixed `maxAttempts`; exhausting it
  dead-letters that one channel only.** `backoffMs(attempt) = min(maxBackoffMs, initialBackoffMs * 2^(attempt-1))`.
  Stage 1 made no distinction between a "retryable" and a "permanent" provider failure; stage 2 adds exactly that
  (see "Stage 2 decisions" below) without touching this formula at all -- a permanent failure skips straight past
  it, it does not change it.
- **`cancelChannel`/`cancelPost` use a plain "still pending" rule; `editPost` is stricter: zero attempts on every
  non-canceled channel.** Cancel is safe at any point before a channel's result is final, INCLUDING while it is
  mid-retry (`attempts > 0`, status still `pending`) -- there is nothing to undo, a provider call just never
  started it was always going to be tried again anyway. Editing CONTENT is different: once a provider has been
  asked to post something, even if that attempt failed, an edit cannot take back what the provider already saw on
  that attempt, and because content is one field on the POST (not per channel), a half-edited post would mean
  different channels show different text with no way to express that. So `editPost` requires every channel that
  is not already `canceled` to have `attempts === 0`; `cancelChannel`/`cancelPost` have no such requirement. Both
  rules are literally "only while still pending" in the sense the task described, but editing is the stricter of
  the two READING of that rule, deliberately, and this paragraph is that decision written down.
- **A provider that throws is treated as a failed attempt, never a crash.** Same rule as project 21's
  `ChannelSender`: the outcome is unknown (the provider may or may not have actually posted), so it is NOT treated
  as "nothing happened" -- it counts as an attempt and goes through the normal retry/backoff/dead-letter path, and
  it must not reject `tick()`'s `Promise.all` and take down every OTHER channel's dispatch in the same tick.
- **`attempts` is incremented SYNCHRONOUSLY, before the only `await` in this file.** This is what lets `editPost`
  detect "this channel has already been tried" without any extra guard: by the time a racing `editPost` call could
  run, `attempts` is already `> 0` if a send is in flight. `cancelChannel`/`cancelPost` have no such signal (status
  stays `pending` throughout the send), so they use the `dispatching` guard instead and refuse with
  `DISPATCH_IN_PROGRESS`. (Both facts are proven by `test/dispatch-guard.test.ts`, using a provider whose promise
  is resolved manually -- every OTHER provider in this project resolves immediately, so without that file nothing
  would ever actually overlap with an in-flight send.)
- **Patterns NOT used, on purpose:** no job queue with leases (see above), no State pattern for a delivery (a
  status field with guarded transitions is enough, same as projects 21/22), no per-channel content length limit
  (one `MAX_CONTENT_LENGTH` for every channel -- see "Known and NOT handled"), no Singleton scheduler (tests
  create many).

## Stages

| Stage | What | Status |
|---|---|---|
| 1 | Schedule a post against N channels with idempotent scheduling, per-channel fan-out and status, `tick()`-driven due dispatch, retry with exponential backoff and dead-letter, cancel/edit before dispatch; randomized invariant test; mutation checks | DONE 2026-11-28 |
| 2 | Retryable-vs-permanent distinction on provider failures: `ProviderResult`'s failed variant gains an optional `retryable` field; a permanent failure (`retryable: false`) dead-letters its channel immediately instead of retrying until `maxAttempts` | DONE 2026-11-28 |

## Stage 2 decisions (one recommendation each)

- **`ProviderResult`'s failed variant gains `retryable?: boolean`, OPTIONAL and defaulting to `true` (retryable)
  when omitted.** Mirrors project 21 (notification)'s `SendResult.retryable` in name and meaning -- a `false`
  means "this will never succeed no matter how many times it is retried" (account disconnected, invalid
  credentials). It differs from project 21 in one way: there, `retryable` is a REQUIRED field on `SendResult`,
  because every sender in that project was written to decide it from the start. Here, stage 1 already shipped
  three `FakeChannelProvider`s (`AlwaysSucceedsProvider`, `AlwaysFailsProvider`, `FlakyProvider`) and real callers
  that return `{ status: "failed", reason }` with no `retryable` key at all -- making it required would be a
  breaking type change for all of them. Making it optional, with "absent means retryable" as the explicit rule
  (`dispatchChannel` checks `result.retryable === false`, not `!== true`), means every stage-1 failure path keeps
  behaving exactly as it did, with zero code changes, which is exactly the backward compatibility this task asked
  for. The provider-throws path (`catch` in `dispatchChannel`) also returns no `retryable` key, so a throw stays
  retryable, same as stage 1 and the same rule project 21 uses for a sender that throws.
- **`dispatchChannel`'s failure branch dead-letters on `permanent || attempts >= maxAttempts`, and `attempts` is
  incremented NORMALLY either way.** `attempts` is incremented once per call, before the provider is even invoked
  (unchanged from stage 1, for the same `editPost`-detects-in-flight reason documented above) -- a permanent
  failure does not get special treatment there. Recommended over decrementing it back to "pretend this attempt
  did not count": it did count, the provider really was called once and really did answer, and `attempts` is a
  record of how many times that happened, not a record of how many times a retry COULD have happened afterward.
  Keeping the same counter also keeps `ChannelDelivery.attempts` meaning one single thing everywhere it is read
  (diagnostics, the randomized invariant test, a future API) instead of needing a second field to express "real
  attempts" vs "attempts that counted toward the retry budget". `lastError` is set exactly the same way for a
  permanent failure as for a retryable one.
- **A new fake provider is a CONSTRUCTOR OPTION on `AlwaysFailsProvider`, not a new class.** Its signature becomes
  `constructor(reason = "...", retryable = true)`. Considered and rejected: a separate
  `AlwaysFailsPermanentlyProvider` class. Stage 1 already draws the class-vs-option line elsewhere in this exact
  file -- `FlakyProvider`'s `failCount` is a constructor option that changes how many times it fails before
  succeeding, not a family of classes (`FailsTwiceThenSucceedsProvider`, `FailsOnceThenSucceedsProvider`, ...).
  "Always fails" is already the one behavior `AlwaysFailsProvider` models; whether that failure is retryable or
  permanent is a configuration of the SAME behavior, exactly like `FlakyProvider`'s knob, not a new behavior that
  needs its own Strategy implementation. The default (`retryable = true`) keeps every stage-1 call site
  (`new AlwaysFailsProvider()`, `new AlwaysFailsProvider("some reason")`) unchanged, and `send()` only emits the
  `retryable` key on the result at all when it is `false` -- so the existing `providers.test.ts` assertion
  `toEqual({ status: "failed", reason: "nope" })` (no `retryable` key) keeps passing unmodified. `FlakyProvider`
  is untouched: its failures model a platform that is temporarily down and recovers, which is inherently
  retryable, so it has no reason to ever report a permanent failure.
- **Backward compatibility was verified directly, not assumed.** Every one of stage 1's 84 tests was re-run
  unmodified after this change and all still pass (confirmed below, 90 total now, the +6 are new). The mutation
  pass specifically targeting this feature (13 breaks, listed in README.md's Mutation checks) includes a
  permanent-failure-specific regression check: forcing `AlwaysFailsProvider`'s default to `retryable = false`
  broke 12 existing stage-1 tests (including the original dead-letter-after-`maxAttempts` test), proving those
  tests really do pin stage 1's "default is retryable" behavior rather than just happening to pass.

## Not in scope

Real social platform APIs (and OAuth to them), per-channel content length/format rules (Twitter's 280 characters
vs LinkedIn's 3000), media attachments, a job queue with leases for multiple concurrent dispatch workers, an HTTP
API, analytics/engagement tracking, scheduling recurring posts, draft/approval workflows, team permissions.
