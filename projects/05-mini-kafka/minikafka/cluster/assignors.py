"""Partition assignment strategies (Kafka: RangeAssignor, RoundRobinAssignor).

range       per topic: sort partitions and members, give each member a contiguous range; the first
            (n % m) members get one extra. Co-partitioned topics land together (good for joins),
            but with many topics the first members are systematically overloaded.
roundrobin  all subscribed partitions of all topics, dealt one by one -> more even.
"""
from __future__ import annotations

from collections import defaultdict

TP = tuple[str, int]


def range_assign(members: dict[str, list[str]], partitions: dict[str, int]) -> dict[str, list[TP]]:
    out: dict[str, list[TP]] = {m: [] for m in members}
    by_topic: dict[str, list[str]] = defaultdict(list)
    for m, topics in members.items():
        for t in topics:
            by_topic[t].append(m)
    for topic, subs in by_topic.items():
        subs = sorted(subs)
        n = partitions.get(topic, 0)
        per, extra = divmod(n, len(subs))
        start = 0
        for i, m in enumerate(subs):
            count = per + (1 if i < extra else 0)
            out[m] += [(topic, p) for p in range(start, start + count)]
            start += count
    return out


def roundrobin_assign(members: dict[str, list[str]], partitions: dict[str, int]) -> dict[str, list[TP]]:
    out: dict[str, list[TP]] = {m: [] for m in members}
    order = sorted(members)
    all_tps = sorted((t, p) for t in {t for ts in members.values() for t in ts} for p in range(partitions.get(t, 0)))
    i = 0
    for tp in all_tps:
        # next member (in order) that subscribes to this topic
        for _ in range(len(order)):
            m = order[i % len(order)]
            i += 1
            if tp[0] in members[m]:
                out[m].append(tp)
                break
    return out


ASSIGNORS = {"range": range_assign, "roundrobin": roundrobin_assign}
