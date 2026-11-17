# System Design -- Collaborative Editing

## Why WebSockets (not HTTP polling)

Edits must reach other users within tens of milliseconds, in both directions, with tiny messages.
WebSockets keep one full-duplex TCP connection per client: no request overhead per keystroke, server
push without polling. Costs: stateful connections (load balancers, timeouts, reconnects), memory per
connection, and the need for application-level heartbeats.

## OT vs CRDT

| | OT (this repo) | CRDT (Yjs, Automerge) |
|---|---|---|
| Ordering | central server sequences ops | no central order needed |
| Correctness burden | transform functions (TP1 with a server; TP2 without one -- very hard) | data structure guarantees convergence |
| Metadata | small ops, plain text state | per-character ids / tombstones (grows over time, needs GC) |
| Offline / P2P | needs the server to reconcile | natural |
| Server role | authority: validation, permissions, history | relay/storage |
| Used by | Google Docs, Etherpad (historically) | Figma-like apps, local-first software |

Chosen OT because the backend is the point of this project: a server that validates, authorizes,
orders, persists, and replays every change.

## Convergence argument

1. Postgres row lock on the document gives every op a unique revision: a total order.
2. The server transforms an incoming op against exactly the ops after its base revision, one by one.
3. Every client receives ops in revision order (ordered forwarder) and transforms its pending ops against
   each of them, one by one -- the same sequence the server used.
4. TP1 (property-tested) makes both paths produce the same text.
(Transform does NOT distribute over compose -- a shrunk counterexample is in tests/test_ot.py -- which is
why "one by one, same sequence" matters.)

## Scaling WebSocket servers

| Problem | Approach here | Alternative |
|---|---|---|
| Which server sequences a doc? | Postgres row lock: any server can | sticky routing doc -> server (consistent hashing); in-memory sequencer, faster but failover is harder |
| Fan-out across servers | Redis pub/sub per document channel | Redis Streams / Kafka (durable, replayable) |
| pub/sub is at-most-once and can reorder | ordered forwarder + gap fill from Postgres | durable log with offsets |
| Presence | Redis hash + staleness timeout | per-server heartbeats |
| Load balancing | plain round-robin; nginx upgrade headers, long read timeout | L4 LB; sticky sessions not needed |

Capacity: per-document throughput is bounded by one sequencer (measured 45-66 ops/s on this machine);
documents are independent, so total throughput scales with documents and servers. Hot documents (1000s of
editors) need a dedicated in-memory sequencer per document (sticky routing) and batching.
