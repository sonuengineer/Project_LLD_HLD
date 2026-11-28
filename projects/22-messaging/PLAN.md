# B15 Messaging System (low-level design): plan

Status (2026-11-28): stage 1 DONE (50 tests, 37 mutation checks, all caught). Stage 2 DONE (91 tests, 20 new
mutation checks, all caught). Stage 3 DONE (117 tests, 24 new mutation checks, all caught).

## Why this project

"Design WhatsApp / Slack" is one of the most-asked LLD rounds, and almost every real question is about one
thing: what does "delivered" actually mean, and what happens when two things happen at once (two people read a
message at the same moment, a new member joins mid-conversation, a client retries a send it never got a response
for). Stage 1 builds the synchronous core so each of those is one rule with a test. Stage 2 (planned) adds the
concurrency / offline side: a recipient who is offline, multiple devices per user, concurrent read-receipt races
under real async code instead of a single synchronous call.

## Decisions (one recommendation each)

- **TypeScript, no runtime dependencies, in memory.** Same toolchain as the other B-series and library projects in
  this repo.
- **Message order is a per-conversation sequence number, not a timestamp.** Two servers' clocks can disagree or
  jump; a monotonically increasing integer assigned at send time cannot go backwards and needs no clock at all for
  ordering. `createdAt` is still stored (for display), but nothing orders or compares by it.
- **Delivery and read state is tracked per recipient, not as one status on the message.** A message to a group of
  5 is "delivered" to the sender's UI only once all 5 have it, and "read" only once all 5 have read it (the
  single/double/blue-tick rule). That requires a receipt per (message, recipient), not a single enum on the
  message. The overall status shown to the sender is the WORST (lowest-ranked) receipt among the recipients.
- **Read receipts are "read up to sequence N", not per message.** Marking a conversation read is one call that
  catches every message up to the one the user actually saw (mirrors the in-app inbox's `markAllRead` in B19,
  project 21): a message that arrives while the user is reading stays unread. Marking read implies delivered
  (you cannot have read something you were never delivered).
- **Idempotent sends via a client-supplied message id**, scoped to (conversationId, senderId) -- a client
  generates one id per outgoing message and resends it unchanged on retry. The same id with the same body returns
  the existing message (no duplicate, no sequence number consumed); the same id with a different body is a
  conflict. Recommended over a server-generated id: the client is the one that knows whether a send is a retry.
- **A new group member sees messages from the moment they join onward, not the conversation's history.**
  (WhatsApp's behaviour; Slack's public channels do the opposite.) Recommended as the default because showing
  full history to someone who was never in the room is the more surprising leak of the two; the visibility rule is
  one line in `getMessages`, so switching a conversation to "show history" later is a small, isolated change, not
  a redesign.
- **Direct conversations are unique per unordered pair of users.** Creating one for a pair that already has one
  returns the existing conversation. Without this, every "message this user" action would need its own lookup
  logic to avoid duplicate 1:1 threads.
- **Stage 1 is fully synchronous** (no network, no queue): every call either completes or throws in one CPU turn,
  the same "check everything, then change state" rule as the rest of this repo. An error means nothing happened.
  Concurrency (truly interleaved operations, an offline recipient, multiple devices) is stage 2, same split as
  project 21 (notifications): LLD core first, then the HLD/concurrency half on top of it.

### Stage 2 decisions

- **A real async `ConversationStore`, guarded by claim-before-await (`pendingOps`/`revising`), mirroring
  23-password-manager's `VaultStore`/`claimEntryOp`/`commit` exactly.** Recommended because this repo already has
  a proven, tested shape for "a mutation is a real await, and two of them on the same resource must not
  interleave badly" -- reinventing a different mechanism for messaging would cost a new design AND a new set of
  bugs to find, for no real benefit. `pendingOps` (message ops) and `revising` (membership changes) exclude each
  other, `CONVERSATION_BUSY` either way, same role `VAULT_BUSY`/`rotating`/`pendingEntryOps` play there.
