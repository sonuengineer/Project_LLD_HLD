# B19 Notification System (low-level design)

A TypeScript library (in memory) for the core of a notification system: notification types with templates per
channel, user preferences and quiet hours, channel fallback and idempotent requests (stage 1); a job queue with
leases and priorities, workers, retries with backoff, a circuit breaker and a timeout per channel, frequency caps and
bounded idempotency keys (stage 2). Providers are fakes: nothing in this project sends a real email, SMS or push.

Status (2026-11-25): stages 1 and 2 DONE, stage 3 in progress (HTTP API, delivery receipts, several push devices, in-app inbox done) -- 192 tests; mutation checks in "Mutation checks" (stage 1) and
"Stage 2: mutation checks" and "Stage 3: HTTP API". The rest of stage 3 (the interview bank and the
portfolio page) is planned in [PLAN.md](PLAN.md).

Stage 2 uses three libraries from this repo as `file:` dependencies on their built `dist/`:
[resilience-kit](../18-resilience) (backoff, timeout, circuit breaker), [ratelimit-kit](../19-rate-limit)
(frequency caps) and [cache-kit](../20-cache) (idempotency keys). Build them once before installing:

```
npm run build:deps    # npm ci + npm run build in 18-resilience, 19-rate-limit and 20-cache
npm ci
npm test              # 192 tests
npm run demo          # stage 1: OTP with fallback, a retried request, marketing deferred by quiet hours
npm run demo:queue    # stage 2: a retry with backoff, a dead push provider (breaker open, OTP fails over), a cap
```

## Usage

```ts
const catalog = new NotificationCatalog();
catalog.register({
  id: "otp",
  category: "transactional",      // ignores mutes and quiet hours
  mode: "first",                  // push, else sms, else email -- stop at the first success
  channels: ["push", "sms", "email"],
  templates: {
    push: { body: "Your code is {{code}}" },
    sms: { body: "Your code is {{code}}" },
    email: { subject: "Your code", body: "<p>Your code is <b>{{code}}</b></p>" },
  },
});

const notifier = new Notifier({ catalog, users, preferences, senders: [pushSender, smsSender, emailSender] });
const record = await notifier.notify({ typeId: "otp", userId: "u1", data: { code: "482913" }, idempotencyKey: "login-7f3a" });
// record.deliveries: push failed (token expired), sms sent, email skipped (not_needed)

setInterval(() => notifier.flushDue(), 60_000); // sends deferred deliveries that have come due
```

## The rules

| Situation | Transactional | Marketing |
|---|---|---|
| No address for the channel (blank counts as none) | skipped `no_address` | skipped `no_address` |
| User muted the channel for marketing | sent anyway | skipped `opted_out` |
| SMS / push inside the user's quiet hours (local time) | sent anyway | deferred to the end of the window |
| Email inside quiet hours | sent | sent (email wakes nobody) |

All of it is one function, `planChannel` in [src/policy.ts](src/policy.ts).

- **Modes.** `all`: every allowed channel, in parallel; one failing does not stop the others. `first`: in order, the
  first success wins and every channel still waiting becomes `skipped (not_needed)`. A permanent failure, a
  retryable one and a sender that throws all fall through to the next channel (stage 1 has no retries).
- **Quiet hours** are `HH:MM` start (inclusive) and end (exclusive) in the user's local time, from a fixed UTC offset
  per user; the window may cross midnight. A marketing message in `first` mode whose push and SMS are deferred is
  delivered by email at once if email is allowed (the first channel that can deliver NOW wins).
- **Deferred deliveries are planned again when they come due.** `flushDue()` re-applies the rule with the user's
  current preferences, address and time: the delivery may be sent, deferred again or skipped. Found by the randomized
  test: the first version sent whatever was due, so a flush that ran late (the next evening) sent a marketing push
  inside the NEXT night's quiet hours, and a user who muted a channel after the deferral still got the message.
