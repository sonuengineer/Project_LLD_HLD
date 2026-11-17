# Trade-offs -- minikafka

1. **In-process cluster vs real multi-process brokers.** Deterministic failure tests (kill, isolate,
   restart at an exact moment) and simple code; costs realism (one CPU for all brokers -- measured:
   concurrency across partitions doesn't add throughput) and no real network partitions/split brain.
2. **Pull replication (followers fetch) vs push.** Followers control their pace, the fetch offset doubles
   as the acknowledgement, and catching up after downtime is the same code path. Cost: one extra round
   trip before HW advances -> acks=all latency.
3. **HW-based truncation vs leader-epoch history (KIP-101).** Simple and correct for single failovers;
   rapid successive failovers can theoretically lose or diverge data that leader epochs would protect.
4. **acks / min ISR / unclean election are configuration, not code.** The system exposes the CAP-style
   choice to the user: durability (acks=all + min ISR 2, partition offline if no ISR) vs availability
   (acks=1, unclean election).
5. **Coordinator-side assignment.** Fewer round trips; Kafka keeps it client-side so new strategies don't
   need broker upgrades.
6. **Offsets in an internal log replayed at startup.** Same durability as data; startup time grows with
   the log (Kafka compacts it; we don't).
7. **Idempotence without replicated producer state.** Covers the common case (retry to the same leader);
   documented gap across failovers.
8. **CRC per record.** Easier to read and to recover precisely; costs bytes and CPU vs per-batch CRC.
9. **Stop-the-world rebalance (classic protocol).** Simple; every member pauses on every membership change.
   Kafka's incremental cooperative rebalancing / KIP-848 avoid revoking partitions that don't move.
10. **Long-lived read handle per segment.** 7.7x acks=all throughput on Windows; costs one open file
    descriptor per segment (Kafka mmaps indexes and keeps segment files open too).