- **The real bug this prevents is membership-vs-membership, not membership-vs-message.** `removeMember` and
  `addMember` replace the WHOLE `members` array (it is small and changes rarely, so a keyed structure would be
  over-engineering) -- which means two concurrent membership changes computed from the same stale array can
  silently undo each other (whichever applies LAST wins, discarding the other's change), the array-replace mirror
  of 23-password-manager's map-wholesale-replace rotation bug. `revising` also excludes message ops, for a
  cleaner invariant (a send can never build receipts from a member list that is mid-replace), though no single
  demonstrated bug needed that half -- same "defense in depth" reasoning `rotating` already uses there.
- **The idempotency key itself needs a synchronous claim, not just a synchronous check.** A real await means the
  map lookup that stage 1 relied on to dedupe can no longer do it alone: two truly concurrent sends with the same
  `clientMessageId` could both miss the lookup before either one's commit has filled it in. A placeholder claimed
  up front (mirrors `pendingOps`/`revising`) makes every call after the first one see it immediately and fail
  fast with `SEND_IN_FLIGHT`, instead of silently creating a second message. Found by writing the concurrency
  test for it, not by inspection -- the first draft reused stage 1's plain map-lookup check and a 20-identical-
  concurrent-sends test (ported straight from stage 1, where it passed because stage 1 never actually awaited
  anything) immediately produced 20 different messages instead of 1.
- **Every receipt mutation rechecks LIVE status at apply time, not just before the await.** Two concurrent calls
  for the same recipient can resolve in either order; re-checking (`if status !== "read"`, `if status ===
  "sent"`) right before writing means a slower call that started first can never downgrade a status or stamp a
  stale timestamp over a newer one. Recommended over a version/conflict scheme (like entries' `version` in
  23-password-manager) because a receipt update's intent is always "this recipient has now reached AT LEAST this
  status" -- never a merge of two different values -- so last-correct-wins by recheck is simpler and exactly
  right, not a shortcut.
- **A delete always wins over a racing edit for the same message, silently.** `editMessage`'s apply step rechecks
  `deletedAt` for the same reason receipts recheck their status: a deleted message must never be resurrected by
  an edit that started before the delete but finishes after it. Silent, not an error, because from the editor's
  point of view they asked for a normal edit; the right response is "here is the message's current (deleted)
  state", not a conflict they have to handle.
- **Presence (online/offline, which devices) is never written through the `ConversationStore`.** It is ephemeral
  by nature -- a real system would use something like Redis with a TTL, never the durable message log -- and
  nothing about delivery CORRECTNESS depends on presence surviving a restart the way message content must.
  Keeping it out of the store also keeps `connectDevice`/`disconnectDevice` simple: presence changes, by
  themselves, never need a commit.
- **An already-online recipient is auto-delivered at send time; reconnecting after being offline catches up
  everything pending, across every conversation.** Recommended over "always start at 'sent' and require an
  explicit `markDelivered`" because in a real system a push to a connected device succeeds immediately -- making
  the caller ack it anyway would just be modeling a delay that does not exist. Catch-up on reconnect models a
  client fetching its backlog and acking delivery for all of it, exactly once, on the offline -> online
  transition (not every device after that one, and not every time a status is merely queried).
- **Multi-device read sync needed no new code.** Receipts are already keyed by userId, not deviceId, so marking
  read "on one device" was already visible from every other device of the same user the moment receipts became a
  per-recipient map in stage 1. Worth a dedicated test (`test/devices.test.ts`) precisely because it is easy to
  assume this needs explicit fan-out logic, when the real answer is "the data model already makes this free."
- **Message edit and delete-for-everyone are sender-only, and delete clears the body outright.** A `deleted:
  true` flag next to the original text would mean every reader of this library's data has to remember to check
  the flag before using `body` -- one missed check anywhere leaks "deleted" content. Clearing it at the source
  makes that mistake impossible to make.

## Stages

| Stage | What | Status |
|---|---|---|
| 1 | Users, direct and group conversations, membership, per-conversation sequence numbers, idempotent sends, per-recipient delivery/read receipts, read-up-to-sequence, paginated history with the join-time visibility cut; randomized invariant test; mutation checks | DONE 2026-11-26 |
| 2 | Concurrency and delivery: real async `ConversationStore` with claim-before-await (`pendingOps`/`revising`), an offline recipient's receipts catch up when they return, multiple devices per user, concurrent read-receipt races under real async code, message edit / delete-for-everyone | DONE 2026-11-27 |
| 3 | An HTTP API in front of `Messenger`: one bearer API key checked in constant time, every `MessagingErrorCode` mapped to a specific status (none to 500), `asyncRoute` for Express 4's promise-rejection gap, routes covering the full public API; mutation checks | DONE 2026-11-28 |

### Stage 3 decisions

- **Mirror 23-password-manager's (and 21-notification's) HTTP layer shape exactly, rather than inventing a new
  one.** One Express app, one bearer API key digested with sha256 and compared with `timingSafeEqual`, an
  `asyncRoute()` wrapper for the routes that await an async `Messenger` method, a `STATUS_BY_CODE` table mapping
  every library error code to a specific status, and a `toHttp()` error handler that hides anything truly
  unexpected behind a logged, generic 500. Recommended because this repo already has a proven, reviewed shape for
  exactly this problem -- inventing a different one would cost a new design AND a new set of bugs to find, for no
  real benefit, the same reasoning stage 2 used for `ConversationStore`.
