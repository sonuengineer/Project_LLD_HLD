"""Queue client used by the API (producer side), workers (consumer side) and the reaper.

Redis layout (prefix default "jq:"):
    jq:job:{id}                 HASH   job record (status, attempts, lease_until, ...)
    jq:job:{id}:errors          LIST   last 20 attempt errors
    jq:q:{queue}:ready          ZSET   score = (9 - priority) * 1e13 + seq  -> priority, then FIFO
    jq:q:{queue}:delayed        ZSET   score = run_at ms (scheduled jobs and retry backoff)
    jq:q:{queue}:active         ZSET   score = lease deadline ms (visibility timeout)
    jq:q:{queue}:dead           ZSET   score = died at ms  (dead letter queue)
    jq:q:{queue}:completed      ZSET   recent successes (capped)
    jq:q:{queue}:stats          HASH   counters
    jq:queues                   SET    known queue names
    jq:idem:{key}               STRING idempotency key -> job id (TTL)
    jq:schedules                HASH   recurring schedules
    jq:seq                      STRING global FIFO sequence
"""
from __future__ import annotations

import json
import uuid
from pathlib import Path
from typing import Any

from pydantic import ValidationError
from redis.asyncio import Redis

from .backoff import retry_delay_ms
from .models import EnqueueRequest, Job, JobStatus, ScheduleRequest

_LUA = Path(__file__).parent / "lua"
SCRIPTS = ["enqueue", "claim", "ack", "fail", "extend_lease", "requeue_dead", "cancel", "schedule_tick"]


def _now_arg(now_ms: int | None) -> str:
    return "" if now_ms is None else str(now_ms)