- **Templates.** `{{name}}` and `{{a.b}}`; a missing, null or undefined value is an error (no "Your code is " with
  nothing after it); objects, arrays, NaN and Infinity are refused; only the data's own properties are read
  (`{{constructor}}` is missing, not `function Object()`). Email bodies are HTML-escaped, subjects and SMS / push
  are not. Values are not rendered again (a value `"{{b}}"` stays literal).
- **Catalog checks at registration:** id format, category, mode, channels (known, not repeated), exactly one template
  per listed channel, a subject for email and only for email, no malformed `{{`. The catalog stores a copy.
- **Idempotency.** The key is registered in the synchronous part of `notify()`, before any await, so 20 concurrent
  identical requests make one record and one send, and all 20 get the final record. The same key with a different
  type, user or data is `IDEMPOTENCY_CONFLICT` (key order inside `data` does not matter). A duplicate of a failed
  notification does not resend: retrying is a delivery concern (stage 2), not the key's.
- **An error means nothing happened.** Unknown type or user, a missing template variable, a bad key or data, or a
  channel of the type with no sender throw before anything is stored; the key stays free. Every channel of the type
  is rendered and must have a sender even if this user would skip it, so whether a request is valid does not depend
  on who the user is or what time it is.
- **One runner per record.** `flushDue()` skips a record whose sends are still running, so a delivery is never sent
  twice and `first` mode never sends two channels; two concurrent `flushDue()` calls send a due delivery once.

## Design choices

See [PLAN.md](PLAN.md) for the reasoning behind each choice. In short:

- Channels are a Strategy (`ChannelSender`); the notifier never knows which provider is behind one.
- A notification type is data in a catalog, not a class per type.
- Time comes from an injected `Clock`; tests sit exactly on window boundaries.
- Not used on purpose: a Singleton notifier, a class per type, the State pattern for a delivery (a status field
  with guarded changes is enough).

## Tests

| File | Tests | What |
|---|---|---|
| test/template.test.ts | 9 | placeholders, missing values, own properties only, escaping, no re-render, malformed braces |
| test/catalog.test.ts | 17 | valid types, 14 kinds of invalid type, duplicate id, stored copy |
| test/policy.test.ts | 11 | quiet-hour boundaries (both window shapes, offsets, before 1970), preference validation, the rule table |
| test/notifier.test.ts | 29 | modes, fallback, throwing / garbage senders, parallel `all`, preferences, deferral and flushDue (incl. concurrent flushes and a busy record), planning again at send time, errors leave no trace |
| test/idempotency.test.ts | 7 | retry, 20 concurrent duplicates, key order, conflicts (also while the first is sending), failed notification |
| test/invariants.test.ts | 8 | randomized, 8 seeds x 300 requests with retries, random preferences, offsets, quiet windows and provider failures: every send is checked at the moment it happens against rules re-computed independently (Date arithmetic, not policy.ts); one record per key; provider calls = recorded attempts |

## Mutation checks

