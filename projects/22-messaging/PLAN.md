# B15 Messaging System (low-level design): plan

Status (2026-11-26): stage 1 DONE (50 tests, 37 mutation checks, all caught).

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

## Stages

| Stage | What | Status |
|---|---|---|
| 1 | Users, direct and group conversations, membership, per-conversation sequence numbers, idempotent sends, per-recipient delivery/read receipts, read-up-to-sequence, paginated history with the join-time visibility cut; randomized invariant test; mutation checks | DONE 2026-11-26 |
| 2 | Concurrency and delivery: an offline recipient's receipts catch up when they return, multiple devices per user, concurrent read-receipt races under real async code, message edit / delete-for-everyone | not started |
| 3 | Not decided yet; proposed once stage 2 is done | not started |

## Not in scope

A real transport (WebSocket / long-poll), end-to-end encryption, media attachments, search, push notifications
(that is project 21), multi-tenant auth.
