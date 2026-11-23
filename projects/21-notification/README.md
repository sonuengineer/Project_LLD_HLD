# B19 Notification System (low-level design)

A TypeScript library (no runtime dependencies, in memory) for the core of a notification system: notification
types with templates per channel, user preferences and quiet hours, channel fallback, and idempotent requests.
Providers are fakes: nothing in this project sends a real email, SMS or push.

Status (2026-11-23): stage 1 DONE -- 81 tests, 43 deliberate code breaks all caught (see "Mutation checks").
Stages 2 and 3 are planned in [PLAN.md](PLAN.md), not built.

```
npm ci
npm test        # 81 tests
npm run demo    # OTP with fallback, a retried request, marketing deferred by quiet hours
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

- **Everything is in memory.** A restart loses records, keys and deferred deliveries. Stage 2 moves sends onto a
  queue; a real system stores records in a database.
- **No retries.** A retryable failure is final in stage 1 (in `first` mode the next channel is tried). Stage 2.
- **Idempotency keys never expire** (memory grows with traffic). Stage 2 bounds them.
- **Fixed UTC offset per user, no DST.** A user in a DST zone is off by an hour for half the year. A real version
  stores an IANA zone and uses `Intl` / a tz library.
- **`flushDue()` is polled.** How late a deferred message goes out depends on how often it is called; a window with
  only a short gap (say quiet 00:15-00:00) needs flushes at least that often or the gap is missed and the message
  waits another day (the randomized test showed this with hourly flushes).
- **One address per channel** (one push token per user); multiple devices and removing dead tokens are stage 2.
- **Marketing defaults to allowed** (opt-out model). Some jurisdictions require opt-in for marketing SMS / email; that
  is a policy change in one function, not built.
