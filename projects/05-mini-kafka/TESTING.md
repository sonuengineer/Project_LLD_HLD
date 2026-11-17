# Testing -- minikafka

```bash
../../.venv/Scripts/python -m pytest -q        # 40 tests, ~8s; stable over repeated runs
../../.venv/Scripts/python bench/bench.py      # storage | cluster | http benchmarks
```

| File | Count | Covers |
|---|---|---|
| `test_storage.py` | 10 | record round trip, CRC, dense offsets + HW cap, segment roll + sparse-index reads across segments, reopen, torn tail recovery, corrupted record recovery, retention by time/size, active segment kept, truncation |
| `test_replication.py` | 11 | placement, acks=all on every ISR replica, uncommitted records invisible, leader failover, **acks=1 data loss**, divergence truncation on rejoin, min ISR, ISR shrink/expand, acks=all timeout, offline partition + unclean election, idempotent dedupe, full restart |
| `test_groups.py` | 7 | range assignor, range vs round-robin, idle consumers, join/rebalance/session-expiry failover, commit fencing + ownership, leave, offsets reloaded from `__consumer_offsets` |
| `test_e2e_api.py` | 6 | client libs through HTTP: per-key ordering + group consumption + zero lag, at-least-once redelivery, replay via seek, idempotent produce, error mapping, producer surviving leader kill |

## Bugs found while testing (fixed)

1. New topics had no replication: follower loops were started only for replicas existing at cluster start.
2. Killed brokers' logs were closed twice at shutdown -> `Segment.close` made idempotent.
3. After failover the new leader had no producer state and rejected the producer's next sequence as
   out of order, stopping production. Now unknown producers are accepted (documented dedupe gap).
4. Restarted brokers started with HW 0 (would truncate everything) -> HW checkpoint file per broker.
5. (Test harness) consumers polled sequentially from one loop deadlocked rebalances; real consumers
   run concurrently, so the test now runs each in its own task and waits for a stable group.

## Bugs found in the interview-bank code review (reproduced, fixed, regression-tested: `test_review_fixes.py`)

| Bug | Fix |
|---|---|
| Offline partition never recovered: election emptied the ISR, so the returning last ISR member was not a clean candidate | keep the last ISR member (as Kafka does) + advance HW after election |
| acks=all succeeded although the ISR shrank below min.insync.replicas while waiting | re-check after the wait -> `not_enough_replicas_after_append` |
| ISR shrink advanced HW without waking acks=all waiters | notify after shrink |
| rf=1 topics showed HW 0 after a full restart | leaders load HW from checkpoint, then advance |
| Record larger than the fetch window was returned as nothing, forever (stuck consumer) | always return at least one record (KIP-74) |
| Producer sequence gap after a failed batch -> every later batch rejected | reset producer identity (new id, sequences from 0) |
| Replication errors were swallowed silently | expected faults ignored, unexpected ones logged |

## Benchmarks (real runs, 2026-11-17, Windows 11 laptop-class machine, local SSD)

### Storage (`Log.append`, 100-byte values)

| Batch | fsync | msg/s | MB/s |
|---|---|---|---|
| 1 | no | 117,392 | 15.0 |
| 100 | no | 526,267 | 67.4 |
| 1000 | no | 562,998 | 72.1 |
| 100 | every append | 85,229 | 10.9 |
| sequential read | | 363,362 | |

### Cluster produce (in-process, 3 brokers, rf=3, batch 100)

| Mode | before fix | after fix |
|---|---|---|
| acks=1, sequential | 444,757 | 408,127 |
| acks=all, sequential | 8,702 | **73,795** |
| acks=all, 8 partitions concurrently | 8,125 (p50 94.6ms) | 63,202 (p50 9.6ms) |

Investigation of the slow acks=all (documented because the method matters):
1. Hypothesis "replica_fetch_wait timeouts / Windows timer resolution": latency identical at 1ms and
   50ms fetch wait -> rejected.
2. Hypothesis "reads are slow": micro-benchmark of `Segment.read` 0.83ms, file open 0.07ms -> not enough.
3. cProfile of 100 requests: `io.open` = 239 calls, 0.75s (65% of time, ~3.1ms each) -- opening a
   file that was JUST written is far slower on Windows than opening an idle one.
4. Fix: one reusable read handle per segment + read only what can exist -> 7.7x.
5. Concurrency still doesn't add throughput: the whole simulated cluster is one Python process (CPU-bound).

### HTTP producer client (ASGI in-process, acks=all, rf=3, 4 partitions)

| batch_size / linger | msg/s |
|---|---|
| 1 / 0ms | 376 |
| 100 / 5ms | 13,400 |
| 1000 / 10ms | 32,841 |

Batching is the single biggest lever (87x here) -- the same reason Kafka producers batch by default.