43 deliberate breaks, each applied alone with the suite run against it, the file restored byte for byte. All 43
are caught. Two survived the first run and were test gaps, now closed: Q5 (a plain `%` for times before 1970 -- the
test used 23:00, where the wrong arithmetic happens to give the right answer; noon added) and C2 (the duplicate
channel check -- the test's type was also invalid for another reason).

| Area | Breaks |
|---|---|
| policy | P1 transactional respects mutes, P2 email deferred too, P3 mutes ignored, P4 no-address ignored for transactional |
| quiet hours | Q1 end inclusive, Q2 start exclusive, Q3 midnight-crossing end on the wrong day, Q4 offset sign, Q5 negative modulo, Q6 end inclusive after midnight, Q7 start = end accepted, Q8 offset not validated |
| templates | T1 no escaping, T2 inherited properties readable, T3 undefined rendered, T4 malformed braces accepted, T5 subject escaped, T6 escape order (double escaping), T7 NaN / Infinity rendered |
| catalog | C1 caller's object stored, C2 duplicate channel accepted, C3 template for an unlisted channel accepted, C4 subject on non-email accepted |
| notifier | N1 conflict not detected, N2 key order matters, N3 `first` keeps going after a success, N4 busy record flushed, N5 no planning again at flush, N6 missing sender not checked, N7 sender throw not caught, N8 garbage result trusted, N9 status ignores deferred, N10 `all` sequential, N11 `notBefore` kept on not_needed, N12 blank key accepted, N13 non-plain data accepted, N14 live record returned, N15 due at `notBefore` exclusive, N16 old address used at flush, N17 address kept when skipped, N18 deferred not marked not_needed, N19 key not registered, N20 status order |

## Known and NOT handled (stage 1)

(Stage 2 changes some of these: see "Stage 2: known and NOT handled".)

- **Everything is in memory.** A restart loses records, keys and deferred deliveries. Stage 2 moves sends onto a
  queue; a real system stores records in a database.
- **No retries.** A retryable failure is final in stage 1 (in `first` mode the next channel is tried). Stage 2.
- **Idempotency keys never expire** (memory grows with traffic). Stage 2 bounds them.
- **Fixed UTC offset per user, no DST.** A user in a DST zone is off by an hour for half the year. A real version
  stores an IANA zone and uses `Intl` / a tz library.
- **`flushDue()` is polled.** How late a deferred message goes out depends on how often it is called; a window with
  only a short gap (say quiet 00:15-00:00) needs flushes at least that often or the gap is missed and the message
  waits another day (the randomized test showed this with hourly flushes).
- **One address per channel** (one push token per user). Stage 3 changed this for push: several devices per user,
  dead tokens removed (see "Stage 3: several push devices").
- **Marketing defaults to allowed** (opt-out model). Some jurisdictions require opt-in for marketing SMS / email; that
  is a policy change in one function, not built.

## Stage 2: the queued notifier

```ts
const queue = new InMemoryJobQueue();
const notifier = new QueuedNotifier({
  catalog, users, preferences, senders: [pushSender, smsSender, emailSender], queue,
  retry: { maxAttempts: 3, backoff: exponentialBackoff({ initialMs: 1_000, maxMs: 300_000 }) },
  sendTimeoutMs: 10_000,                       // per provider call (resilience-kit TimeoutPolicy)
  leaseMs: 60_000,                             // must be > sendTimeoutMs
  breaker: { windowSize: 20, minimumCalls: 5, failureRateThreshold: 0.5, openMs: 30_000 }, // one per channel
  frequencyCap: new RateLimiter({ algorithm: slidingWindow({ limit: 3, windowMs: 86_400_000 }), store }),
  idempotency: { ttlMs: 86_400_000, maxEntries: 100_000 },
});
const record = notifier.notify(request); // synchronous: validates, stores, queues; an HTTP layer answers 202
new Worker(notifier, { concurrency: 4 }).start(); // run as many as you like against the same queue
```

`notify()` no longer sends. It validates, stores the record and queues one job per delivery (`all`) or one for the
first channel (`first`), and returns. Workers claim jobs and send. What one job does is described at the top of
[src/queued-notifier.ts](src/queued-notifier.ts); the rules:

| Situation | What happens |
|---|---|
| Retryable failure, timeout, sender throws | back in the queue at `now + backoff(attempt)`; attempts used up -> `failed` (`first`: next channel) |
| Permanent failure | `failed` at once, not retried, not counted by the breaker (`first`: next channel) |
| Channel's circuit open | no provider call. `first`: fail over to the next channel now. `all`: back in the queue for when the breaker allows a probe, no attempt used |
| Deferred by quiet hours | a delayed job at `notBefore`; planned again when it runs (may defer again, skip or send) |
| Marketing over the user's cap for that channel | `skipped (capped)`, not delayed; checked on the first try only (a retry of an admitted delivery is not counted again) |
| The cap's store is down | the job waits and tries again later: no send without the cap, no drop either |
| Worker dies or stalls holding a job | the lease runs out, another worker gets the job; the old worker's result is dropped |
| Job for a delivery that already finished (crash before `complete`) | dropped, nothing sent |
| Same idempotency key within 24 h | the same record, nothing queued; a different payload is `IDEMPOTENCY_CONFLICT` |

- **Priorities.** Transactional jobs (0) are claimed before marketing jobs (1), then by `runAt`, then first in first
  out. An OTP queued after any number of promotions is claimed first.
- **At-least-once.** A worker that sent and then stalled past its lease loses the job to another worker, which sends
  again. Every send carries the same provider idempotency key `<notificationId>:<channel>` on every attempt, so a
  provider that supports keys drops the duplicate. The fakes here do not dedupe; the tests check the key, not a
  provider.
- **Leases are checked before every write.** A worker writes a result, reschedules or completes only while its lease
  token is current and has not run out.

### Stage 2: tests

| File | Tests | What |
|---|---|---|
| test/queue.test.ts | 5 | claim order (priority, runAt, FIFO), delayed jobs wait, `max`, lease tokens (stale holder refused, expired lease lost), reschedule releases |
| test/queued.test.ts | 29 | notify queues and returns; `all` in one batch; priorities; errors leave nothing; retries and backoff timing; attempts used up in both modes; permanent failure; timeout aborts the sender's signal; breaker (`first` fails over, `all` waits without an attempt, permanent failures not counted); leases (dead worker, stalled worker's late result dropped, redelivered finished job, unexpected error); quiet hours as delayed jobs; caps (incl. the 36 h case below, transactional never capped, store down, store failing after the lease was lost); a skipped retry drops `nextAttemptAt`; key TTL and LRU eviction |
| test/worker.test.ts | 5 | real timers: start / stop, `start()` twice is one loop, stop waits for the job in progress, several workers never process one job twice |
| test/queued-invariants.test.ts | 6 | randomized, 6 seeds x 250 requests, 3 workers, random provider answers, client retries, workers that die holding jobs, the clock jumping around quiet windows: the rules are checked at every provider call (re-computed in the test), and at the end every job is gone, every record is finished, `first` sent at most one channel, attempts <= 3, a failure has a reason, each sent delivery was sent once |