class JobQueue:
    def __init__(self, redis: Redis, prefix: str = "jq:", *, retention_s: int = 86400,
                 completed_cap: int = 1000, idempotency_ttl_s: int = 86400, lease_grace_ms: int = 5000):
        self.r = redis
        self.p = prefix
        self.retention_s = retention_s
        self.completed_cap = completed_cap
        self.idem_ttl = idempotency_ttl_s
        self.lease_grace_ms = lease_grace_ms
        self._s = {n: redis.register_script((_LUA / f"{n}.lua").read_text(encoding="utf-8")) for n in SCRIPTS}

    # ---- keys -----------------------------------------------------------------------------
    def k(self, queue: str, kind: str) -> str:
        return f"{self.p}q:{queue}:{kind}"

    def job_key(self, job_id: str) -> str:
        return f"{self.p}job:{job_id}"

    # ---- producer -------------------------------------------------------------------------
    async def enqueue(self, req: EnqueueRequest, *, now_ms: int | None = None) -> tuple[str, bool]:
        """Returns (job_id, created). created=False means the idempotency key matched an existing job."""
        job_id = uuid.uuid4().hex
        fields = {
            "id": job_id, "type": req.type, "queue": req.queue, "payload": json.dumps(req.payload),
            "priority": req.priority, "max_attempts": req.max_attempts,
            "timeout_ms": int(req.timeout_seconds * 1000), "lease_grace_ms": self.lease_grace_ms,
            "backoff_base_ms": int(req.backoff_base_seconds * 1000),
            "backoff_max_ms": int(req.backoff_max_seconds * 1000),
        }
        if req.idempotency_key:
            fields["idempotency_key"] = req.idempotency_key
        flat = [str(x) for kv in fields.items() for x in kv]
        run_at = ""
        if req.run_at_ms is not None:
            run_at = str(req.run_at_ms)
        elif req.delay_seconds:
            base = now_ms if now_ms is not None else await self._redis_now()
            run_at = str(base + int(req.delay_seconds * 1000))
        idem_key = f"{self.p}idem:{req.idempotency_key}" if req.idempotency_key else ""
        await self.r.sadd(f"{self.p}queues", req.queue)
        jid, created = await self._s["enqueue"](
            keys=[self.k(req.queue, "ready"), self.k(req.queue, "delayed"), self.k(req.queue, "stats"), idem_key],
            args=[self.p, job_id, json.dumps(flat), req.priority, run_at, _now_arg(now_ms), self.idem_ttl])
        return (jid.decode() if isinstance(jid, bytes) else jid), bool(created)

    async def _redis_now(self) -> int:
        sec, usec = await self.r.time()
        return sec * 1000 + usec // 1000

    # ---- consumer -------------------------------------------------------------------------
    async def claim(self, queue: str, worker_id: str, *, now_ms: int | None = None,
                    max_promote: int = 100, max_lease_ms: int = 30_000) -> tuple[Job, int] | None:
        got = await self.claim_many(queue, worker_id, 1, now_ms=now_ms, max_promote=max_promote,
                                    max_lease_ms=max_lease_ms)
        return got[0] if got else None

    async def claim_many(self, queue: str, worker_id: str, n: int, *, now_ms: int | None = None,
                         max_promote: int = 100, max_lease_ms: int = 30_000) -> list[tuple[Job, int]]:
        """Lease up to n jobs in ONE round trip (job hashes come back inline)."""
        res = await self._s["claim"](
            keys=[self.k(queue, "ready"), self.k(queue, "delayed"), self.k(queue, "active")],
            args=[self.p, worker_id, _now_arg(now_ms), max_promote, max_lease_ms, n])
        out = []
        for raw_id, attempt, _deadline, flat in res or []:
            d = {flat[i].decode(): flat[i + 1].decode() for i in range(0, len(flat), 2)}
            d["result"] = None
            d["errors"] = []
            try:
                out.append((Job.model_validate(d), int(attempt)))
            except ValidationError as exc:
                # Corrupt record: retrying can't fix it, and raising here would crash the claim loop
                # and leave the job bouncing between lease expiry and retry. Dead-letter it now.
                await self._s["fail"](
                    keys=[self.k(queue, "active"), self.k(queue, "delayed"), self.k(queue, "dead"),
                          self.k(queue, "stats")],
                    args=[self.p, raw_id.decode(), int(attempt), f"corrupt job record: {exc}"[:2000], 0,
                          _now_arg(now_ms), "permanent", "1"])
        return out

    async def ack(self, job: Job, token: int, result: Any = None, *, now_ms: int | None = None) -> bool:
        ok = await self._s["ack"](
            keys=[self.k(job.queue, "active"), self.k(job.queue, "completed"), self.k(job.queue, "stats")],
            args=[self.p, job.id, token, json.dumps(result), _now_arg(now_ms), self.retention_s, self.completed_cap])
        return bool(ok)

    async def fail(self, job: Job, token: int | None, error: str, *, reason: str = "error",
                   now_ms: int | None = None, delay_ms: int | None = None, permanent: bool = False) -> str:
        """token=None is the reaper path (no fencing check, but the lease must really be expired)."""
        attempt = job.attempts if token is None else token
        if delay_ms is None:
            delay_ms = retry_delay_ms(attempt, job.backoff_base_ms, job.backoff_max_ms)
        out = await self._s["fail"](
            keys=[self.k(job.queue, "active"), self.k(job.queue, "delayed"), self.k(job.queue, "dead"),
                  self.k(job.queue, "stats")],
            args=[self.p, job.id, "" if token is None else token, error[:2000], delay_ms, _now_arg(now_ms), reason,
                  "1" if permanent else "0"])
        return out.decode() if isinstance(out, bytes) else out

    async def extend_lease(self, job: Job, token: int, extend_ms: int, *, now_ms: int | None = None) -> bool:
        return bool(await self._s["extend_lease"](keys=[self.k(job.queue, "active")],
                                                  args=[self.p, job.id, token, extend_ms, _now_arg(now_ms)]))

    async def reap_expired(self, queue: str, *, now_ms: int | None = None, limit: int = 100) -> dict[str, int]:
        """Visibility-timeout recovery: active jobs whose lease passed belong to a dead/stuck
        worker. Fail them (-> retry or DLQ). Safe to run on many workers at once: fail.lua
        re-checks status + deadline atomically, so each job is reaped exactly once."""
        now = now_ms if now_ms is not None else await self._redis_now()
        ids = await self.r.zrangebyscore(self.k(queue, "active"), "-inf", now, start=0, num=limit)
        out = {"retry": 0, "dead": 0, "stale": 0}
        for raw in ids:
            job = await self.get(raw.decode())
            if job is None:
                await self.r.zrem(self.k(queue, "active"), raw)
                continue
            r = await self.fail(job, None, f"lease expired (worker {job.worker} crashed or stalled)",
                                reason="lease_expired", now_ms=now)
            out[r] += 1
        return out

    # ---- management -----------------------------------------------------------------------
    async def get(self, job_id: str) -> Job | None:
        data = await self.r.hgetall(self.job_key(job_id))
        if not data:
            return None
        d = {k.decode(): v.decode() for k, v in data.items()}
        d["result"] = json.loads(d["result"]) if d.get("result") else None
        errors = await self.r.lrange(self.job_key(job_id) + ":errors", 0, -1)
        d["errors"] = [json.loads(e) for e in errors]
        return Job.model_validate(d)

    async def cancel(self, job: Job) -> bool:
        return bool(await self._s["cancel"](keys=[self.k(job.queue, "ready"), self.k(job.queue, "delayed")],
                                            args=[self.p, job.id, self.retention_s]))

    async def requeue_dead(self, queue: str, job_id: str) -> bool:
        return bool(await self._s["requeue_dead"](
            keys=[self.k(queue, "dead"), self.k(queue, "ready"), self.k(queue, "stats")], args=[self.p, job_id]))

    async def queues(self) -> list[str]:
        return sorted(q.decode() for q in await self.r.smembers(f"{self.p}queues"))

    async def queue_stats(self, queue: str) -> dict[str, Any]:
        pipe = self.r.pipeline(transaction=False)
        for kind in ("ready", "delayed", "active", "dead"):
            pipe.zcard(self.k(queue, kind))
        pipe.hgetall(self.k(queue, "stats"))
        ready, delayed, active, dead, counters = await pipe.execute()
        return {"queue": queue, "ready": ready, "delayed": delayed, "active": active, "dead": dead,
                "counters": {k.decode(): int(v) for k, v in counters.items()}}

    async def list_ids(self, queue: str, status: JobStatus, limit: int = 50) -> list[str]:
        kind = {JobStatus.QUEUED: "ready", JobStatus.DELAYED: "delayed", JobStatus.ACTIVE: "active",
                JobStatus.DEAD: "dead", JobStatus.SUCCEEDED: "completed"}.get(status)
        if kind is None:
            return []
        if status in (JobStatus.DEAD, JobStatus.SUCCEEDED):
            ids = await self.r.zrevrange(self.k(queue, kind), 0, limit - 1)
        else:
            ids = await self.r.zrange(self.k(queue, kind), 0, limit - 1)
        return [i.decode() for i in ids]

    # ---- schedules ------------------------------------------------------------------------
    async def put_schedule(self, req: ScheduleRequest, *, now_ms: int | None = None) -> dict:
        now = now_ms if now_ms is not None else await self._redis_now()
        s = {"name": req.name, "interval_ms": int(req.interval_seconds * 1000),
             "next_run_ms": now + int(req.start_in_seconds * 1000), "job": req.job.model_dump(mode="json")}
        await self.r.hset(f"{self.p}schedules", req.name, json.dumps(s))
        return s

    async def list_schedules(self) -> list[dict]:
        return [json.loads(v) for v in (await self.r.hgetall(f"{self.p}schedules")).values()]

    async def delete_schedule(self, name: str) -> bool:
        return bool(await self.r.hdel(f"{self.p}schedules", name))

    async def tick_schedules(self, *, now_ms: int | None = None) -> list[str]:
        """Fire due schedules. Safe on N workers: compare-and-advance in Lua lets one caller win."""
        fired = []
        for name in await self.r.hkeys(f"{self.p}schedules"):
            raw = await self._s["schedule_tick"](keys=[f"{self.p}schedules"], args=[name, _now_arg(now_ms)])
            if raw:
                s = json.loads(raw)
                req = EnqueueRequest.model_validate(s["job"])
                # Idempotency key per (schedule, slot): even a duplicate fire can't enqueue twice.
                req.idempotency_key = f"schedule:{s['name']}:{s['next_run_ms']}"
                job_id, _ = await self.enqueue(req, now_ms=now_ms)
                fired.append(job_id)
        return fired
