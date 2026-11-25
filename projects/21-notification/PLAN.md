# B19 Notification System (low-level design): plan

Status (2026-11-25): stage 1 DONE (catalog, templates, preferences and quiet hours, fake senders, notifier with `all` / `first` modes, idempotency, flushDue that plans a due delivery again). Stage 2 DONE (queue with leases and priorities, workers, retries as delayed jobs, per-channel timeout and circuit breaker, frequency caps, bounded idempotency keys). 126 tests; 77 mutation checks, all caught (README). Stage 3 not started.

## Why this project

"Design a notification system" is asked both as an LLD round (classes for types, templates, preferences, channels)
and as an HLD round (queues, workers, retries, rate limits, millions of users). The follow-ups are where it gets hard:
the user opted out, it is 3 a.m. where the user lives, push failed so fall back to SMS, the client retried the request
so the user must not get the OTP twice. Stage 1 builds the LLD core so each of those is a small, local rule with a
test. Stage 2 adds the HLD half (queue, workers, retries, caps) using the libraries built in projects 18-20.

## Decisions (one recommendation each)

- **TypeScript, a library with no runtime dependencies, in memory.** Same toolchain as projects/17-parking-lot.
  Providers are fakes: no real email, SMS or push is ever sent from this project.
- **A catalog of notification TYPES, validated at registration.** A type has a category (`transactional` |
  `marketing`), an ordered list of channels, a delivery mode and one template per channel. A missing template or an
  unknown channel is an error when the type is registered (at startup), not when the first user triggers it.
- **Two delivery modes.** `all`: send on every allowed channel (an order update by push AND email). `first`: try the
  channels in order and stop at the first that succeeds (an OTP by push, else SMS, else email). Recommended over one
  mode with flags: these are the two shapes real products need, and the difference is tested.
- **Category decides which preferences apply.** Marketing respects channel opt-outs and quiet hours. Transactional
  (OTP, password reset, receipt) ignores both, only a missing address skips a channel. Recommended over letting a user
  mute everything: a muted OTP locks the user out, and transactional messages are generally exempt from marketing
  consent rules.
- **Quiet hours defer, they do not drop.** In the user's local time (fixed UTC offset per user), SMS and push of a
  marketing message are deferred to the end of the window; email is not deferred (it does not wake anyone). The
  window may cross midnight; the end is exclusive. `flushDue()` sends what has come due. DST is not handled (a fixed
  offset), documented, not hidden.
- **Templates: `{{name}}` / `{{a.b}}` placeholders, a missing variable is an error.** Recommended over rendering an
  empty string: "Your OTP is " is worse than no message. Email bodies are HTML, so values are HTML-escaped there and
  only there (SMS and push are plain text).
- **Channels are a Strategy: `ChannelSender.send(message) -> sent | failed(retryable, reason)`.** A sender that throws
  is treated as a retryable failure (the outcome is unknown). Stage 1 does not retry; a failure in `first` mode falls
  through to the next channel. Stage 2 adds retries.
- **Idempotency key per request, registered before the first await.** A duplicate (sequential or concurrent) gets the
  same record and no second send. The same key with a different payload is an error (as Stripe does), not a silent
  "first one wins". Keys are kept in memory without expiry in stage 1 (stage 2 bounds them).
- **Check everything, then change state** (as projects/17-parking-lot): unknown type or user, a missing template
  variable or a channel without a sender throw before anything is stored, so an error means "nothing happened" and
  the idempotency key is still free.
- **Time from an injected Clock.** Quiet hours and deferral are tested at their boundaries without waiting.
- **Patterns NOT used, on purpose:** no Singleton notifier (tests create many), no class per notification type (a type
  is data, not behaviour), no State pattern for a delivery (a status field with guarded transitions is enough).

## Stage 2 decisions (one recommendation each)

- **A second notifier, not a flag on the first.** `QueuedNotifier` queues the sends and returns at once; the stage 1
  `Notifier` stays as the in-process version. Both share `planner.ts` (validate, render, plan, build the record, send
  once), extracted from stage 1 with its tests unchanged as the regression guard.
- **The queue has leases (visibility timeout).** A claimed job is invisible for `leaseMs`; a dead worker's job comes
  back. Delivery is therefore at-least-once, so every send carries a provider idempotency key
  `<notificationId>:<channel>` that is the same on every attempt. Only the current lease holder may write a result
  or complete the job. `leaseMs` must be greater than the send timeout, so a healthy worker always finishes inside its
  lease. Recommended over a "processing" flag (a crash leaves it set forever) and over exactly-once claims (needs a
  transaction spanning the provider call, which does not exist).
- **Retries are jobs back in the queue (`runAt = now + backoff`), not sleeps in the worker.** Recommended over
  resilience-kit's RetryPolicy here: an in-process retry holds a worker slot while it waits and is lost with the
  process; a queued retry costs nothing while waiting and survives a crash. The library still supplies the backoff
  (`exponentialBackoff`), a `TimeoutPolicy` per send and a `CircuitBreaker` per channel.
- **Only retryable failures count against the breaker.** A permanent failure (bad number) is the provider working.
- **Circuit open: "first" fails over now, "all" waits for the probe without using an attempt.** "first" exists to
  route around a channel (an OTP should not wait 30 s); "all" must reach every channel, and burning attempts while no
  call is even made would fail it without a single real try.
- **Priority: transactional before marketing.** Two levels, strict. Starvation of marketing under constant
  transactional load is possible and documented (aging not built).
- **Deferred deliveries are delayed jobs** (`runAt = notBefore`), so there is no `flushDue` poll; the job plans the
  channel again when it runs (stage 1's lesson).
- **Frequency caps (ratelimit-kit), marketing only, on the first try only.** Over the cap -> skipped `capped`, not
  deferred (a backlog of old promotions is worse than none). A retry of an admitted delivery does not count again.
  The cap's store failing -> the job waits (neither uncapped sends nor drops).
- **Idempotency keys in a cache-kit `LruCache`: 24 h TTL, `maxEntries` bound.** After the TTL or an LRU eviction the
  same key creates a new notification (as with Stripe's 24 h keys); the bound is the price of not growing forever.
- **The libraries are `file:` dependencies on their built `dist/`.** Using them from another project found a real
  gap: all three built without type declarations, so a TypeScript consumer got no types. Fixed with
  `"declaration": true` in each library's build config.

## Stages

| Stage | What | Status |
|---|---|---|
| 1 | Catalog (types, categories, channels, modes, templates), template rendering, preferences (opt-out, quiet hours with deferral), fake channel senders, notifier (`all` / `first` with fallback, idempotency incl. concurrent duplicates, check-then-change), `flushDue`; randomized invariant test; mutation checks | DONE 2026-11-23 |
| 2 | Queue with leases and priorities, workers, retries as delayed jobs with backoff, timeout and circuit breaker per channel (resilience-kit), per-user frequency caps (ratelimit-kit), bounded idempotency keys (cache-kit), deferred deliveries as delayed jobs; randomized test with dying workers; mutation checks | DONE 2026-11-25 |
| 3 | HTTP API (Express), in-app inbox, several push tokens per user (dead tokens removed), provider delivery receipts, interview bank, portfolio page | not started |

## Not in scope

Real providers (SES, Twilio, FCM), unsubscribe links and legal compliance text, localisation, A/B tests, analytics.