The 81 stage 1 tests are unchanged and still pass against the shared `planner.ts`.

### Stage 2: mutation checks

The stage 1 breaks were moved to their new places in `planner.ts` and run again (all 43 caught), plus 34 new ones,
each applied alone with the suite run against it, the file restored byte for byte. All 77 are caught. Three survived
the first run and were test gaps, now closed:

- **S22**: the lease check after the cap store fails. With it gone, a worker that stalled past its lease while
  waiting on a failing cap store wrote `pending` over a delivery the new owner had already SENT. Test added.
- **S24**: a delivery waiting for a retry that is skipped when the retry runs (its address was removed) kept its
  `nextAttemptAt`. Test added.
- **W2**: the `start()`-twice guard. The old test called `start()` twice but could not see a second loop; the new one
  uses concurrency 1 and checks that a second job waits.

J6 and S6 are caught by a hang, not by a failing assertion: with the `runAt` check gone (J6) or a deferral
rescheduled for `now` (S6), a job is claimed again at once, over and over, and the suite never finishes; the runner
stops it after 180 s and counts it as caught.

| Area | Breaks |
|---|---|
| queue | J1 priority ignored, J2 expired leases never reclaimed, J3 any token accepted, J4 expired lease still owns, J5 reschedule keeps the lease, J6 delayed jobs claimable early |
| queued notifier | S1 one priority for all, S2 `first` picks a deferred channel before a pending one, S3 next channel not queued after a finish, S4 finished delivery processed again, S5 no planning again in the job, S6 deferral rescheduled for now, S7 transactional capped, S8 a retry counted by the cap again, S9 attempts not counted, S10 permanent failures counted by the breaker, S11 no failover on an open circuit, S12 requeue ignores the breaker's reopen time, S13 no lease check after the send, S14 one attempt too many, S15 permanent failures retried, S16 backoff does not grow, S17 `first` sends past a success, S18 conflict not detected, S19 `leaseMs <= sendTimeoutMs` accepted, S20 no timeout, S21 deferred job queued for now, S22 no lease check after the cap store fails, S23 key not stored, S24 `nextAttemptAt` kept on a skip, S25 provider key changes per attempt |
| worker | W1 stop does not wait, W2 `start()` twice runs two loops, W3 drain stops after one round |

