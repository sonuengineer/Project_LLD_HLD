# Project 5 -- minikafka: a Simplified Distributed Event Streaming Platform

A Kafka-like system built from scratch: a **real segmented commit log on disk** (CRC per record,
sparse offset index, segment rolling, retention, crash recovery), partitioned topics, a **simulated
multi-broker cluster** (follower-pull replication, ISR, high watermark, acks 0/1/all,
min.insync.replicas, controller-driven leader election, HW checkpoints), **consumer groups**
(generations, range/round-robin assignors, rebalancing, commit fencing, offsets stored in an internal
`__consumer_offsets` log), an **idempotent producer**, an HTTP API, a Python client, and a dashboard.

## What is real vs simulated

| Real | Simulated |
|---|---|
| On-disk log segments, index files, recovery, retention, truncation | The network between brokers: brokers are objects in one process; "network failure" is a flag |
| Replication by follower FETCH of real records | Broker processes: kill/restart = stop tasks + close/reopen files |
| HW/ISR/epoch/election rules, HW checkpoint files | |
| Consumer group protocol, offsets log replay | |

## What is implemented (verified by tests)

| Feature | Where | Test |
|---|---|---|
| Topics, partitions, replica placement | `cluster/cluster.py::create_topic` | `test_topic_placement_spreads_leaders` |
| Segmented log, sparse index, CRC, recovery, retention, truncation | `storage/` | `tests/test_storage.py` (10) |
| Producers: key partitioning (per-key order), batching, retries | `client/producer.py` | `test_key_ordering_and_group_consumption` |
| Idempotent producer (pid + sequence dedupe) | `cluster/partition.py::check_sequence` | `test_idempotent_producer_dedupes_retries`, `test_idempotent_produce_over_http` |
| Consumers, consumer groups, offsets, commits | `client/consumer.py`, `cluster/groups.py` | `tests/test_groups.py`, e2e |
| Rebalancing on join / leave / session timeout; range + round-robin | `groups.py`, `assignors.py` | `test_join_split_rebalance_and_failover`, `test_range_vs_roundrobin_with_many_topics` |
| Commit fencing by generation and ownership | `GroupCoordinator.commit` | `test_commit_fencing_and_ownership` |
| At-least-once delivery (redelivery after crash) | consumer commit-after-process | `test_at_least_once_redelivery_after_consumer_crash` |
| Replay (seek) | `Consumer.seek` | `test_replay_with_seek` |
| Retention by time and size | `Log.apply_retention` | `test_retention_by_time_and_size` |
| Replication: HW, ISR shrink/expand, acks=all, min ISR | `cluster.py::_replicate`, `_check_isr` | `tests/test_replication.py` (11) |
| acks=1 data loss on failover vs acks=all safety | | `test_acks_1_can_lose_acknowledged_write_on_failover`, `test_leader_failover_keeps_committed_data` |
| Clean vs unclean leader election | `Cluster._elect` | `test_partition_offline_without_isr_and_unclean_election` |
| Broker health monitoring (heartbeats, session expiry) + dashboard | `_controller_loop`, `/dashboard`, `/metadata`, `/events` | failover tests |
| Throughput benchmarks | `bench/bench.py` | TESTING.md |

40 tests, stable across repeated runs.

## Run

```bash
cd projects/05-mini-kafka
MK_DATA_DIR=./data ../../.venv/Scripts/uvicorn minikafka.api.app:app_from_env --factory --port 8005
../../.venv/Scripts/python demo.py http://127.0.0.1:8005      # produce, kill leader, consume, lag
open http://127.0.0.1:8005/dashboard
../../.venv/Scripts/python -m pytest -q
../../.venv/Scripts/python bench/bench.py
```

Docker: `docker compose up -d --build` (127.0.0.1:58005), then `python demo.py http://127.0.0.1:58005`.

## Docs

[ARCHITECTURE](ARCHITECTURE.md) . [SYSTEM_DESIGN](SYSTEM_DESIGN.md) . [DATABASE_DESIGN](DATABASE_DESIGN.md) .
[API_DOCUMENTATION](API_DOCUMENTATION.md) . [TRADEOFFS](TRADEOFFS.md) . [FAILURE_SCENARIOS](FAILURE_SCENARIOS.md) .
[SECURITY](SECURITY.md) . [TESTING](TESTING.md) . [DEPLOYMENT](DEPLOYMENT.md) . [LEARNING_GUIDE](LEARNING_GUIDE.md) .
[INTERVIEW_PREPARATION](INTERVIEW_PREPARATION.md)

## Known limitations

- One CRC per record instead of per batch; no compression; values are UTF-8 strings over HTTP.
- Follower truncation uses the HW (pre-KIP-101 Kafka), not leader-epoch history; edge cases with
  multiple quick failovers exist in theory.
- Idempotent-producer state is not replicated: a retry that straddles a leader failover can duplicate.
- No transactions / exactly-once across partitions; no log compaction (offsets log is replayed instead).
- Single group coordinator (not partitioned across brokers); assignment computed on the coordinator.
- The whole cluster shares one Python process, so concurrency across partitions doesn't add
  throughput (measured); real brokers are separate processes/machines.
