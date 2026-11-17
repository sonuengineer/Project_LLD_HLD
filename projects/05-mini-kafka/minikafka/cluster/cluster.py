"""In-process cluster: N brokers (each with real on-disk logs) + a controller.

What is real: every replica is a real segmented log on disk; followers really copy records by
FETCHING from the leader (pull, like Kafka); HW/ISR/leader election follow Kafka's rules.
What is simulated: the network. Brokers are objects in one process; "network failure" is a flag
that makes calls to/from that broker fail. This keeps failure tests deterministic.
"""
from __future__ import annotations

import asyncio
import itertools
import logging
import time
from dataclasses import dataclass, field

from ..storage.log import Log, OffsetOutOfRange
from ..storage.record import Record
from .config import ClusterConfig
from .errors import (BrokerUnavailable, InvalidReplicationFactor, LeaderNotAvailable, NotEnoughReplicas,
                     NotEnoughReplicasAfterAppend,
                     NotLeaderForPartition, OffsetOutOfRangeError, RequestTimedOut, TopicAlreadyExists,
                     UnknownTopicOrPartition)
from .partition import PartitionMeta, Replica

log = logging.getLogger(__name__)
TP = tuple[str, int]


@dataclass
class Broker:
    id: int
    alive: bool = True            # process running
    reachable: bool = True        # network (False = isolated / partitioned)
    last_heartbeat: float = field(default_factory=time.monotonic)
    replicas: dict[TP, Replica] = field(default_factory=dict)
    tasks: list[asyncio.Task] = field(default_factory=list)

    @property
    def up(self) -> bool:
        return self.alive and self.reachable


@dataclass
class ProduceResult:
    topic: str
    partition: int
    base_offset: int
    count: int
    duplicate: bool = False