### Stage 2: known and NOT handled

- **Still in memory, one process.** The queue, records and keys live in the process. The queue's interface (claim
  with a lease, complete / reschedule with the token) is the shape of SQS, BullMQ or a Postgres table claimed with
  `FOR UPDATE SKIP LOCKED`; none of those is built. `claim()` scans every job (O(n)).
- **Records are never removed.** Keys are bounded (TTL and `maxEntries`); records are not. A real system keeps them
  in a database with a retention period.
- **A key is forgotten after 24 h or when evicted.** The same key then makes a NEW notification. That is the price
  of bounded memory (Stripe's keys expire after 24 h too).
- **Marketing can starve.** Priorities are strict: under constant transactional load, marketing jobs wait. Aging
  (raising a job's priority as it waits) is not built.
- **A cap of 1 per day can block for 36 h.** ratelimit-kit's sliding window counter weights the previous
  day-aligned window, so with a limit of 1 a send at 12:00 blocks until 00:00 UTC two days later. Pinned in a test.
  A small cap that must be exactly "24 h since the last one" needs a sliding log, not a counter.
- **The worker runs in batches.** It claims `concurrency` jobs and waits for the slowest before claiming again; a
  pool that refills each slot as it frees is not built.
- **Using the libraries found a gap in them.** All three built without type declarations, so this TypeScript
  consumer got no types. Fixed with `"declaration": true` in each library's `tsconfig.build.json`.

## Stage 3: HTTP API

```
NOTIFY_API_KEY=<at least 16 characters> PORT=3000 npm start   # API + a worker, fake senders, demo user u1
```

```
curl -i -X POST localhost:3000/notifications \
  -H "Authorization: Bearer $NOTIFY_API_KEY" -H "Content-Type: application/json" -H "Idempotency-Key: login-7f3a" \
  -d '{"typeId":"otp","userId":"u1","data":{"code":"482913"}}'
# 202 Accepted, Location: /notifications/<id>    (the same request again: 200, Idempotent-Replayed: true)
```

| Endpoint | Answers |
|---|---|
| `POST /notifications` (`Idempotency-Key` header, `{ typeId, userId, data }`) | 202 queued + `Location`; 200 replay + `Idempotent-Replayed: true`; 409 same key, different body |
| `GET /notifications/:id` | the record with each delivery and an overall `status`; 404 |
| `GET /users/:userId/preferences` | `{ mutedMarketing, quietHours? }` (defaults if never set); 404 for an unknown user |
| `PUT /users/:userId/preferences` | replaces them (not a merge); 200 with what was stored |

- **Auth:** `Authorization: Bearer <NOTIFY_API_KEY>` on every route, checked before the body is parsed, compared in
  constant time. There is no open mode; `createApp` refuses a key under 16 characters and `npm start` exits
  without one. The key lives only in the environment.
- **Errors** are `{ "error": { "code", "message" } }`. 400 malformed (`INVALID_JSON`, `INVALID_REQUEST`: missing or
  bad `Idempotency-Key`, wrong field types), 401 `UNAUTHORIZED`, 404 `NOT_FOUND`, 409 `IDEMPOTENCY_CONFLICT`,
  413 `BODY_TOO_LARGE` (64 KB), 415 `UNSUPPORTED_MEDIA_TYPE` (not JSON), 422 `UNKNOWN_TYPE` / `UNKNOWN_USER` /
  `TEMPLATE_VARIABLE_MISSING` / `INVALID_PREFERENCES`, 500 `INTERNAL` (message hidden, the error logged). As in the
  library, an error means nothing was stored and the idempotency key is still free.
- **Shutdown:** Ctrl+C / SIGTERM stops accepting connections, finishes requests in progress, then waits for the
  sends in progress. Tested through `startServer().close()`; the signal handler itself is not under test.
- **Express 4.22.3**, not the 4.21.2 used by project 20's tests: 4.21.2's body-parser, path-to-regexp and qs have
  published advisories, and here Express is a runtime dependency (`npm audit --omit=dev`: 0).

| File | Tests | What |
|---|---|---|
| test/http.test.ts | 15 | real Express on a random port: auth (5 bad headers, 401 before parsing, key length), 202 / Location / worker sends, replay, conflict, 9 malformed requests (none stores anything, the key stays free), 422s, 415 and 413, NO_SENDER and an unexpected throw as a hidden 500 that is logged, 404s (incl. PUT for an unknown user stores nothing), preferences GET / PUT applied to the next notification, invalid preferences keep the stored ones |
| test/server.test.ts | 2 | API + worker with real timers; `close()` waits for the send in progress, is one shutdown however often called, closes the port; a port in use rejects |
| test/policy.test.ts | +1 | preferences from untrusted input: `null`, non-objects, `quietHours: null` are `INVALID_PREFERENCES`, not a TypeError |

25 mutation checks on this layer (`src/http/`, the preference shape checks), each applied alone, the file restored
byte for byte, all caught: auth removed or moved after body parsing, `Bearer ` optional, key length boundary,
replay not detected, no `Location`, each body / header check removed, 422s turned into 400s, a 500 message not
hidden, body-parser errors not mapped, JSON content type not required (POST and PUT), the user check removed (GET and
PUT), no 404 fallback, no overall `status`, `startServer` not waiting for the worker / closing twice / not
rejecting on a port in use. One survived the first run: H15, a PUT for an unknown user was stored -- no test sent
one; added.

## Stage 3: delivery receipts

"Sent" only means the provider accepted the message. Later the provider calls a webhook with what happened:

```
POST /webhooks/push                         (no API key: the provider signs instead)
Content-Type: application/json
Notify-Signature: t=1795603753,v1=<hex HMAC-SHA256(NOTIFY_WEBHOOK_SECRET_PUSH, "1795603753." + raw body)>

{"providerId":"push-1","event":"bounced","occurredAt":1795603753000}
-> 200 {"result":"applied"} | 200 {"result":"unchanged"} | 202 {"result":"parked"}
```

The receipt appears on the delivery (`"receipt": { "event": "bounced", "at": ... }`) in `GET /notifications/:id`.
`signWebhook(secret, rawBody, nowMs)` is exported, for a fake provider or a test to act as the real one.

- **Signature:** one secret per channel's provider (`NOTIFY_WEBHOOK_SECRET_PUSH` / `_SMS` / `_EMAIL`; a channel
  without one has no webhook, 404). The HMAC covers the timestamp and the raw bytes, so any change to either is
  401, and a request more than 5 minutes old (or ahead) is 401 too: a captured request cannot be replayed later.
  The signature is checked before the body is parsed; the API key is not accepted instead.
- **Out of order and duplicates cannot matter.** A receipt only moves up: `delivered` < `bounced` (an email can be
  accepted and bounce later; a late `delivered` never undoes a bounce); between two of the same event the earlier
  time is kept. The result is the maximum of everything received, whatever the order or number of copies
  (randomized test: 300 event lists, each shuffled with duplicates 5 times). So no store of seen event ids.
- **A receipt can beat the send result** (the provider calls the webhook before our worker has written the answer).
  It is parked for up to 1 h (cache-kit LRU, 10 000 entries), merged like any receipt, and applied when the send is
  recorded; unknown ids just expire. Provider ids are unique per provider only, so the key is channel + id.
- **A bounced delivery counts as failed** in the notification's status (another channel that did not bounce still
  makes it delivered).

