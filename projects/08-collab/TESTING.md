# Testing -- Collaborative Editing

```bash
../../.venv/Scripts/alembic -x url=postgresql+asyncpg://bp:bp_dev_password@127.0.0.1:55432/p08_collab_test upgrade head
../../.venv/Scripts/python -m pytest -q        # 34 tests, ~25s, stable across repeated runs
../../.venv/Scripts/python bench/latency.py
```

| File | Count | Covers |
|---|---|---|
| `test_ot.py` | 19 | apply/normalisation, tie-breaks, overlapping deletes, insert inside deleted range, **randomized TP1 (2000 cases)**, compose vs sequential apply (2000 cases), transform-not-distributive counterexample, cursor transform, diff, malformed input |
| `test_realtime.py` | 15 | real uvicorn servers + real WebSockets: 2-user convergence, 2-server scaling, **fuzz: 6 clients x 25 random edits on 2 servers with offline/reconnect (2 seeds)**, lost ack dedupe, offline sync, viewer/stranger, single-use ticket, presence + cursors across servers, history/revisions/restore with snapshots, invalid op, **lost LAST message recovered by the tail check** (verified to fail with the tail check disabled), client_id hijack blocked, share downgrade/revoke across servers + sequencer re-check, rejected op -> client resync |

## Bugs found by tests

See FAILURE_SCENARIOS.md: offline-buffer transform (fuzz), room join/leave race, and the
transform/compose non-distributivity finding (property test).

Review fixes (2026-11-17), each with a regression test: tail loss, client_id hijacking, revocation not
affecting open sockets, client stalled after a rejected op, slow clients closed late (now closed at once).

## Benchmarks (real run, 2026-11-17; 2 uvicorn servers in-process, Postgres + Redis in Docker Desktop on Windows)

| Measurement | Result |
|---|---|
| Edit propagation A -> B, same server (100 edits) | p50 21.0 ms, p95 29.1 ms |
| Edit propagation A -> B, across servers via Redis | p50 19.4 ms, p95 27.4 ms |
| Committed ops/s on ONE document, 1 writer | 45 |
| Committed ops/s on ONE document, 8 concurrent writers | 66 |

Both propagation paths go through Postgres commit + Redis pub/sub, so cross-server costs nothing extra.
Per-document throughput is bounded by the sequencer (row lock + ~5 statements per op at ~3ms per round
trip through Docker Desktop); real users rarely exceed a few ops/s each because clients compose keystrokes
while an op is in flight.
