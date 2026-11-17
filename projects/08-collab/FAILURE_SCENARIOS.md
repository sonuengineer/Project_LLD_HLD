# Failure Scenarios -- Collaborative Editing

| # | Scenario | Behaviour | Test |
|---|---|---|---|
| 1 | Two users type at the same spot at the same time | deterministic tie-break, both converge | `test_two_users_edit_concurrently_and_converge` |
| 2 | Users on different servers | ops ordered by Postgres, fanned out via Redis | `test_horizontal_scaling_two_servers` |
| 3 | Random concurrent edits + disconnects + offline edits (6 clients, 2 servers) | all converge to the server document | fuzz test (2 seeds) |
| 4 | Ack lost (connection dropped after the server applied the op) | reconnect catch-up delivers it as an ack; a resend is deduplicated by (client_id, client_seq) | `test_lost_ack_resend_is_deduplicated` |
| 5 | Editing offline | edits compose into a buffer, transformed against missed ops, sent after catch-up | `test_offline_edits_sync_after_reconnect` |
| 6 | pub/sub messages arrive out of order | ordered forwarder buffers until the gap closes | `realtime.py::_deliver_ordered` |
| 7 | pub/sub message lost (Redis blip) | gap fill reads missing revisions from Postgres after 300ms | `_fill_gap_later` |
| 7b | the LAST message of a burst is lost (no later revision reveals the gap; the author would never get its ack) | tail check: every `tail_check_ms` (1s) each server compares its rooms with the DB heads (one query) and delivers what is missing | `test_lost_last_message_is_recovered_by_tail_check` |
| 8 | Server crashes | clients reconnect (any server), catch up from last_rev; presence entries age out after 30s | design |
| 9 | Slow client | its send queue fills -> socket closed immediately (1013); reconnect + catch-up | `Conn.send` / `Conn.kick` |
| 9b | Server rejects a client's in-flight op (e.g. document too large) | the op can never be acked and the buffer depends on it -> client drops pending edits and reloads (resync) instead of stalling | `test_rejected_op_makes_client_resync_instead_of_stalling` |
| 9c | Access revoked / downgraded while connected | sockets closed / role switched on every server; sequencer re-checks the role regardless | `test_revoking_access_closes_sockets_and_sequencer_rejects` |
| 10 | Malformed / wrong-length op | rejected with `invalid_operation`, nothing stored | `test_invalid_operation_rejected` |
| 11 | Viewer tries to edit / stranger joins | `forbidden` / connection refused | `test_viewer_cannot_edit_and_strangers_cannot_join` |
| 12 | Leaked WebSocket URL | ticket is single-use and expires in 30s | `test_ws_ticket_is_single_use` |
| 13 | Join and leave race on the same server | room registry changes happen under the room lock | fix in `Hub.join/leave` |

## Bugs found by tests (fixed)

1. **Offline buffer not transformed** (fuzz test): the client transformed incoming ops against its buffer
   only when an op was outstanding (the ot.js state model). An offline client has a buffer and nothing
   outstanding, so catch-up ops were applied to text that already contained offline edits -> length
   mismatch. Fix: transform against the buffer independently.
2. **Room join/leave race** (found while debugging 1): `leave()` could drop a room while a concurrent `join()`
   registered into it, orphaning the connection. Fix: both under the room lock + identity check.
3. **False property**: transform does not distribute over compose (counterexample kept as a test).

## Review fixes (2026-11-17)

A code review (while writing the interview bank) found: tail loss (7b), client_id hijacking (SECURITY.md),
revocation not affecting open sockets and owners able to demote themselves (9c), clients stuck after a
rejected op (9b), slow clients closed only on their next message (9). All fixed with regression tests.

Known remaining: presence entries of crashed servers are filtered at read time but never deleted; every server
subscribes to all documents (`psubscribe collab:doc:*`); the browser demo counts UTF-16 units while the server
counts code points, so emoji typed in `editor.html` can be rejected (the client then resyncs).