- **Every one of `Messenger`'s public methods gets a route, and nothing else does.** `createDirectConversation`,
  `createGroupConversation`, `addMember`, `removeMember`, `get`, `sendMessage`, `getMessage`, `getMessages`,
  `editMessage`, `deleteMessage`, `markDelivered`, `markReadUpTo`, `connectDevice`, `disconnectDevice`,
  `isOnline` -- 15 methods, 15 routes. There is no user-registration endpoint: `Messenger` takes a `UserDirectory`
  as a constructor dependency and does not own user management itself, so adding one would be inventing an
  endpoint for something the library does not expose (see `src/main.ts`).
- **No status code from this layer's own `STATUS_BY_CODE` table is ever 500.** 400 for a malformed request, 401
  for the API key, 403 for "you are not allowed to do this" (`NOT_A_MEMBER`, `OWNER_REQUIRED`,
  `SENDER_REQUIRED`), 404 for "no such resource" (`UNKNOWN_*`), 409 for a state conflict
  (`ALREADY_MEMBER`, `CANNOT_REMOVE_OWNER`, `IDEMPOTENCY_CONFLICT`, `CONVERSATION_BUSY`, `SEND_IN_FLIGHT`,
  `MESSAGE_DELETED`). A 500 is reserved for something truly unexpected (a plain `Error`, not a `MessagingError`)
  and is logged server-side, never echoed to the caller with internal detail -- same split as the two sibling
  projects.
- **`NOT_A_MEMBER`/`OWNER_REQUIRED`/`SENDER_REQUIRED` map to 403, not 404 or 401.** The API key already got the
  caller past authentication (401 is reserved for that); these three are all "you, specifically, are not
  authorized to do this action," which is what 403 means. `CANNOT_REMOVE_OWNER` and `ALREADY_MEMBER` map to 409
  instead, because they are not about who is asking -- they are about the resource's current state conflicting
  with the request, regardless of who makes it.
- **A message response always carries a computed `status` field** (`{ ...message, status: overallStatus(message) }`),
  the same way 21-notification's `view()` adds a computed `status` to a notification record: never stored, always
  derived at response time, so a client never has to recompute the tick rule itself.
- **A successful `sendMessage` is always 201, whether it is a new message or an idempotent replay.** Distinguishing
  "genuinely new" from "replayed" over HTTP would need either a new public method on `Messenger` (peeking at the
  idempotency table before committing) or duplicating that bookkeeping in the HTTP layer -- both of which the
  no-duplicated-validation rule rules out. A replay is still a successful, safe response either way; the caller's
  own `clientMessageId` is the dedup signal, not the status code.
- **The query-string `cursor` gets one HTTP-level structural check; `limit` gets none.** This is the one place
  this layer adds a check the library has no equivalent guard for (the same category as 23-password-manager's
  share-token-shape check): `decodeCursor()` calls `Buffer.from(cursor, "base64url")` directly, and `Buffer.from`
  throws a raw `TypeError` -- not a `MessagingError` -- when given something that is not a string, such as a
  repeated or bracketed query key (`?cursor[x]=1`) parsed into an array or object. Without the check that would
  leak out as an uncontrolled 500. `limit`, by contrast, needs no HTTP-level check: it is converted with `Number()`
  and handed straight to `getMessages`, and a garbled value simply becomes `NaN`, which `Messenger`'s own
  `Number.isInteger` guard already rejects as `INVALID_REQUEST` -- the outcome is identical with or without an
  HTTP-side duplicate, so adding one would just be redundant validation.
- **Membership routes take the acting user id in the JSON body, including for the `DELETE` (remove member)
  route.** `addMember`/`removeMember` both need an `actingUserId` distinct from the resource in the URL (the
  owner, not the member being added or removed); a `DELETE` with a JSON body is unusual for a browser-facing API
  but entirely normal for a service-to-service one (no browser sends these requests), and keeps the same
  "read a field off the body, hand it straight to the library" shape every other route uses.

## Not in scope

A real transport (WebSocket / long-poll), end-to-end encryption, media attachments, search, push notifications
(that is project 21), multi-tenant auth. No user-registration HTTP endpoint (see "Stage 3 decisions").
