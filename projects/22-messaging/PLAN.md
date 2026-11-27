# B15 Messaging System (low-level design): plan

Status (2026-11-27): stage 1 DONE (50 tests, 37 mutation checks, all caught). Stage 2 DONE (91 tests, 20 new
mutation checks, all caught).

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
| 3 | Not decided yet; proposed once stage 3 is scoped | not started |

## Not in scope

A real transport (WebSocket / long-poll), end-to-end encryption, media attachments, search, push notifications
(that is project 21), multi-tenant auth.