Not built: falling back to the next channel after a bounce, a suppression list (stop sending to an address that
bounced), `opened` / `clicked` events, the provider-index (`sentBy`) is never trimmed (it grows like the records).

| File | Tests | What |
|---|---|---|
| test/receipts.test.ts | 10 | merge rule (rank, tie, unchanged is the same object) and the randomized order / duplicates check; signatures (wrong secret, changed body, changed time, tolerance both ways at the exact edge, 8 malformed headers); applied / unchanged / late delivered after a bounce; bounce -> failed only if no other channel delivered; channel is part of the key; parked then applied at send, parked receipts merge; parked TTL |
| test/http.test.ts | +7 | webhook: signed receipt applied without the API key and visible in GET, unchanged on repeat; raw-bytes signature with the provider's own spacing and key order; 5 ways to be 401 (none, wrong, another channel's secret, replayed after 5 min, the API key); 404 and 415; 6 signed-but-malformed bodies are 400 and unsigned garbage is 401; parked -> 202; weak or misnamed secrets refused at startup |

24 mutation checks on receipts, each applied alone, all caught on the first run: ranking reversed, tie keeps the
later time, last event wins, unchanged not detected (a copy instead of the same object), future timestamps
accepted, no tolerance, timestamp not signed, header regex not anchored, signature not compared, parked receipts
not applied at send / overwritten instead of merged, provider id without the channel, a bounce not counted as
failed, signature not checked, parked answered 200, each receipt field check removed, weak or unknown-channel
secrets accepted, a non-JSON body reaching the verifier, the system clock instead of the injected one, a default
secret for channels without one. One test was tightened before the run: the parked-merge test sent delivered then
bounced, which "last one wins" would also pass; it now sends bounced first.

