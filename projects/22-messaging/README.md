# B15 Messaging System (low-level design)

A TypeScript library (no runtime dependencies, in memory) for the core of a messaging system (WhatsApp / Slack
style): direct and group conversations, ordering, and per-recipient delivery and read receipts. There is no real
transport: nothing in this project sends anything over a network.

Status (2026-11-26): stage 1 DONE -- 50 tests, 37 mutation checks, all caught (see "Mutation checks").
Stage 2 is planned in [PLAN.md](PLAN.md), not built.

```
npm ci
npm test        # 50 tests
npm run demo    # direct chat, group chat, delivery/read receipts, a retried send, the join-time history cut
```

## Usage

```ts
const users = new InMemoryUsers();
users.upsert({ userId: "u1", displayName: "Asha" });
users.upsert({ userId: "u2", displayName: "Bilal" });

const messenger = new Messenger({ users });
const conv = messenger.createDirectConversation("u1", "u2");
const message = messenger.sendMessage(conv.id, "u1", "hey, free for a call?", "client-generated-id-1");
// message.seq === 1, message.receipts.u2 === { status: "sent", at: ... }

messenger.markDelivered(conv.id, "u2", message.id); // u2's client acks arrival
messenger.markReadUpTo(conv.id, "u2", message.seq); // u2 opens the chat
overallStatus(messenger.getMessage(conv.id, message.id)!); // "read"
```

## The rules

- **Order is a per-conversation sequence number, never a timestamp.** `createdAt` is stored for display only;
  nothing compares or sorts by it. Two servers' clocks disagreeing cannot reorder messages.
- **Delivery and read state is per recipient, not one status on the message.** `message.receipts[userId]` is
  `{ status: "sent" | "delivered" | "read", at }`. The status shown to the SENDER (`overallStatus(message)`) is
  the WORST of these: a group message is "delivered" only once everyone has it, "read" only once everyone has
  read it (the single/double/blue-tick rule). A message with no recipients (everyone else has left the group) is
  "sent", never a false "read".
- **Read receipts are "read up to sequence N", not per message.** `markReadUpTo` catches every message up to the
  one the user actually saw, in one call; a message that arrives mid-click stays unread. Reading implies delivered.
  Delivery, by contrast, is acknowledged one message at a time (`markDelivered`), the way a client acks each
  message as it physically arrives.
- **Idempotent sends.** The caller supplies `clientMessageId`, scoped to (conversation, sender): the same id with
  the same body returns the original message and consumes no new sequence number; the same id with a different
  body is `IDEMPOTENCY_CONFLICT`. A replay is answered even if the sender has since left the conversation --
  replaying reads a result, it does not re-authorize the action.
- **Direct conversations are unique per unordered pair.** `createDirectConversation("u1","u2")` and
  `createDirectConversation("u2","u1")` both return the same conversation.
- **A new group member sees messages from the moment they join, not the group's history.** Enforced at read time
  (`getMessages`), by each member's `joinedAtSeq`, not by hiding anything when the message was sent.
- **Only the owner adds or removes members; the owner cannot be removed.** No ownership transfer or self-leave in
  stage 1 (see "Known and NOT handled").
- **An error means nothing happened.** Every validation (body/id length, unknown user, unknown conversation, not
  a member, duplicate membership) throws before any state changes; the only exception is a successful idempotent
  replay, which by definition changes nothing new.

## Design choices

See [PLAN.md](PLAN.md) for the reasoning behind each choice. In short:

- Receipts are a map keyed by recipient, not a single enum, because "delivered" and "read" are properties of a
  (message, recipient) pair, not of the message alone.
- Visibility (the join-time cut) is a read-time filter over `joinedAtSeq`, not a per-message access list, so it
  stays a few lines and is trivial to loosen to "show full history" later.
- Not used on purpose: wall-clock ordering (races under clock skew), a single boolean "delivered" flag (cannot
  express partial delivery to a group), deleting history on membership changes (receipts of messages already
  seen are historical facts and are kept).

## Tests

