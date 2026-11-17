"""Worker process: claims jobs, runs handlers with a timeout, keeps leases alive, heartbeats,
reaps expired leases, fires schedules, and shuts down gracefully."""
from __future__ import annotations

import asyncio
import json
import logging
import os
import socket
import time
import traceback
import uuid
from dataclasses import dataclass, field

from ..core.queue import JobQueue
from ..core.models import Job
from ..handlers import JobContext, PermanentError, Registry

log = logging.getLogger(__name__)


@dataclass
class WorkerStats:
    processed: int = 0
    succeeded: int = 0
    failed: int = 0
    stale_acks: int = 0
    started_at: float = field(default_factory=time.time)


class Worker:
    def __init__(self, queue: JobQueue, registry: Registry, queues: list[str], *, concurrency: int = 4,
                 sessionmaker=None, worker_id: str | None = None, max_lease_ms: int = 30_000,
                 heartbeat_interval: float = 5.0, reap_interval: float = 2.0, schedule_interval: float = 1.0,
                 idle_sleep_max: float = 1.0, shutdown_grace: float = 10.0):
        self.q = queue
        self.registry = registry
        self.queues = queues            # strict priority across queues: earlier = drained first
        self.concurrency = concurrency
        self.sessionmaker = sessionmaker
        self.id = worker_id or f"{socket.gethostname()}-{os.getpid()}-{uuid.uuid4().hex[:6]}"
        self.max_lease_ms = max_lease_ms
        self.heartbeat_interval = heartbeat_interval
        self.reap_interval = reap_interval
        self.schedule_interval = schedule_interval
        self.idle_sleep_max = idle_sleep_max
        self.shutdown_grace = shutdown_grace
        self.stats = WorkerStats()
        self.running: dict[str, asyncio.Task] = {}
        self._stop = asyncio.Event()

    def stop(self) -> None:
        self._stop.set()

    async def run(self) -> None:
        log.info("worker_started", extra={"worker": self.id, "queues": self.queues, "concurrency": self.concurrency})
        bg = [asyncio.create_task(self._heartbeat_loop()), asyncio.create_task(self._reaper_loop()),
              asyncio.create_task(self._schedule_loop())]
        idle = 0.05
        self._free = self.concurrency
        self._slot_freed = asyncio.Event()
        try:
            while not self._stop.is_set():
                if self._free == 0:
                    self._slot_freed.clear()
                    await self._slot_freed.wait()
                    continue
                # Claim as many jobs as we have free slots, in one Redis round trip.
                claimed = await self._claim_next(self._free)
                if not claimed:
                    try:
                        await asyncio.wait_for(self._stop.wait(), timeout=idle)
                    except asyncio.TimeoutError:
                        pass
                    idle = min(idle * 2, self.idle_sleep_max)   # adaptive polling while idle
                    continue
                idle = 0.05
                for job, token in claimed:
                    self._free -= 1
                    task = asyncio.create_task(self._execute(job, token))
                    self.running[job.id] = task
                    task.add_done_callback(lambda t, jid=job.id: self._release(jid))
        finally:
            await self._shutdown(bg)

    def _release(self, job_id: str) -> None:
        self.running.pop(job_id, None)
        self._free += 1
        self._slot_freed.set()

    async def _claim_next(self, n: int) -> list[tuple[Job, int]]:
        out: list[tuple[Job, int]] = []
        for qname in self.queues:          # strict priority: earlier queues drained first
            try:
                out += await self.q.claim_many(qname, self.id, n - len(out), max_lease_ms=self.max_lease_ms)
            except Exception:
                log.exception("claim_failed", extra={"queue": qname})
                await asyncio.sleep(0.5)
                return out
            if len(out) >= n:
                break
        return out

    async def _execute(self, job: Job, token: int) -> None:
        self.stats.processed += 1
        handler = self.registry.get(job.type)
        lease_task = asyncio.create_task(self._keep_lease(job, token))
        started = time.perf_counter()
        try:
            if handler is None:
                raise PermanentError(f"no handler registered for job type {job.type!r}")
            ctx = JobContext(job=job, attempt=token, sessionmaker=self.sessionmaker, worker_id=self.id)
            result = await asyncio.wait_for(handler(ctx), timeout=job.timeout_ms / 1000)
        except asyncio.TimeoutError:
            await self._fail(job, token, f"timed out after {job.timeout_ms}ms", "timeout")
        except asyncio.CancelledError:
            # Shutdown cancelled us mid-job: do NOT ack/fail. The lease expires and another worker
            # picks it up -> this is exactly why handlers must be idempotent.
            raise
        except PermanentError as exc:
            await self._fail(job, token, f"PermanentError: {exc}", "permanent", permanent=True)
        except Exception as exc:
            await self._fail(job, token, "".join(traceback.format_exception_only(exc)).strip(), "error")
        else:
            if await self.q.ack(job, token, result):
                self.stats.succeeded += 1
                log.info("job_succeeded", extra={"job_id": job.id, "type": job.type, "attempt": token,
                                                 "ms": round((time.perf_counter() - started) * 1000, 1)})
            else:
                # Our lease expired and someone else owns the job now. Our side effects may have
                # happened twice -> idempotent handlers make that harmless.
                self.stats.stale_acks += 1
                log.warning("stale_ack_rejected", extra={"job_id": job.id, "attempt": token})
        finally:
            lease_task.cancel()

    async def _fail(self, job: Job, token: int, error: str, reason: str, permanent: bool = False) -> None:
        self.stats.failed += 1
        outcome = await self.q.fail(job, token, error, reason=reason, permanent=permanent)
        log.warning("job_failed", extra={"job_id": job.id, "type": job.type, "attempt": token,
                                         "reason": reason, "outcome": outcome, "error": error[:300]})

    async def _keep_lease(self, job: Job, token: int) -> None:
        lease = min(job.timeout_ms, self.max_lease_ms) + self.q.lease_grace_ms
        while True:
            await asyncio.sleep(lease / 3000)
            try:
                if not await self.q.extend_lease(job, token, lease):
                    return  # we lost the lease (fenced); nothing more to do
            except Exception:
                # A transient Redis error must NOT end lease keeping for the rest of the job, or the
                # lease silently expires and the job is executed twice. Log and try again next tick
                # (we extend at lease/3, so two failed ticks are still survivable).
                log.warning("lease_extension_failed", extra={"job_id": job.id}, exc_info=True)

    async def _heartbeat_loop(self) -> None:
        while True:
            try:
                info = {"id": self.id, "queues": self.queues, "concurrency": self.concurrency,
                        "running": list(self.running), "processed": self.stats.processed,
                        "succeeded": self.stats.succeeded, "failed": self.stats.failed,
                        "stale_acks": self.stats.stale_acks, "started_at": self.stats.started_at,
                        "last_heartbeat": time.time()}
                pipe = self.q.r.pipeline(transaction=False)
                pipe.hset(f"{self.q.p}workers", self.id, json.dumps(info))
                pipe.set(f"{self.q.p}worker:{self.id}:alive", 1, px=max(int(self.heartbeat_interval * 3000), 1))
                await pipe.execute()
            except Exception:
                log.exception("heartbeat_failed")
            await asyncio.sleep(self.heartbeat_interval)

    async def _reaper_loop(self) -> None:
        while True:
            await asyncio.sleep(self.reap_interval)
            try:
                for qname in self.queues:
                    out = await self.q.reap_expired(qname)
                    if out["retry"] or out["dead"]:
                        log.warning("reaped_expired_leases", extra={"queue": qname, **out})
            except Exception:
                log.exception("reaper_failed")

    async def _schedule_loop(self) -> None:
        while True:
            await asyncio.sleep(self.schedule_interval)
            try:
                fired = await self.q.tick_schedules()
                if fired:
                    log.info("schedules_fired", extra={"jobs": fired})
            except Exception:
                log.exception("scheduler_failed")

    async def _shutdown(self, bg: list[asyncio.Task]) -> None:
        log.info("worker_draining", extra={"in_flight": len(self.running)})
        if self.running:
            done, pending = await asyncio.wait(list(self.running.values()), timeout=self.shutdown_grace)
            for t in pending:
                t.cancel()  # leases will expire and the reaper elsewhere will re-queue them
        for t in bg:
            t.cancel()
        try:
            await self.q.r.hdel(f"{self.q.p}workers", self.id)
            await self.q.r.delete(f"{self.q.p}worker:{self.id}:alive")
        except Exception:
            pass
        log.info("worker_stopped", extra={"worker": self.id, **self.stats.__dict__})