class Cluster:
    def __init__(self, config: ClusterConfig):
        self.cfg = config
        self.brokers: dict[int, Broker] = {i: Broker(i) for i in range(config.brokers)}
        self.topics: dict[str, list[PartitionMeta]] = {}
        self.topic_config: dict[str, dict] = {}
        self._pid = itertools.count(1)
        self._controller_task: asyncio.Task | None = None
        self._started = False
        from .groups import GroupCoordinator
        self.groups = GroupCoordinator(config.data_dir / "coordinator",
                                       lambda t: len(self.topics[t]) if t in self.topics else None,
                                       rebalance_delay_ms=config.group_rebalance_delay_ms,
                                       min_session_timeout_ms=config.group_min_session_timeout_ms)
        self.events: list[str] = []   # human-readable controller log (dashboard)

    # ---- lifecycle --------------------------------------------------------------------------------
    async def start(self) -> None:
        self.cfg.data_dir.mkdir(parents=True, exist_ok=True)
        self._load_topics_from_disk()
        for metas in self.topics.values():
            for meta in metas:
                if meta.leader is None:
                    continue
                leader = self.brokers[meta.leader].replicas[(meta.topic, meta.partition)]
                cp = self._read_checkpoint(meta.leader).get((meta.topic, meta.partition), 0)
                leader.high_watermark = min(cp, leader.leo)
                # rf=1 (or sole ISR member): everything on disk is committed. Before this fix such topics
                # showed HW 0 after a restart, hiding existing data until the next produce.
                self._advance_hw(meta, leader)
        for b in self.brokers.values():
            self._start_broker_tasks(b)
        self._controller_task = asyncio.create_task(self._controller_loop())
        self.groups.start()
        self._started = True

    async def stop(self) -> None:
        if self._controller_task:
            self._controller_task.cancel()
        await self.groups.stop()
        for b in self.brokers.values():
            await self._stop_broker_tasks(b)
            for r in b.replicas.values():
                r.log.close()

    def _event(self, msg: str) -> None:
        log.info("controller_event", extra={"event": msg})
        self.events.append(f"{time.strftime('%H:%M:%S')} {msg}")
        del self.events[:-200]

    # ---- topics -----------------------------------------------------------------------------------
    def _log_dir(self, broker_id: int, topic: str, partition: int):
        return self.cfg.data_dir / f"broker-{broker_id}" / f"{topic}-{partition}"

    def _open_log(self, broker_id: int, topic: str, partition: int) -> Log:
        tc = self.topic_config.get(topic, {})
        return Log(self._log_dir(broker_id, topic, partition), segment_bytes=tc.get("segment_bytes", self.cfg.segment_bytes),
                   index_interval_bytes=self.cfg.index_interval_bytes, retention_ms=tc.get("retention_ms"),
                   retention_bytes=tc.get("retention_bytes"))

    def create_topic(self, name: str, partitions: int, replication_factor: int, *, min_insync_replicas: int = 1,
                     retention_ms: int | None = None, retention_bytes: int | None = None,
                     segment_bytes: int | None = None) -> list[PartitionMeta]:
        if name in self.topics:
            raise TopicAlreadyExists(name)
        live = sorted(b.id for b in self.brokers.values() if b.up)
        if replication_factor > len(live) or replication_factor < 1:
            raise InvalidReplicationFactor(f"rf={replication_factor} but {len(live)} live brokers")
        if not 1 <= min_insync_replicas <= replication_factor:
            raise InvalidReplicationFactor("min_insync_replicas must be in [1, replication_factor]")
        self.topic_config[name] = {"retention_ms": retention_ms, "retention_bytes": retention_bytes,
                                   "segment_bytes": segment_bytes or self.cfg.segment_bytes}
        metas = []
        for p in range(partitions):
            # Round-robin placement with a per-partition offset spreads leaders across brokers.
            replicas = [live[(p + i) % len(live)] for i in range(replication_factor)]
            meta = PartitionMeta(name, p, replicas, replicas[0], set(replicas), 0, min_insync_replicas)
            metas.append(meta)
            for b in replicas:
                self.brokers[b].replicas[(name, p)] = Replica(b, name, p, self._open_log(b, name, p))
            self._apply_leadership(meta)
        self.topics[name] = metas
        if self._started:
            # Brokers already running: start a follower fetch loop for every new replica.
            for meta in metas:
                for b in meta.replicas:
                    broker = self.brokers[b]
                    if broker.alive:
                        broker.tasks.append(asyncio.create_task(self._replicate(broker, (name, meta.partition))))
        self._persist_topics()
        self._event(f"created topic {name} partitions={partitions} rf={replication_factor} min_isr={min_insync_replicas}")
        return metas

    def _persist_topics(self) -> None:
        import json
        data = {t: {"config": self.topic_config[t], "partitions": [
            {"replicas": m.replicas, "leader": m.leader, "isr": sorted(m.isr), "epoch": m.leader_epoch,
             "min_isr": m.min_insync_replicas} for m in metas]} for t, metas in self.topics.items()}
        tmp = self.cfg.data_dir / "metadata.json.tmp"
        tmp.write_text(json.dumps(data))
        tmp.replace(self.cfg.data_dir / "metadata.json")

    def _load_topics_from_disk(self) -> None:
        import json
        path = self.cfg.data_dir / "metadata.json"
        if not path.exists():
            return
        for t, d in json.loads(path.read_text()).items():
            self.topic_config[t] = d["config"]
            metas = []
            for p, pm in enumerate(d["partitions"]):
                meta = PartitionMeta(t, p, pm["replicas"], pm["leader"], set(pm["isr"]), pm["epoch"], pm["min_isr"])
                metas.append(meta)
                for b in meta.replicas:
                    self.brokers[b].replicas[(t, p)] = Replica(b, t, p, self._open_log(b, t, p))
                self._apply_leadership(meta)
            self.topics[t] = metas

    def meta(self, topic: str, partition: int) -> PartitionMeta:
        try:
            return self.topics[topic][partition]
        except (KeyError, IndexError):
            raise UnknownTopicOrPartition(f"{topic}-{partition}") from None

    def _apply_leadership(self, meta: PartitionMeta) -> None:
        for b in meta.replicas:
            r = self.brokers[b].replicas[(meta.topic, meta.partition)]
            if b == meta.leader:
                r.become_leader(meta.leader_epoch, [x for x in meta.replicas if x != b])
            else:
                r.become_follower(meta.leader_epoch)

    # ---- produce ----------------------------------------------------------------------------------
    def _leader_replica(self, topic: str, partition: int) -> tuple[PartitionMeta, Replica]:
        meta = self.meta(topic, partition)
        if meta.leader is None:
            raise LeaderNotAvailable(f"{topic}-{partition} has no leader (no in-sync replica alive)")
        broker = self.brokers[meta.leader]
        if not broker.up:
            raise BrokerUnavailable(f"leader broker {meta.leader} unreachable")
        r = broker.replicas[(topic, partition)]
        if not r.is_leader:
            raise NotLeaderForPartition(f"broker {meta.leader} is not leader for {topic}-{partition}")
        return meta, r

    async def produce(self, topic: str, partition: int, items: list[tuple[bytes | None, bytes]], *,
                      acks: int | str = "all", producer_id: int | None = None, base_sequence: int | None = None,
                      timeout_ms: int | None = None) -> ProduceResult:
        meta, r = self._leader_replica(topic, partition)
        all_acks = acks in ("all", -1, "-1")
        if all_acks and len(meta.isr) < meta.min_insync_replicas:
            # Refuse up front: writing to fewer replicas than promised would weaken durability.
            raise NotEnoughReplicas(f"isr={sorted(meta.isr)} < min.insync.replicas={meta.min_insync_replicas}")
        dup = r.check_sequence(producer_id, base_sequence, len(items))
        if dup is not None:
            base, duplicate = dup, True
        else:
            base = r.log.append(items)
            r.record_sequence(producer_id, base_sequence, len(items), base)
            duplicate = False
            self._advance_hw(meta, r)   # single-replica ISR commits immediately
            async with r.changed:
                r.changed.notify_all()
        if all_acks:
            end = base + len(items)
            try:
                async with r.changed:
                    await asyncio.wait_for(r.changed.wait_for(lambda: r.high_watermark >= end),
                                           timeout=(timeout_ms or self.cfg.request_timeout_ms) / 1000)
            except asyncio.TimeoutError:
                raise RequestTimedOut(f"offsets {base}..{end - 1} not replicated to ISR in time") from None
            if len(meta.isr) < meta.min_insync_replicas:
                # HW passed our offsets only because the ISR SHRANK (a slow follower was dropped): the record is
                # on fewer replicas than promised. Kafka: NOT_ENOUGH_REPLICAS_AFTER_APPEND.
                raise NotEnoughReplicasAfterAppend(
                    f"isr shrank to {sorted(meta.isr)} (< min.insync.replicas={meta.min_insync_replicas}) during the write")
        # acks=0 and acks=1 return as soon as the leader has the data (acks=0 clients don't even wait
        # for this reply in real Kafka).
        return ProduceResult(topic, partition, base, len(items), duplicate)

    def init_producer_id(self) -> int:
        return next(self._pid)

    # ---- fetch (consumers) ------------------------------------------------------------------------
    async def fetch(self, topic: str, partition: int, offset: int, *, max_bytes: int = 1024 * 1024,
                    wait_ms: int = 0) -> tuple[list[Record], int, int]:
        """Consumer fetch: only COMMITTED records (offset < HW). Returns (records, hw, log_start)."""
        meta, r = self._leader_replica(topic, partition)
        if wait_ms and offset >= r.high_watermark:
            try:
                async with r.changed:
                    await asyncio.wait_for(r.changed.wait_for(lambda: r.high_watermark > offset), wait_ms / 1000)
            except asyncio.TimeoutError:
                pass
        try:
            recs = r.log.read(offset, max_bytes, max_offset=r.high_watermark)
        except OffsetOutOfRange as exc:
            raise OffsetOutOfRangeError(str(exc)) from None
        return recs, r.high_watermark, r.log.log_start_offset

    def offsets(self, topic: str, partition: int) -> dict:
        meta, r = self._leader_replica(topic, partition)
        return {"log_start_offset": r.log.log_start_offset, "high_watermark": r.high_watermark, "log_end_offset": r.leo}

    # ---- replication ------------------------------------------------------------------------------
    def _advance_hw(self, meta: PartitionMeta, leader: Replica) -> None:
        leos = [leader.leo] + [leader.follower_leo.get(b, 0) for b in meta.isr if b != leader.broker_id]
        new_hw = min(leos)
        if new_hw > leader.high_watermark:
            leader.high_watermark = new_hw

    async def _replicate(self, broker: Broker, tp: TP) -> None:
        """Follower fetch loop for one partition on one broker."""
        me = broker.replicas[tp]
        while True:
            try:
                meta = self.meta(*tp)
                if me.is_leader or meta.leader is None or meta.leader == broker.id:
                    await asyncio.sleep(self.cfg.replica_fetch_wait_ms / 1000)
                    continue
                leader_b = self.brokers[meta.leader]
                if not (broker.up and leader_b.up):
                    raise BrokerUnavailable("network")
                leader = leader_b.replicas[tp]
                if not leader.is_leader:
                    await asyncio.sleep(self.cfg.replica_fetch_wait_ms / 1000)
                    continue
                if me.leader_epoch < meta.leader_epoch:
                    # New leader: drop anything above our HW that the new leader may not have
                    # (pre-KIP-101 Kafka behaviour; real Kafka uses leader-epoch history to truncate precisely).
                    if me.leo > me.high_watermark:
                        self._event(f"broker {broker.id} truncating {tp[0]}-{tp[1]} {me.leo} -> {me.high_watermark}")
                        me.log.truncate_to(me.high_watermark)
                    me.leader_epoch = meta.leader_epoch
                if me.leo > leader.leo:
                    me.log.truncate_to(leader.leo)
                fetch_offset = me.leo
                # The fetch itself tells the leader our LEO (that's how Kafka followers "ack").
                leader.follower_leo[broker.id] = fetch_offset
                if fetch_offset >= leader.leo:
                    leader.follower_caught_up_at[broker.id] = time.monotonic()
                self._maybe_expand_isr(meta, leader, broker.id)
                self._advance_hw(meta, leader)
                async with leader.changed:
                    leader.changed.notify_all()
                if fetch_offset < leader.log.log_start_offset:
                    me.log.truncate_to(0)   # fell behind retention: real Kafka resets to log start
                    fetch_offset = me.leo
                recs = leader.log.read(fetch_offset, 1024 * 1024) if fetch_offset < leader.leo else []
                if recs:
                    me.log.append_records(recs)
                else:
                    async with leader.changed:
                        try:
                            await asyncio.wait_for(leader.changed.wait_for(lambda: leader.leo > me.leo),
                                                   self.cfg.replica_fetch_wait_ms / 1000)
                        except asyncio.TimeoutError:
                            pass
                me.high_watermark = min(leader.high_watermark, me.leo)
            except asyncio.CancelledError:
                raise
            except BrokerUnavailable:
                await asyncio.sleep(self.cfg.replica_fetch_wait_ms / 1000)    # expected during faults
            except Exception:
                log.exception("replication_error", extra={"broker": broker.id, "topic": tp[0], "partition": tp[1]})
                await asyncio.sleep(self.cfg.replica_fetch_wait_ms / 1000)

    @staticmethod
    async def _notify(replica: Replica) -> None:
        async with replica.changed:
            replica.changed.notify_all()

    def _maybe_expand_isr(self, meta: PartitionMeta, leader: Replica, follower: int) -> None:
        if follower not in meta.isr and leader.follower_leo.get(follower, 0) >= leader.high_watermark \
                and leader.follower_leo.get(follower, 0) >= leader.leo:
            meta.isr.add(follower)
            self._persist_topics()
            self._event(f"{meta.topic}-{meta.partition}: broker {follower} rejoined ISR {sorted(meta.isr)}")

    def _check_isr(self) -> None:
        now = time.monotonic()
        for metas in self.topics.values():
            for meta in metas:
                if meta.leader is None or not self.brokers[meta.leader].up:
                    continue
                leader = self.brokers[meta.leader].replicas[(meta.topic, meta.partition)]
                for b in list(meta.isr):
                    if b == meta.leader:
                        continue
                    lagging = now - leader.follower_caught_up_at.get(b, 0) > self.cfg.replica_lag_max_ms / 1000
                    if lagging:
                        meta.isr.discard(b)
                        self._persist_topics()
                        self._event(f"{meta.topic}-{meta.partition}: broker {b} removed from ISR (lagging) -> {sorted(meta.isr)}")
                        self._advance_hw(meta, leader)   # a shrunk ISR can let HW move forward
                        asyncio.get_running_loop().create_task(self._notify(leader))   # wake acks=all / long polls

    # ---- brokers & controller -----------------------------------------------------------------------
    def _start_broker_tasks(self, b: Broker) -> None:
        b.last_heartbeat = time.monotonic()
        b.tasks = [asyncio.create_task(self._broker_heartbeat(b))]
        b.tasks += [asyncio.create_task(self._replicate(b, tp)) for tp in b.replicas]
        b.tasks.append(asyncio.create_task(self._retention_loop(b)))
        b.tasks.append(asyncio.create_task(self._checkpoint_loop(b)))

    async def _stop_broker_tasks(self, b: Broker) -> None:
        for t in b.tasks:
            t.cancel()
        await asyncio.gather(*b.tasks, return_exceptions=True)
        b.tasks = []

    async def _broker_heartbeat(self, b: Broker) -> None:
        while True:
            if b.up:
                b.last_heartbeat = time.monotonic()
            await asyncio.sleep(self.cfg.broker_heartbeat_interval_ms / 1000)

    def _checkpoint_path(self, broker_id: int):
        return self.cfg.data_dir / f"broker-{broker_id}" / "hw-checkpoint.json"

    async def _checkpoint_loop(self, b: Broker) -> None:
        """Persist every replica's high watermark (Kafka: replication-offset-checkpoint).
        On restart a replica truncates to this, discarding records that were never committed
        and may conflict with what a newer leader wrote at the same offsets."""
        import json
        path = self._checkpoint_path(b.id)
        while True:
            await asyncio.sleep(self.cfg.broker_heartbeat_interval_ms / 1000)
            data = {f"{t}|{p}": r.high_watermark for (t, p), r in b.replicas.items()}
            tmp = path.with_suffix(".tmp")
            tmp.write_text(json.dumps(data))
            tmp.replace(path)

    def _read_checkpoint(self, broker_id: int) -> dict[TP, int]:
        import json
        path = self._checkpoint_path(broker_id)
        if not path.exists():
            return {}
        return {(k.rsplit("|", 1)[0], int(k.rsplit("|", 1)[1])): v for k, v in json.loads(path.read_text()).items()}

    async def _retention_loop(self, b: Broker) -> None:
        while True:
            await asyncio.sleep(self.cfg.retention_check_interval_ms / 1000)
            for r in b.replicas.values():
                r.log.apply_retention()

    async def _controller_loop(self) -> None:
        dead_seen: set[int] = set()
        while True:
            await asyncio.sleep(self.cfg.broker_heartbeat_interval_ms / 1000)
            try:
                now = time.monotonic()
                for b in self.brokers.values():
                    silent = now - b.last_heartbeat > self.cfg.broker_session_timeout_ms / 1000
                    if silent and b.id not in dead_seen:
                        dead_seen.add(b.id)
                        self._event(f"broker {b.id} session expired -> failing over its partitions")
                        self._handle_broker_failure(b.id)
                    elif not silent and b.id in dead_seen:
                        dead_seen.discard(b.id)
                        self._event(f"broker {b.id} is back")
                        self._elect_offline_partitions()
                self._check_isr()
            except Exception:
                log.exception("controller_error")

    def _handle_broker_failure(self, dead: int) -> None:
        for metas in self.topics.values():
            for meta in metas:
                if dead in meta.isr and meta.leader != dead:
                    meta.isr.discard(dead)
                if meta.leader == dead:
                    self._elect(meta, exclude={dead})
        self._persist_topics()

    def _elect(self, meta: PartitionMeta, exclude: set[int]) -> None:
        candidates = [b for b in meta.replicas if b in meta.isr and b not in exclude and self.brokers[b].up]
        unclean = False
        if not candidates and self.cfg.unclean_leader_election:
            candidates = [b for b in meta.replicas if b not in exclude and self.brokers[b].up]
            unclean = True
        old = meta.leader
        if not candidates:
            # Keep the ISR as it was (Kafka keeps the last ISR member): when that broker returns, it is the
            # only replica guaranteed to hold every committed record, so clean election must pick it.
            # (Emptying the ISR here left the partition offline forever -- found in review, regression-tested.)
            meta.leader = None
            self._event(f"{meta.topic}-{meta.partition}: OFFLINE (no in-sync replica alive)")
            return
        meta.leader = candidates[0]
        meta.leader_epoch += 1
        meta.isr = {b for b in meta.isr if b not in exclude} | {meta.leader}
        new = self.brokers[meta.leader].replicas[(meta.topic, meta.partition)]
        # New leader's HW: what it knew as a follower. Records between its HW and LEO are kept --
        # they become committed once the new ISR has them.
        self._apply_leadership(meta)
        new.high_watermark = min(new.high_watermark, new.leo)
        self._advance_hw(meta, new)     # e.g. sole ISR member: everything it has is committed
        self._event(f"{meta.topic}-{meta.partition}: leader {old} -> {meta.leader} epoch={meta.leader_epoch}"
                    + (" (UNCLEAN: possible data loss)" if unclean else ""))

    def _elect_offline_partitions(self) -> None:
        for metas in self.topics.values():
            for meta in metas:
                if meta.leader is None:
                    self._elect(meta, exclude=set())
        self._persist_topics()

    # ---- fault injection (demo/tests) ---------------------------------------------------------------
    async def kill_broker(self, broker_id: int) -> None:
        """Process crash: tasks stop, files are closed (unflushed OS buffers are kept by the OS)."""
        b = self.brokers[broker_id]
        b.alive = False
        await self._stop_broker_tasks(b)
        for r in b.replicas.values():
            r.log.close()
        self._event(f"broker {broker_id} killed")

    async def restart_broker(self, broker_id: int) -> None:
        b = self.brokers[broker_id]
        checkpoint = self._read_checkpoint(broker_id)
        for tp in list(b.replicas):
            b.replicas[tp] = Replica(broker_id, tp[0], tp[1], self._open_log(broker_id, *tp))
            # Comes back as follower of everything; it rejoins ISR once caught up. Its HW is the last
            # checkpoint, so the stale-epoch truncation removes only never-committed records.
            b.replicas[tp].become_follower(-1)
            b.replicas[tp].high_watermark = min(checkpoint.get(tp, 0), b.replicas[tp].leo)
            meta = self.meta(*tp)
            if meta.leader == broker_id:   # was leader of an offline partition and nobody else is in sync
                b.replicas[tp].become_leader(meta.leader_epoch, [x for x in meta.replicas if x != broker_id])
                b.replicas[tp].high_watermark = b.replicas[tp].leo
        b.alive = True
        self._start_broker_tasks(b)
        self._event(f"broker {broker_id} restarted")

    def isolate_broker(self, broker_id: int, isolated: bool = True) -> None:
        self.brokers[broker_id].reachable = not isolated
        self._event(f"broker {broker_id} {'network-isolated' if isolated else 'reconnected'}")

    # ---- introspection ----------------------------------------------------------------------------
    def group_lag(self, group: str) -> list[dict]:
        out = []
        for (t, p), off in sorted(self.groups.committed(group).items()):
            try:
                hw = self.offsets(t, p)["high_watermark"]
            except Exception:
                hw = None
            out.append({"topic": t, "partition": p, "committed": off, "high_watermark": hw,
                        "lag": None if hw is None else hw - off})
        return out

    def describe(self) -> dict:
        out = {"brokers": [{"id": b.id, "alive": b.alive, "reachable": b.reachable,
                            "seconds_since_heartbeat": round(time.monotonic() - b.last_heartbeat, 2)}
                           for b in self.brokers.values()], "topics": {}}
        for t, metas in self.topics.items():
            parts = []
            for m in metas:
                leader = self.brokers[m.leader].replicas.get((t, m.partition)) if m.leader is not None else None
                parts.append({"partition": m.partition, "leader": m.leader, "replicas": m.replicas,
                              "isr": sorted(m.isr), "leader_epoch": m.leader_epoch,
                              "high_watermark": leader.high_watermark if leader else None,
                              "log_end_offset": leader.leo if leader else None,
                              "replica_leo": {b: self.brokers[b].replicas[(t, m.partition)].leo for b in m.replicas
                                              if self.brokers[b].alive}})
            out["topics"][t] = {"config": self.topic_config[t], "partitions": parts}
        return out