| File | Tests | What |
|---|---|---|
| test/conversations.test.ts | 12 | direct-pair uniqueness, group creation and validation, add/remove membership and authorization, `joinedAtSeq` assignment, copies returned by `get()` |
| test/messages.test.ts | 11 | sequence numbers per conversation, body/id length boundaries (exact max and max+1), unknown conversation/non-member, per-recipient receipts at send time, idempotency (replay, conflict, scoping, replay after the sender left, 20 concurrent duplicates), copies returned by `sendMessage`/`getMessage` |
| test/receipts.test.ts | 11 | `markDelivered` (idempotent, never downgrades, sender/unknown/non-member/joined-later all throw, cross-conversation message id), `markReadUpTo` (range, idempotent, excludes own messages and pre-join messages, does not retroactively mark later arrivals, validation), `overallStatus` (the tick rule end to end, the zero-recipient case) |
| test/pagination.test.ts | 6 | newest-first paging with an exact-fit last page, arrivals between page loads do not shift the next page, the join-time cut applies while paging, limit bounds (exact 1 and 200), cursor forgery/corruption rejected |
| test/users.test.ts | 5 | upsert validation (empty/whitespace userId or displayName), unknown user, upsert stores a copy (not aliasing the caller's object), `get()` returns a copy, re-upsert replaces |
| test/invariants.test.ts | 6 | randomized, 6 seeds x 400 operations across two groups (send, add/remove member, deliver, read-up-to): sequence numbers assigned and checked live, receipt sets exactly match current membership, deliveries never downgrade, reads never retroactive, and at the end: the owner is never removed, sequence numbers are unique and strictly ordered, `overallStatus` matches an independently recomputed worst-of-receipts |

## Mutation checks

37 deliberate breaks, each applied alone with the suite run against it, the file restored byte for byte. 34 of 37 were caught on the first run (the length-boundary and max-limit test additions in
`test/messages.test.ts`, `test/conversations.test.ts` and `test/pagination.test.ts` were written before that run,
specifically to close the off-by-one gaps a mutation check would otherwise have found). Three survived and were
real test gaps, now closed:

- **U3**: a message could be acted on through the WRONG conversation id, as long as the recipient happened to be
  a real recipient of that message in its actual conversation (my first test used a recipient who was not a
  recipient either way, so it passed for the wrong reason). A test with a recipient who is a genuine recipient of
  the message, but calling through a different conversation they also belong to, was added.
- **Y1 / Y2**: there was no `test/users.test.ts` at all -- `InMemoryUsers` had no dedicated tests, so an empty
  `userId` being accepted, and a stored user aliasing the caller's own object (a later mutation of the caller's
  object would leak into the store) both went unnoticed. Added.

| Area | Breaks |
|---|---|
| direct conversations | D1 same-user check removed, D2 pair key not sorted (order-dependent dedup), D3 dedup lookup skipped |
| group conversations | G1 owner-in-memberIds check removed, G2 duplicate-member check removed, G3 owner stored as a plain member |
| membership | M1 already-member check removed, M2 new member's joinedAtSeq forced to 0 (sees full history), M3 owner removable, M4 removal does not remove |
| sendMessage | S1 idempotency conflict never thrown, S2 sender gets a receipt for their own message, S3 sequence number not incremented, S4/S5 off-by-one on the length limits, S6 empty body accepted |
| receipts | R1 `markDelivered` can downgrade (overwrites read), R2 `markReadUpTo` marks messages after `uptoSeq` too, R3 already-read re-marked (breaks idempotent-count), R4 negative/non-integer `uptoSeq` accepted |
| overallStatus | O1 zero-recipient message reports "read", O2 picks the best receipt instead of the worst |
| pagination | P1/P2 off-by-one at the join-time or cursor boundary, P3 page can run before the visible floor, P4 one cursor too many, P5 the other binary-search helper mutated the same way |
| cursors | C1 non-canonical cursor accepted |
| guards | U1 membership never checked, U2 owner check inverted, U3 message lookup not scoped to its conversation, U4 receipt-exists check removed, U5 unknown user accepted |
| isolation | X1/X2 `get()`/`getMessage()` return the live object instead of a copy |
| users | Y1 empty userId accepted, Y2 stored user is the caller's own object (not a copy) |

## Known and NOT handled (stage 1)

- **Everything is in memory, one process, fully synchronous.** No network, no database, no real concurrency: two
  calls are never actually interleaved. Stage 2 adds the concurrency / offline side on top of this core.
- **No ownership transfer and no self-leave.** The owner can never be removed or step down; a member who wants to
  leave needs the owner to remove them. A real version needs at least "the owner may transfer ownership" so the
  group survives the owner leaving.
- **Leaving and rejoining loses access to everything before the most recent join**, including messages seen
  during an earlier membership. `joinedAtSeq` is overwritten on each join; it does not remember an earlier,
  wider window.
- **No message editing or deletion.** Planned for stage 2.
- **No multiple devices per user, no offline queueing, no push notifications.** (Push notifications are project 21
  in this repo; this project could sit behind it as the `in_app`-style source of truth, but that integration is
  not built.)
- **No group size limit, no rate limiting, no media attachments, no search.**
