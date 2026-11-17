"""One replica of one partition on one broker, plus the leader-side replication bookkeeping.

Terms:
  LEO (log end offset)  next offset this replica will write
  HW  (high watermark)  offsets < HW are on every ISR member = COMMITTED. Consumers only see < HW.
  ISR (in-sync replicas) replicas that are caught up (within replica_lag_max_ms). acks=all waits for
                        all of them; only they are eligible to become leader (clean election).
"""
from __future__ import annotations

import asyncio
import time
from collections import deque
from dataclasses import dataclass, field

from ..storage.log import Log
from .errors import OutOfOrderSequence


@dataclass
class PartitionMeta:
    """Controller's view (cluster metadata)."""
    topic: str
    partition: int
    replicas: list[int]
    leader: int | None
    isr: set[int]
    leader_epoch: int = 0
    min_insync_replicas: int = 1


@dataclass
class ProducerState:
    last_seq: int = -1
    recent: deque = field(default_factory=lambda: deque(maxlen=5))   # (base_seq, count, base_offset)


class Replica:
    def __init__(self, broker_id: int, topic: str, partition: int, log: Log):
        self.broker_id = broker_id
        self.topic = topic
        self.partition = partition
        self.log = log
        self.is_leader = False
        self.leader_epoch = -1
        self.high_watermark = 0
        # leader-only state
        self.follower_leo: dict[int, int] = {}
        self.follower_caught_up_at: dict[int, float] = {}
        self.producers: dict[int, ProducerState] = {}
        self.changed = asyncio.Condition()   # notified on append and on HW movement (long polls / acks=all)

    @property
    def leo(self) -> int:
        return self.log.log_end_offset

    def become_leader(self, epoch: int, followers: list[int]) -> None:
        self.is_leader = True
        self.leader_epoch = epoch
        now = time.monotonic()
        self.follower_leo = {b: 0 for b in followers}
        self.follower_caught_up_at = {b: now for b in followers}   # grace period after election
        # Idempotent-producer state is NOT replicated in this simplified design: after a failover
        # the new leader cannot detect a retried duplicate batch. (Kafka rebuilds it from batch headers.)
        self.producers = {}

    def become_follower(self, epoch: int) -> None:
        self.is_leader = False
        self.leader_epoch = epoch
        self.follower_leo = {}
        self.follower_caught_up_at = {}

    def check_sequence(self, producer_id: int | None, base_seq: int | None, count: int) -> int | None:
        """Idempotent producer dedupe. Returns the original base offset for a duplicate batch,
        None if the batch is new. Raises OutOfOrderSequence on a gap."""
        if producer_id is None or base_seq is None:
            return None
        if producer_id not in self.producers:
            # Unknown producer on this leader (new producer, or state lost in a failover): accept and
            # start tracking from this sequence -- like Kafka's handling of UNKNOWN_PRODUCER_ID.
            # Consequence: a retry that straddles a failover is NOT deduplicated (documented gap).
            self.producers[producer_id] = ProducerState(last_seq=base_seq - 1)
            return None
        st = self.producers[producer_id]
        for b_seq, b_count, b_off in st.recent:
            if b_seq == base_seq and b_count == count:
                return b_off            # a retry of a batch we already wrote: same offsets, no duplicate
        if base_seq != st.last_seq + 1:
            raise OutOfOrderSequence(f"producer {producer_id}: expected seq {st.last_seq + 1}, got {base_seq}")
        return None

    def record_sequence(self, producer_id: int | None, base_seq: int | None, count: int, base_offset: int) -> None:
        if producer_id is None or base_seq is None:
            return
        st = self.producers[producer_id]
        st.last_seq = base_seq + count - 1
        st.recent.append((base_seq, count, base_offset))
