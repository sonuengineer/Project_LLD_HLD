# Project 8 -- Real-Time Collaborative Editing Backend

Google-Docs-style collaborative text editing: WebSocket rooms, Operational Transformation with a
central sequencer, presence and cursors, reconnection with catch-up, offline editing, version history
with snapshots and restore, access control -- and **horizontal scaling**: any server instance accepts
edits for any document (Postgres orders them, Redis pub/sub fans them out), proven by tests that run two
real server processes with clients connected to both.

## What is implemented (verified by tests)

| Feature | Where | Test |
|---|---|---|
| OT core: apply, compose, transform (TP1), cursor transform, diff | `collab/ot.py` | `tests/test_ot.py` (randomized property tests) |
| WebSocket server, document rooms, multiple concurrent users | `collab/api.py` (`/ws`), `collab/realtime.py` | `test_two_users_edit_concurrently_and_converge` |
| Central sequencer: row lock, dedupe, transform vs history one by one | `collab/service.py::submit` | same + fuzz |
| Horizontal scaling (2 servers, Redis fan-out, ordered forwarder, gap fill) | `realtime.py::Hub` | `test_horizontal_scaling_two_servers`, fuzz |
| Conflict resolution under random concurrency, disconnects, offline edits | client state machine + sequencer | `test_fuzz_many_clients_two_servers_with_disconnects` (2 seeds) |
| Reconnection with catch-up; lost-ack resend deduplicated | `Hub.join(last_rev)`, UNIQUE(client_id, client_seq) | `test_lost_ack_resend_is_deduplicated` |
| Offline change synchronization | `collab/client.py` | `test_offline_edits_sync_after_reconnect` |
| Presence + cursors (ephemeral, cross-server) | `Hub.presence/touch`, `cursor` messages | `test_presence_and_cursors` |
| Persistence: op log + periodic snapshots; version history; restore | `service.content_at/history`, `/restore` | `test_history_revision_and_restore` |
| Access control (owner/editor/viewer), one-time WS tickets | `service.require_role`, `/ws-tickets` | `test_viewer_cannot_edit_and_strangers_cannot_join`, `test_ws_ticket_is_single_use` |
| Server-side validation of operations | `submit` | `test_invalid_operation_rejected` |
| Browser demo editor (JS port of the OT client) | `collab/editor.html` (`/editor`) | manual |

34 tests, stable across repeated runs. Latency/throughput in [TESTING.md](TESTING.md).

## Run

```bash
docker compose -f ../../infra/docker-compose.yml up -d
../../.venv/Scripts/alembic upgrade head
../../.venv/Scripts/uvicorn collab.main:app --port 8008 --ws websockets-sansio
open http://127.0.0.1:8008/editor        # create user -> new document -> join; open a second tab
../../.venv/Scripts/python -m pytest -q
```

Docker (2 servers behind nginx, no sticky sessions): `docker compose up -d --build`, then
`python demo.py http://127.0.0.1:58008` or open `http://127.0.0.1:58008/editor`.

## Docs

[ARCHITECTURE](ARCHITECTURE.md) . [SYSTEM_DESIGN](SYSTEM_DESIGN.md) . [DATABASE_DESIGN](DATABASE_DESIGN.md) .
[API_DOCUMENTATION](API_DOCUMENTATION.md) . [TRADEOFFS](TRADEOFFS.md) . [FAILURE_SCENARIOS](FAILURE_SCENARIOS.md) .
[SECURITY](SECURITY.md) . [TESTING](TESTING.md) . [DEPLOYMENT](DEPLOYMENT.md) . [LEARNING_GUIDE](LEARNING_GUIDE.md) .
[INTERVIEW_PREPARATION](INTERVIEW_PREPARATION.md)

## Known limitations

- Plain text only (no rich text / tree OT). Undo is not implemented (needs inverse ops + transform).
- Per-document throughput is bounded by one sequencer (row lock): ~45-66 committed ops/s measured here;
  fine for human editing (clients batch keystrokes), not for machine-generated firehoses.
- Cursor positions are transformed client-side; the server stores the last reported position only.
- No CRDT / peer-to-peer mode; a central server is required.
