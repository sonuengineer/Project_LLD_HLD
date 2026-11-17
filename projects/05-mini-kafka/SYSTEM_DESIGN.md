# System Design -- minikafka

## Why a log

A queue deletes a message when it's consumed. A log keeps it (until retention) and every consumer
group tracks its own position (offset). Consequences: many independent consumers of one stream,
replay by moving the offset, ordering within a partition, and sequential disk I/O (appends + linear
reads), which is why Kafka is fast on plain disks.

## Partitions = unit of parallelism and ordering

- Ordering is guaranteed only within a partition. Same key -> same partition -> per-key order.
- A partition is consumed by at most one member of a group -> max useful consumers = partitions.
- Key skew creates hot partitions (demo: 5 keys over 3 partitions -> 36/12/12 records).
- Adding partitions changes key -> partition mapping (ordering break for existing keys).

## Durability knobs

| Setting | Effect |
|---|---|
| `acks=0` | fire and forget |
| `acks=1` | leader has it; lost if leader dies before followers copy (proven by test) |
| `acks=all` | every ISR member has it |
| `min.insync.replicas` | with acks=all, refuse writes when ISR is too small (instead of "all" meaning "just the leader") |
| `unclean_leader_election` | availability over durability: an out-of-sync replica may become leader -> data loss |
| replication factor 3 + min ISR 2 + acks=all | the standard "survive one broker loss without losing acked data" setup |

## Delivery semantics end to end

| Producer side | Consumer side | Result |
|---|---|---|
| retries without idempotence | | duplicates in the log possible |
| idempotent producer | | no duplicates from retries (to one leader) |
| | commit after processing | at-least-once |
| | commit before processing | at-most-once |
| idempotent + transactions + read_committed | offsets committed in the transaction | Kafka's exactly-once (inside Kafka only) -- not implemented here |

## Kafka vs RabbitMQ (when asked)

Kafka: log, retention, replay, per-partition order, consumer-managed offsets, very high throughput,
consumer groups scale by partitions. RabbitMQ: broker-managed queues, per-message ack/redelivery,
flexible routing (exchanges), priorities, delayed messages; messages are gone once acked. Use Kafka for
event streams / event sourcing / analytics pipelines; RabbitMQ for task queues and complex routing.

## Throughput (this repo, measured; see TESTING.md)

Storage append 117k msg/s unbatched -> 563k msg/s with 1000-record batches; acks=all through the
simulated cluster 73.8k msg/s; HTTP producer 376 msg/s unbatched -> 32.8k msg/s batched.

## Scaling path (real Kafka)

Brokers as separate processes/machines; partition leaders spread across brokers; group coordinators
partitioned by group id; zero-copy (`sendfile`) from page cache to sockets; batch compression;
tiered storage for old segments; KRaft controller quorum (Raft) instead of a single controller.
