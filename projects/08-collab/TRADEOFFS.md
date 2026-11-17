# Trade-offs -- Collaborative Editing

1. **OT with a central server vs CRDT.** Small ops, simple state, server authority (validation, ACLs,
   history); requires the server for every edit and careful transform code. CRDTs work offline/P2P but
   carry per-character metadata and tombstones.
2. **Postgres row lock as the sequencer.** Any server can take any edit, failover is trivial, history is
   durable before acks; per-document throughput is bounded (~45-66 ops/s here). An in-memory sequencer
   per document (sticky routing) would be much faster but needs ownership/failover logic.
3. **Redis pub/sub for fan-out.** Simple, low latency; at-most-once and unordered across publishers,
   compensated by the ordered forwarder + gap fill from Postgres.
4. **Acks through the ordered stream.** Guarantees clients see their ack after all earlier ops (state
   machine stays valid); costs one pub/sub round trip on the author's ack.
5. **Store transformed ops.** History replay is trivial; the original intent (pre-transform op) is lost.
6. **Snapshots every N revisions.** Bounded reconstruction time; extra storage.
7. **One-time WS tickets.** Tokens never appear in URLs/logs; costs an extra HTTP call per connect.
8. **Drop slow consumers.** One slow client can't block a room; it reconnects and catches up.
9. **Plain-text OT.** Correctness is provable and testable; rich text needs tree/attribute OT or a CRDT.
