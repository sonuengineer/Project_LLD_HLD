# API -- minikafka

OpenAPI at `/docs`. Errors: `{"error": {"code", "message", "retriable"}}`; retriable errors are 503.

| Method | Path | Notes |
|---|---|---|
| POST | `/topics` | `{name, partitions, replication_factor, min_insync_replicas?, retention_ms?, retention_bytes?}` |
| GET | `/metadata` | brokers (alive, reachable, heartbeat age) + partitions (leader, epoch, replicas, ISR, HW, LEO per replica) |
| GET | `/topics/{t}/partitions/{p}/offsets` | log_start_offset, high_watermark, log_end_offset |
| POST | `/producers` | `{producer_id}` for idempotent producing |
| POST | `/topics/{t}/produce` | `{records:[{key?, value}], partition?, acks: "0"|"1"|"all", producer_id?, base_sequence?}` -> `{partition, base_offset, count, duplicate}` |
| GET | `/topics/{t}/partitions/{p}/fetch?offset=&max_bytes=&wait_ms=` | committed records only (< HW); long-poll with `wait_ms` |
| POST | `/groups/{g}/join` | `{member_id?, topics, session_timeout_ms, strategy}` -> blocks until rebalance completes -> `{generation, member_id, leader, assignment}` |
| POST | `/groups/{g}/heartbeat` | `{member_id, generation}`; 503 `rebalance_in_progress` = re-join; 409 `illegal_generation` / `unknown_member_id` |
| POST | `/groups/{g}/leave` | graceful leave -> immediate rebalance |
| POST | `/groups/{g}/commit` | `{member_id, generation, offsets:[{topic, partition, offset}]}` (offset = NEXT to read) |
| GET | `/groups/{g}`, `/groups` | state, generation, members, assignment, lag per partition |
| GET | `/events` | controller event log |
| POST | `/admin/brokers/{id}/kill|restart|isolate|heal` | fault injection, `X-Admin-Token` |

## Error codes

`unknown_topic_or_partition` 404, `topic_already_exists` 409, `invalid_replication_factor` 422,
`not_leader_for_partition` / `leader_not_available` / `broker_unavailable` / `not_enough_replicas` /
`request_timed_out` / `rebalance_in_progress` 503 (retriable), `out_of_order_sequence_number`,
`offset_out_of_range`, `unknown_member_id`, `illegal_generation` 409.

## Python client

```python
p = Producer("http://127.0.0.1:8005", acks="all", batch_size=500, linger_ms=5)
await p.send("orders", "payload", key="customer-42")      # same key -> same partition
await p.flush()

c = Consumer("billing", ["orders"], "http://127.0.0.1:8005")
while True:
    for rec in await c.poll():
        handle(rec)
    await c.commit()                                       # after processing = at-least-once
```