## Stage 3: several push devices

A user has a token per device (`pushTokens: string[]`, replacing `pushToken`). One push delivery goes to all of them:

```
POST   /users/u1/push-tokens            {"token":"<device token>"}   -> 204 (again: still 204, moved to newest)
DELETE /users/u1/push-tokens/<token>                                  -> 204, or 404 if it was not registered
```

- **Fan-out at send time.** The tokens are read when the job runs, and each gets its own provider call (in parallel,
  each through the channel's breaker and timeout) with its own provider idempotency key `<id>:push:<token>`.
  The delivery keeps a log, `devices: [{ token, status, providerId | error, retryable, removed? }]`.
- **The delivery's result:** sent if any device accepted (the user is reached; devices that failed that round are not
  retried). Otherwise: every call refused by an open circuit -> treated like stage 2's circuit open; some failure
  retryable -> retried later, only to the devices that did not fail for good; all permanent -> failed
  (`no device accepted (tok-a: ...; tok-b: ...)`), and `first` mode moves to the next channel.
- **Attempts are rounds, not calls:** 2 devices x 3 rounds is 6 provider calls and 3 attempts.
- **Dead tokens:** a permanent failure with `invalidAddress: true` (FCM `UNREGISTERED`, APNs 410) removes the token
  from the user; when the last one goes, the next push is `skipped (no_address)`. The removal happens even if the
  worker has lost its lease (the token is dead either way); the device log is written only after the lease check.
- **At most 10 tokens per user**, the oldest dropped. Tokens are non-empty, without spaces, at most 4096 characters.
  The API never returns the list: a token is enough to push to that device.
- Email and SMS (one address) and single-device push take exactly the old path; both notifiers share the fan-out.

Not built: per-device preferences (mute the tablet), the provider's own multicast API (one request for many tokens),
removing an email address or phone number reported invalid (only push tokens are removed).

| File | Tests | What |
|---|---|---|
| test/devices.test.ts | 16 | token rules (re-register moves to newest, cap drops the oldest, bad tokens and lists refused, returned copies cannot change the stored list); fan-out (a call and key per device in one round; one accepted + one dead -> sent and the dead one removed for next time; nobody accepted -> retry only to the device that can still work; all permanent -> failed and `first` moves on; all dead -> next push skipped no_address; 6 calls = 3 attempts; a device added between attempts gets the retry; a stalled worker does not overwrite the new owner's device log; `invalidAddress` on a retryable failure keeps the token; every device refused by an open circuit -> `first` fails over at once with no attempt used; a receipt for any device's id); the stage 1 Notifier fans out too; HTTP register / unregister / 404 / 400 / no registry |

