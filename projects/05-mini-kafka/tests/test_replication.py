"""Replication semantics: HW, ISR, acks, leader election, data loss with acks=1, truncation."""
import pytest

from minikafka.cluster.errors import (LeaderNotAvailable, NotEnoughReplicas, OutOfOrderSequence, RequestTimedOut,
                                      TopicAlreadyExists, InvalidReplicationFactor)

from .conftest import eventually, msgs, running_cluster


async def test_topic_placement_spreads_leaders(cluster):
    metas = cluster.create_topic("orders", partitions=6, replication_factor=3)
    assert sorted(m.leader for m in metas) == [0, 0, 1, 1, 2, 2]
    assert all(len(set(m.replicas)) == 3 for m in metas)
    with pytest.raises(TopicAlreadyExists):
        cluster.create_topic("orders", 1, 1)
    with pytest.raises(InvalidReplicationFactor):
        cluster.create_topic("big", 1, 4)


async def test_acks_all_replicates_to_every_isr_member(cluster):
    cluster.create_topic("t", 1, 3, min_insync_replicas=2)
    res = await cluster.produce("t", 0, msgs(10), acks="all")
    assert res.base_offset == 0
    meta = cluster.meta("t", 0)
    leader = cluster.brokers[meta.leader].replicas[("t", 0)]
    assert leader.high_watermark == 10
    for b in meta.replicas:   # every replica's log has the data on disk
        assert cluster.brokers[b].replicas[("t", 0)].leo == 10


async def test_consumers_never_see_uncommitted_records(cluster):
    cluster.create_topic("t", 1, 3)
    meta = cluster.meta("t", 0)
    for b in meta.replicas:
        if b != meta.leader:
            cluster.isolate_broker(b)        # followers can't fetch -> HW can't move
    await cluster.produce("t", 0, msgs(5), acks=1)
    recs, hw, _ = await cluster.fetch("t", 0, 0)
    assert recs == [] and hw == 0             # written on the leader, but NOT committed
    for b in meta.replicas:
        cluster.isolate_broker(b, False)
    # (after the ISR shrink/expand dance the records become committed)
    assert await eventually(lambda: cluster.offsets("t", 0)["high_watermark"] == 5, timeout=4)
    recs, hw, _ = await cluster.fetch("t", 0, 0)
    assert [r.value for r in recs] == [f"m{i}".encode() for i in range(5)]


async def test_leader_failover_keeps_committed_data(cluster):
    cluster.create_topic("t", 1, 3, min_insync_replicas=2)
    await cluster.produce("t", 0, msgs(100), acks="all")
    old = cluster.meta("t", 0).leader
    await cluster.kill_broker(old)
    assert await eventually(lambda: cluster.meta("t", 0).leader not in (None, old))
    meta = cluster.meta("t", 0)
    assert meta.leader_epoch == 1 and old not in meta.isr
    recs, _, _ = await cluster.fetch("t", 0, 0)
    assert len(recs) == 100                    # acks=all data survived losing the leader
    res = await cluster.produce("t", 0, msgs(1, "after"), acks="all")
    assert res.base_offset == 100


async def test_acks_1_can_lose_acknowledged_write_on_failover(cluster):
    """The classic trade-off: acks=1 returns once the LEADER has it. Leader dies before followers
    copy it -> new leader doesn't have it -> the acknowledged message is gone."""
    cluster.create_topic("t", 1, 3)
    await cluster.produce("t", 0, msgs(3), acks="all")
    meta = cluster.meta("t", 0)
    old = meta.leader
    cluster.isolate_broker(old)                 # followers lose contact with the leader ...
    leader_replica = cluster.brokers[old].replicas[("t", 0)]
    leader_replica.log.append([(None, b"acked-but-lost")])   # ... while it still acks one more acks=1 write
    assert leader_replica.leo == 4
    await cluster.kill_broker(old)
    assert await eventually(lambda: cluster.meta("t", 0).leader not in (None, old))
    recs, _, _ = await cluster.fetch("t", 0, 0)
    assert [r.value for r in recs] == [b"m0", b"m1", b"m2"]     # offset 3 is gone
    await cluster.produce("t", 0, [(None, b"new-at-3")], acks="all")
    # old leader comes back: truncates its divergent offset 3 to the checkpointed HW, then re-syncs
    cluster.brokers[old].reachable = True
    await cluster.restart_broker(old)
    assert await eventually(lambda: cluster.brokers[old].replicas[("t", 0)].leo == 4
                            and old in cluster.meta("t", 0).isr, timeout=4)
    copy = cluster.brokers[old].replicas[("t", 0)].log.read(3)
    assert copy[0].value == b"new-at-3"                          # divergence resolved, not merged


