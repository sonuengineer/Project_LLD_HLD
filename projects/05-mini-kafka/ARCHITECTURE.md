# Architecture -- minikafka

```
minikafka/
  storage/record.py     on-disk record format (size, crc, offset, ts, key, value)
  storage/segment.py    .log + sparse .index, recovery, reusable read handle
  storage/log.py        partition log: segments, LEO, log start, retention, truncation
  cluster/partition.py  Replica (LEO, HW, leader bookkeeping, producer sequence state)
  cluster/cluster.py    brokers, controller loop, replication loops, produce/fetch, election, HW checkpoints
  cluster/groups.py     group coordinator (join/heartbeat/leave/commit, __consumer_offsets log)
  cluster/assignors.py  range, roundrobin
  api/app.py            HTTP API + fault injection + dashboard
  client/producer.py    partitioner, batching, idempotent retries
  client/consumer.py    group membership, poll, commit, seek, heartbeats, rebalance handling
```

## Components

```mermaid
flowchart LR
  P[Producer client<br/>partitioner + batches + pid/seq] -->|POST produce| API
  C1[Consumer A] & C2[Consumer B] -->|join / heartbeat / fetch / commit| API
  API --> CL[Cluster]
  subgraph CL [In-process cluster]
    CTRL[Controller<br/>heartbeats, ISR checks, elections]
    B0[Broker 0] & B1[Broker 1] & B2[Broker 2]
    GC[Group coordinator<br/>__consumer_offsets log]
  end
  B1 -- follower fetch --> B0
  B2 -- follower fetch --> B0
  B0 & B1 & B2 --> D[(data/broker-N/topic-P/*.log *.index<br/>hw-checkpoint.json, metadata.json)]
```

## Produce with acks=all

```mermaid
sequenceDiagram
  participant P as Producer
  participant L as Leader replica
  participant F1 as Follower 1
  participant F2 as Follower 2
  P->>L: produce(batch, acks=all, pid, seq)
  L->>L: ISR >= min.insync? dedupe seq? append -> LEO += n
  L-->>F1: notify (long-poll wakes)
  L-->>F2: notify
  F1->>L: fetch(offset = my LEO)  [tells leader my LEO]
  L-->>F1: records
  F1->>F1: append
  F1->>L: fetch(offset = new LEO)
  F2->>L: fetch(offset = new LEO)
  L->>L: HW = min(LEO of ISR) -> covers the batch
  L-->>P: ack(base_offset)
  Note over L: consumers can read offsets < HW only
```

## Leader failure

```mermaid
sequenceDiagram
  participant B0 as Broker 0 (leader)
  participant CT as Controller
  participant B1 as Broker 1 (ISR)
  B0--xCT: heartbeats stop
  CT->>CT: session timeout -> broker 0 dead
  CT->>B1: become leader (epoch+1), ISR = ISR - {0}
  Note over B1: committed data (< HW) is guaranteed present
  B0->>B0: restart: open logs, recover torn tails, HW from checkpoint
  B0->>B1: fetch as follower; stale epoch -> truncate to HW first
  B1-->>B0: missing records
  CT->>CT: B0 caught up -> back in ISR
```

## Consumer group rebalance

```mermaid
sequenceDiagram
  participant A as Consumer A
  participant GC as Coordinator
  participant B as Consumer B (new)
  B->>GC: join(topics)
  GC->>GC: state = PreparingRebalance
  A->>GC: heartbeat
  GC-->>A: REBALANCE_IN_PROGRESS
  A->>GC: (commit current positions) join
  GC->>GC: all members joined -> generation+1, assign (range)
  GC-->>A: gen=2, partitions [0,1]
  GC-->>B: gen=2, partitions [2,3]
  Note over A,B: a zombie still on gen=1 is fenced on commit
```