21 mutation checks on this part, each applied alone, all caught. Two survived the first run and were test gaps,
now closed: D4 (a dead-token removal on a RETRYABLE failure flagged invalid -- no test sent that combination) and D6
(every device refused by an open circuit treated as an ordinary retryable failure, so an OTP waited instead of
failing over to SMS -- no multi-device test opened the breaker).

The push key changed from `<id>:push` to `<id>:push:<token>`; the 3 tests and the randomized checks that pinned the
old key were updated, nothing else in stages 1 and 2 changed.

## Stage 3: the in-app inbox

A fourth channel, `in_app`. Its sender (`InboxSender`) stores the message in `InMemoryInbox`, so a notification type
lists it like any channel: `channels: ["push", "email", "in_app"]`, `in_app: { subject: "Sale", body: "..." }` (the
subject is the item's title).

```
GET  /users/u1/inbox?limit=20&cursor=<nextCursor>   -> { items: [newest first], nextCursor: string | null, unread }
GET  /users/u1/inbox/unread-count                   -> { unread }
POST /users/u1/inbox/<itemId>/read                  -> 204 (already read: 204 too); 404 if not u1's item
POST /users/u1/inbox/read-all  {"upTo":"<itemId>"}  -> { marked, unread }
```

- **Channel rules:** the address is the user id, so `in_app` is never `no_address`; it wakes nobody, so quiet hours
  do not defer it (a marketing push at night is deferred, its inbox copy is not); marketing mutes apply; not
  HTML-escaped. The delivery's `providerId` is the inbox item id.
- **Paging with a cursor**, newest first. New items arriving between two page loads do not shift the next page (a
  page number would repeat items). The cursor is opaque and checked: anything this API did not return is
  `400 INVALID_CURSOR`. `limit` is 1..100 (digits only; `1e1` is refused), default 20.
- **The unread count is a stored counter**, changed only when an item really changes: marking an item that is already
  read does nothing, so two tabs marking it read lower the count once. A randomized test (2000 random adds, reads,
  read-alls and full page walks over 3 users) recounts the unread items from scratch after every step.
- **Read-all up to the newest item the user saw:** an item that arrived while the user clicked stays unread.
- **One item per message:** storing is keyed on the provider idempotency key `<id>:in_app`, so a retried or
  redelivered job does not add it twice.
- **Per-user lookups only:** an item id from another user's inbox is a 404, read or read-all.
- **Retention:** 200 items per user, the oldest dropped; an unread one dropped lowers the count.
- **Who may read whose inbox:** this API authenticates services (one API key), not end users. The app's backend must
  check that the logged-in user is the `:userId` it asks for.

Not built: a real-time push of new items to an open app (WebSocket / SSE; the app polls the count), deleting or
archiving items, a "read" receipt from the inbox feeding back into the notification, a time-based expiry.

| File | Tests | What |
|---|---|---|
| test/inbox.test.ts | 15 | paging (45 items in 20 / 20 / 5, each once, an exact fit has no empty extra page; new arrivals between pages; 5 bad cursors incl. a non-canonical one; limit bounds); idempotent add; mark read once / already read / another user's item; read-all up to the item seen; retention with read and unread items dropped; the randomized counter check; the channel end to end (inbox item with title, not escaped; quiet hours defer push not inbox; muted inbox opted_out; the same message twice is one item; catalog subject rules); HTTP (paging with the returned cursor, unread count, 6 bad limit / cursor queries, read twice, another user's item 404, read-all, unknown user, no inbox configured) |

20 mutation checks on the inbox, each applied alone, all caught on the first run: cursor not canonical, the cursor
item repeated on the next page, an empty extra page, add not idempotent, already-read decremented again, lookups
across users, read-all marking newer items, retention miscounting read items or leaving dropped ones findable, the
limit bound, the title dropped, a random storage key, `in_app` with no address, a subject refused for `in_app`, the
API's digits-only limit, `upTo` unchecked, a 404 turned into 204, the user check, the counter not raised or lowered.
One test was added before the run because the API's digits-only limit check was otherwise redundant for every case
tested (`limit=1e1` is 10 to `Number()`). `src/main.ts` (the `npm start` wiring) is not under test; the parts it
wires are.