async def test_min_insync_replicas_rejects_writes(cluster):
    cluster.create_topic("t", 1, 3, min_insync_replicas=2)
    meta = cluster.meta("t", 0)
    followers = [b for b in meta.replicas if b != meta.leader]
    for b in followers:
        await cluster.kill_broker(b)
    assert await eventually(lambda: cluster.meta("t", 0).isr == {meta.leader})
    with pytest.raises(NotEnoughReplicas):
        await cluster.produce("t", 0, msgs(1), acks="all")
    await cluster.produce("t", 0, msgs(1), acks=1)              # acks=1 still accepted (weaker guarantee)
    await cluster.restart_broker(followers[0])
    assert await eventually(lambda: len(cluster.meta("t", 0).isr) == 2, timeout=4)
    await cluster.produce("t", 0, msgs(1), acks="all")


async def test_isr_shrinks_on_lag_and_expands_after_heal(cluster):
    cluster.create_topic("t", 1, 3)
    meta = cluster.meta("t", 0)
    slow = next(b for b in meta.replicas if b != meta.leader)
    cluster.brokers[slow].reachable = False      # network partition only for its fetches
    cluster.brokers[slow].last_heartbeat = 1e18  # (keep it "alive" for the controller: pure lag scenario)
    await cluster.produce("t", 0, msgs(5), acks=1)
    assert await eventually(lambda: slow not in cluster.meta("t", 0).isr, timeout=3)
    res = await cluster.produce("t", 0, msgs(5), acks="all")     # acks=all no longer waits for the slow one
    assert res.base_offset == 5
    cluster.brokers[slow].reachable = True
    assert await eventually(lambda: slow in cluster.meta("t", 0).isr, timeout=3)


async def test_acks_all_times_out_when_follower_stalls_inside_isr(tmp_path):
    async with running_cluster(tmp_path, replica_lag_max_ms=60_000, request_timeout_ms=300) as c:
        c.create_topic("t", 1, 2)
        meta = c.meta("t", 0)
        f = next(b for b in meta.replicas if b != meta.leader)
        c.brokers[f].reachable = False
        c.brokers[f].last_heartbeat = 1e18
        with pytest.raises(RequestTimedOut):
            await c.produce("t", 0, msgs(1), acks="all")
        # The write IS on the leader: a blind retry would duplicate it. That's what idempotence is for.
        assert c.brokers[meta.leader].replicas[("t", 0)].leo == 1


async def test_partition_offline_without_isr_and_unclean_election(tmp_path):
    async with running_cluster(tmp_path) as c:
        c.create_topic("t", 1, 2)
        meta = c.meta("t", 0)
        follower = next(b for b in meta.replicas if b != meta.leader)
        await c.kill_broker(follower)
        assert await eventually(lambda: c.meta("t", 0).isr == {meta.leader})
        await c.kill_broker(meta.leader)
        assert await eventually(lambda: c.meta("t", 0).leader is None)
        with pytest.raises(LeaderNotAvailable):
            await c.produce("t", 0, msgs(1), acks=1)
        await c.restart_broker(follower)       # out-of-sync replica comes back: clean election refuses it
        await __import__("asyncio").sleep(0.4)
        assert c.meta("t", 0).leader is None
    async with running_cluster(tmp_path / "u", unclean_leader_election=True) as c:
        c.create_topic("t", 1, 2)
        meta = c.meta("t", 0)
        follower = next(b for b in meta.replicas if b != meta.leader)
        await c.kill_broker(follower)
        assert await eventually(lambda: c.meta("t", 0).isr == {meta.leader})
        await c.produce("t", 0, msgs(3), acks=1)        # only on the leader
        await c.kill_broker(meta.leader)
        await c.restart_broker(follower)
        assert await eventually(lambda: c.meta("t", 0).leader == follower, timeout=3)
        recs, _, _ = await c.fetch("t", 0, 0)
        assert recs == []                                # available again, but 3 messages lost


async def test_idempotent_producer_dedupes_retries(cluster):
    cluster.create_topic("t", 1, 3)
    pid = cluster.init_producer_id()
    a = await cluster.produce("t", 0, msgs(3), producer_id=pid, base_sequence=0)
    retry = await cluster.produce("t", 0, msgs(3), producer_id=pid, base_sequence=0)   # e.g. after a timeout
    assert retry.duplicate and retry.base_offset == a.base_offset
    b = await cluster.produce("t", 0, msgs(2), producer_id=pid, base_sequence=3)
    assert b.base_offset == 3 and cluster.offsets("t", 0)["log_end_offset"] == 5
    with pytest.raises(OutOfOrderSequence):
        await cluster.produce("t", 0, msgs(1), producer_id=pid, base_sequence=9)


async def test_metadata_and_logs_survive_full_restart(tmp_path):
    async with running_cluster(tmp_path) as c:
        c.create_topic("t", 2, 3)
        await c.produce("t", 1, msgs(7), acks="all")
    async with running_cluster(tmp_path) as c:
        assert len(c.topics["t"]) == 2
        assert await eventually(lambda: c.offsets("t", 1)["log_end_offset"] == 7)
