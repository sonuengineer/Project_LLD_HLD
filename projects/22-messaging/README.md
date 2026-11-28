# B15 Messaging System (low-level design)

A TypeScript library (no runtime dependencies, in memory) for the core of a messaging system (WhatsApp / Slack
style): direct and group conversations, ordering, and per-recipient delivery and read receipts, plus an HTTP API
(stage 3) in front of it. The core library itself stays dependency-free; only `src/http/` adds Express. There is
no real transport: nothing in this project sends anything over a network on its own.

Status (2026-11-28): stage 1 DONE -- 50 tests, 37 mutation checks, all caught. Stage 2 DONE -- 91 tests (41
new), 20 new mutation checks, all caught. Stage 3 DONE -- 117 tests (26 new), 24 new mutation checks, all caught
(see "Mutation checks"). Details in [PLAN.md](PLAN.md).

```
npm ci
npm test        # 117 tests
npm run demo    # direct chat, group chat, receipts, a retried send, the join-time history cut, offline
                # catch-up on reconnect, multiple devices, message edit/delete
npm start       # the HTTP API on http://127.0.0.1:3000 (needs MESSAGING_API_KEY set; see src/main.ts)
```

## Usage

```ts
const users = new InMemoryUsers();
users.upsert({ userId: "u1", displayName: "Asha" });
users.upsert({ userId: "u2", displayName: "Bilal" });

const messenger = new Messenger({ users });
const conv = messenger.createDirectConversation("u1", "u2");
const message = await messenger.sendMessage(conv.id, "u1", "hey, free for a call?", "client-generated-id-1");
// message.seq === 1, message.receipts.u2 === { status: "sent", at: ... } (u2 is offline)

await messenger.markDelivered(conv.id, "u2", message.id); // u2's client acks arrival
await messenger.markReadUpTo(conv.id, "u2", message.seq); // u2 opens the chat
overallStatus(messenger.getMessage(conv.id, message.id)!); // "read"

await messenger.connectDevice("u2", "phone"); // u2 comes online; any OTHER pending receipts catch up right here
await messenger.editMessage(conv.id, "u1", message.id, "hey, got a sec for a call?");
await messenger.deleteMessage(conv.id, "u1", message.id); // delete-for-everyone: body is cleared, not just hidden
```

### Over HTTP (stage 3)

```
curl -X POST http://127.0.0.1:3000/conversations/direct \
  -H "Authorization: Bearer $MESSAGING_API_KEY" -H "Content-Type: application/json" \
  -d '{"userIdA": "u1", "userIdB": "u2"}'
# 200 { "id": "...", "kind": "direct", "members": [...], ... }

curl -X POST http://127.0.0.1:3000/conversations/<conversationId>/messages \
  -H "Authorization: Bearer $MESSAGING_API_KEY" -H "Content-Type: application/json" \
  -d '{"senderId": "u1", "body": "hey, free for a call?", "clientMessageId": "client-generated-id-1"}'
# 201 { "id": "...", "seq": 1, "status": "sent", ... } (u2 is offline); Location: /conversations/<id>/messages/<id>
```

See `src/http/app.ts` for the full route list and status-code mapping, and "Mutation checks" below.

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
- **Every mutation is a real async round trip to a ConversationStore (stage 2).** Two operations on the SAME
  conversation can genuinely interleave around that await. A SYNCHRONOUS claim before it and an apply after
  (mirrors 23-password-manager's claimEntryOp/commit) keeps that safe: `pendingOps` (message ops: send, deliver,
  read, edit, delete) and `revising` (membership changes) exclude each other, `CONVERSATION_BUSY` either way.
- **Presence is ephemeral, never persisted.** Connecting a device is instant and in memory only (see `store.ts`).
  A recipient already online is auto-delivered at send time; reconnecting after being offline catches up every
  pending receipt across every conversation they belong to. Read receipts are keyed by user, not device, so
  reading "on one device" is already visible from every other device of the same user -- nothing to implement.
- **Message edit and delete-for-everyone are sender-only.** Receipts are untouched by either. A delete that lands
  while an edit is in flight always wins: a deleted message can never be resurrected by a racing edit.
- **The HTTP API (stage 3) is a thin wrapper, not a new set of rules.** One route per `Messenger` method, a
  single bearer API key, and every `MessagingErrorCode` mapped 1:1 to a status code via a fixed table (never
  500) -- see `src/http/app.ts`.

## Design choices

See [PLAN.md](PLAN.md) for the reasoning behind each choice. In short:

- Receipts are a map keyed by recipient, not a single enum, because "delivered" and "read" are properties of a
  (message, recipient) pair, not of the message alone.
- Visibility (the join-time cut) is a read-time filter over `joinedAtSeq`, not a per-message access list, so it
  stays a few lines and is trivial to loosen to "show full history" later.
- Not used on purpose: wall-clock ordering (races under clock skew), a single boolean "delivered" flag (cannot
  express partial delivery to a group), deleting history on membership changes (receipts of messages already
  seen are historical facts and are kept).
