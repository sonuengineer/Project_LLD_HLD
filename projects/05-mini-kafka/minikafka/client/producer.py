"""Producer client.

- Partitioning: key -> crc32(key) % partitions (same key always lands in the same partition, so
  per-key ORDER is preserved); no key -> round robin.
- Batching: records for a partition accumulate until batch_size or linger_ms, then go in ONE request
  (fewer round trips = much higher throughput; measured in bench/).
- Idempotence: one producer id + a sequence number per partition. A retry after a timeout re-sends
  the SAME base_sequence; the leader recognises it and returns the original offsets -> no duplicate.
  Limitation: dedupe state lives on the leader only (lost on failover in this simplified broker).
- In-flight ordering: one request per partition at a time, so a retry can't overtake a later batch
  (Kafka allows up to 5 in flight with idempotence enabled because sequences catch reordering).
"""
from __future__ import annotations

import asyncio
import zlib
from dataclasses import dataclass, field

import httpx

RETRIABLE = {"not_leader_for_partition", "leader_not_available", "broker_unavailable", "not_enough_replicas",
             "request_timed_out"}


class ProduceError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(f"{code}: {message}")
        self.code = code


@dataclass
class _Pending:
    key: str | None
    value: str
    future: asyncio.Future


@dataclass
class _PartitionQueue:
    records: list[_Pending] = field(default_factory=list)
    next_seq: int = 0
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    timer: asyncio.Task | None = None


class Producer:
    def __init__(self, base_url: str = "http://127.0.0.1:8005", *, transport: httpx.AsyncBaseTransport | None = None,
                 acks: str = "all", batch_size: int = 500, linger_ms: int = 5, idempotent: bool = True,
                 retries: int = 8, retry_backoff_ms: int = 100):
        self.http = httpx.AsyncClient(base_url=base_url, transport=transport, timeout=30)
        self.acks, self.batch_size, self.linger = acks, batch_size, linger_ms / 1000
        self.idempotent, self.retries, self.backoff = idempotent, retries, retry_backoff_ms / 1000
        self.producer_id: int | None = None
        self._partitions: dict[str, int] = {}
        self._queues: dict[tuple[str, int], _PartitionQueue] = {}
        self._rr = 0

    async def _partition_count(self, topic: str) -> int:
        if topic not in self._partitions:
            meta = (await self.http.get("/metadata")).json()
            if topic not in meta["topics"]:
                raise ProduceError("unknown_topic_or_partition", topic)
            self._partitions[topic] = len(meta["topics"][topic]["partitions"])
        return self._partitions[topic]

    async def send(self, topic: str, value: str, key: str | None = None, partition: int | None = None) -> asyncio.Future:
        """Queue a record; returns a future resolving to (partition, offset)."""
        if self.idempotent and self.producer_id is None:
            self.producer_id = (await self.http.post("/producers")).json()["producer_id"]
        if partition is None:
            n = await self._partition_count(topic)
            if key is not None:
                partition = zlib.crc32(key.encode()) % n
            else:
                self._rr += 1
                partition = self._rr % n
        q = self._queues.setdefault((topic, partition), _PartitionQueue())
        fut = asyncio.get_running_loop().create_future()
        q.records.append(_Pending(key, value, fut))
        if len(q.records) >= self.batch_size:
            asyncio.create_task(self._drain(topic, partition))
        elif q.timer is None or q.timer.done():
            q.timer = asyncio.create_task(self._linger_then_drain(topic, partition))
        return fut

    async def send_and_wait(self, topic: str, value: str, key: str | None = None) -> tuple[int, int]:
        return await (await self.send(topic, value, key))

    async def _linger_then_drain(self, topic: str, partition: int) -> None:
        await asyncio.sleep(self.linger)
        await self._drain(topic, partition)

    async def _drain(self, topic: str, partition: int) -> None:
        q = self._queues[(topic, partition)]
        async with q.lock:                      # one in-flight request per partition (ordering)
            while q.records:
                batch, q.records = q.records[:self.batch_size], q.records[self.batch_size:]
                base_seq = q.next_seq
                q.next_seq += len(batch)
                try:
                    res = await self._send_batch(topic, partition, batch, base_seq)
                    for i, p in enumerate(batch):
                        if not p.future.done():
                            p.future.set_result((partition, res["base_offset"] + i))
                except Exception as exc:
                    for p in batch:
                        if not p.future.done():
                            p.future.set_exception(exc)
                    # The failed batch may or may not have been written, so its sequence numbers are
                    # unusable: later batches would hit out_of_order_sequence forever. Like Kafka, reset the
                    # producer identity (new id, sequences from 0) -- the leader treats it as a new producer.
                    await self._reset_identity()

    async def _send_batch(self, topic: str, partition: int, batch: list[_Pending], base_seq: int) -> dict:
        body = {"records": [{"key": p.key, "value": p.value} for p in batch], "partition": partition,
                "acks": self.acks}
        if self.idempotent:
            body |= {"producer_id": self.producer_id, "base_sequence": base_seq}
        delay = self.backoff
        for attempt in range(self.retries + 1):
            try:
                r = await self.http.post(f"/topics/{topic}/produce", json=body)
            except httpx.TransportError as exc:
                code, msg = "network_error", str(exc)
            else:
                if r.status_code == 200:
                    return r.json()
                err = r.json().get("error", {})
                code, msg = err.get("code", str(r.status_code)), err.get("message", "")
            # Retrying is only safe because the same base_sequence is re-sent (idempotence).
            # Without idempotence a request_timed_out retry can create a duplicate.
            if code not in RETRIABLE and code != "network_error" or attempt == self.retries:
                raise ProduceError(code, msg)
            await asyncio.sleep(delay)
            delay = min(delay * 2, 2.0)
        raise AssertionError("unreachable")

    async def _reset_identity(self) -> None:
        if self.idempotent:
            self.producer_id = (await self.http.post("/producers")).json()["producer_id"]
            for q in self._queues.values():
                q.next_seq = 0

    async def flush(self) -> None:
        await asyncio.gather(*[self._drain(t, p) for (t, p) in list(self._queues)])

    async def close(self) -> None:
        await self.flush()
        await self.http.aclose()