- `removeMember`/`addMember` replace the WHOLE `members` array, not a keyed map, because membership is small and
  rarely-changing; this is exactly why two of them racing without a guard can silently undo each other (see
  "the lost-update bug" in `test/concurrency.test.ts`), and exactly why `revising` exists.
- A membership change excludes every message op, not just other membership changes, so a send can never build
  its receipts from a member list that is mid-replace underneath it.
- Delete-for-everyone clears `body` outright rather than leaving a `deleted: true` flag next to the original
  text: a reader must never be able to recover content the sender removed.

## Tests

| File | Tests | What |
|---|---|---|
| test/conversations.test.ts | 12 | direct-pair uniqueness, group creation and validation, add/remove membership and authorization, `joinedAtSeq` assignment, copies returned by `get()` |
| test/messages.test.ts | 11 | sequence numbers per conversation, body/id length boundaries (exact max and max+1), unknown conversation/non-member, per-recipient receipts at send time, idempotency (replay, conflict, scoping, replay after the sender left, 20 truly concurrent duplicates -- exactly one commits, the other 19 get `SEND_IN_FLIGHT`, a retry after settlement dedupes normally), copies returned by `sendMessage`/`getMessage` |
| test/receipts.test.ts | 11 | `markDelivered` (idempotent, never downgrades, sender/unknown/non-member/joined-later all throw, cross-conversation message id), `markReadUpTo` (range, idempotent, excludes own messages and pre-join messages, does not retroactively mark later arrivals, validation), `overallStatus` (the tick rule end to end, the zero-recipient case) |
| test/pagination.test.ts | 6 | newest-first paging with an exact-fit last page, arrivals between page loads do not shift the next page, the join-time cut applies while paging, limit bounds (exact 1 and 200), cursor forgery/corruption rejected |
| test/users.test.ts | 5 | upsert validation (empty/whitespace userId or displayName), unknown user, upsert stores a copy (not aliasing the caller's object), `get()` returns a copy, re-upsert replaces |
| test/invariants.test.ts | 6 | randomized, 6 seeds x 400 operations across two groups (send, add/remove member, deliver, read-up-to), each one awaited in turn: sequence numbers assigned and checked live, receipt sets exactly match current membership, deliveries never downgrade, reads never retroactive, and at the end: the owner is never removed, sequence numbers are unique and strictly ordered, `overallStatus` matches an independently recomputed worst-of-receipts |
| test/devices.test.ts | 16 | `connectDevice`/`disconnectDevice`/`isOnline` (several devices at once, unknown user/device), auto-delivery to an already-online recipient (per recipient, independently), offline catch-up on reconnect (spans every conversation, untouched if already delivered/read, only on the offline->online transition, `addMember`/`removeMember` keep `conversationsByUser` correct), multi-device read sync needs no per-device call |
| test/edit-delete.test.ts | 13 | `editMessage` (sender-only, length validation, unknown conversation/message, cannot edit a deleted message, receipts untouched, returns a copy), `deleteMessage` (clears the body, idempotent and keeps the original `deletedAt`, sender-only, unknown conversation/message, cross-conversation scoping, receipts untouched) |
| test/concurrency.test.ts | 12 | two sends never collide on sequence number regardless of resolve order; the lost-update bug `revising` prevents (illustrated unguarded, then shown fixed for `removeMember` vs `removeMember` and for a message op vs a membership change, both directions); concurrent reads never regress status or timestamp even out of order; an edit racing a delete always loses to the delete, either resolve order; idempotent calls commit nothing to the store; offline catch-up skips a conversation mid-revision without failing the whole reconnect |
| test/http.test.ts | 26 | auth (missing/wrong API key, short `apiKey` rejected at `createApp`); every route's happy path (direct/group conversations, add/remove member, send/get/list/edit/delete message, markDelivered/markReadUpTo, connect/disconnect device, isOnline); every mapped error status (400/403/404/409) through a real route; an idempotent send replayed over HTTP and a same-key-different-body 409; a deterministic `SEND_IN_FLIGHT` and `CONVERSATION_BUSY` using a `FakeConversationStore` held open (a real concurrent-fetch race settles too far apart in time to trigger these reliably); pagination via `limit`/`cursor` query params; a bracketed query key (`?cursor[x]=1`) that would otherwise crash `decodeCursor`; auto-delivery to an already-connected device end to end; 404/415/400/413 HTTP-layer errors; an unexpected error mapped to 500 and logged, not leaked |

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

Stage 2: 20 deliberate breaks, each applied alone with the full suite run against it, the file restored byte for
byte. Two survived the first run -- both real, though harmless to correctness, gaps: an idempotent `markDelivered`
call and a catch-up with nothing pending both lacked a test proving they touch the store ZERO times (the final
status was always correct either way, so no earlier test caught the wasted round trip). Closed with
`test/concurrency.test.ts`'s "idempotent calls never touch the store" tests; all 20 are now caught.

| Area | Breaks |
|---|---|
| claim guards | G1 `claimOp`'s revising check removed, G2 `claimRevision`'s pendingOps check removed, G3 `claimRevision`'s revising check removed |
| sendMessage | S1 sequence claimed without incrementing, S2 idempotency pre-claim removed (truly concurrent duplicates would all slip through), S3 presence ignored at send time (always "sent") |
| receipts | R1 `markDelivered`'s idempotent early return removed, R2 `markDelivered` applies unconditionally (could downgrade read), R3 `markReadUpTo`'s apply-time recheck removed (a stale timestamp could overwrite a newer read), R4 `uptoSeq` integer check removed |
| edit / delete | E1 `MESSAGE_DELETED` precondition removed, E2 edit applies unconditionally over a racing delete, E3/E4 `SENDER_REQUIRED` removed (edit, delete), E5 delete's idempotent early return removed (re-deleting re-stamps `deletedAt`) |
| presence | P1 `connectDevice` never catches up, P2 `disconnectDevice`'s `UNKNOWN_DEVICE` check removed, P3 catch-up's empty-pending skip removed |
| membership bookkeeping | B1 `addMember` does not register the new member for future catch-up, B2 `removeMember` does not clean up a departed member's catch-up registration |

Stage 3: 24 deliberate breaks in `src/http/app.ts`, each applied alone with the full suite run against it, the
file restored byte for byte. All 24 were caught on the first run -- no new tests were needed.

| Area | Breaks |
|---|---|
| status-code mapping | one break per `STATUS_BY_CODE` entry, changed to 200 (`INVALID_REQUEST`, `UNKNOWN_USER`, `UNKNOWN_CONVERSATION`, `UNKNOWN_MESSAGE`, `NOT_A_MEMBER`, `ALREADY_MEMBER`, `OWNER_REQUIRED`, `CANNOT_REMOVE_OWNER`, `IDEMPOTENCY_CONFLICT`, `INVALID_CURSOR`, `CONVERSATION_BUSY`, `SEND_IN_FLIGHT`, `SENDER_REQUIRED`, `MESSAGE_DELETED`, `UNKNOWN_DEVICE`), plus one break removing the `UNKNOWN_DEVICE` entry outright (exercises the `?? 500` fallback and its log call, not just a wrong value) |
| auth guard | the `match !== null` check removed from `keyMatches` (a malformed Authorization header crashes instead of cleanly refusing), `timingSafeEqual`'s result hardcoded to `true` (any Bearer value with the right shape would be accepted) |
| asyncRoute | `.catch(next)` removed (a rejected promise in an async route would hang the request instead of reaching the error handler) |
| validation passthrough | `bodyField` forced to always return `undefined` (no field ever reaches the library) |
| response shape | `messageView` stops spreading the message (only `status` would come back) |
| requireJson | the Content-Type check inverted (JSON requests rejected, non-JSON accepted) |
| 404 guards | the `undefined` check removed from both `GET /conversations/:id` and `GET /conversations/:id/messages/:messageId` |

## Known and NOT handled

- **No ownership transfer and no self-leave.** The owner can never be removed or step down; a member who wants to
  leave needs the owner to remove them. A real version needs at least "the owner may transfer ownership" so the
  group survives the owner leaving.
- **Leaving and rejoining loses access to everything before the most recent join**, including messages seen
  during an earlier membership. `joinedAtSeq` is overwritten on each join; it does not remember an earlier,
  wider window.
- **No real transport, no push notifications, no media attachments, no search, no group size limit, no rate
  limiting.** (Push notifications are project 21 in this repo; this project could sit behind it as the
  `in_app`-style source of truth, but that integration is not built.)
- **Everything is in memory; nothing survives a restart,** including presence (deliberately -- see "The rules")
  and the `ConversationStore`'s own snapshots (`InMemoryConversationStore` is in-memory only, same as
  23-password-manager's `VaultStore`).
- **Offline catch-up is best-effort per conversation, not retried automatically.** A conversation that happens to
  be mid-revision at the exact moment a user reconnects is skipped for that reconnect; their next explicit ack, or
  their next full reconnect, still catches it up (see `test/concurrency.test.ts`).
- **No read receipt "undo".** Once read-up-to has been recorded there is no way to mark a message unread again,
  mirroring real chat apps.
- **No HTTP endpoint to register a user.** `Messenger` takes a `UserDirectory` as a constructor dependency and
  does not own user management itself (see `src/users.ts`), so the HTTP layer (stage 3) does not invent one
  either; `src/main.ts` boots with an empty `InMemoryUsers`, which a real deployment would replace with a
  directory backed by the app's actual user service.
- **No rate limiting, no CORS, no per-user login at the HTTP layer.** One API key authenticates a legitimate
  caller of the API (another service), the same model as the password-manager and notification HTTP layers in
  this repo -- it is not an end-user auth system.
