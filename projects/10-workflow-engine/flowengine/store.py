"""Persistence: workflows, history (append-only), activity task queue, timers, workers.

Every history append happens with the workflow row locked (SELECT ... FOR UPDATE) and bumps last_event_id,
so events get gap-free, totally ordered ids per workflow.

Workflow task protocol (optimistic):
    claim  -> lease the workflow (SKIP LOCKED), read history up to last_event_id = N
    replay -> outside any transaction (pure CPU)
    commit -> lock row; if last_event_id != N (a signal/completion arrived meanwhile) keep needs_task = true and
              discard our result (we'll replay again with the new events); else append the new command events,
              create activity tasks / timers, close the workflow if finished, clear needs_task -- one transaction.
"""
from __future__ import annotations

import json
import random
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from bpcommon.errors import Conflict, NotFound

from .runtime import ReplayResult, RetryPolicy


def _j(v) -> str:
    return json.dumps(v, default=str)


async def _append(s, workflow_id: str, events: list[tuple[str, dict]]) -> int:
    """Caller must hold the workflow row lock. Returns the new last_event_id."""
    last = await s.scalar(text("SELECT last_event_id FROM workflows WHERE workflow_id = :w"), {"w": workflow_id})
    for et, attrs in events:
        last += 1
        await s.execute(text("INSERT INTO history_events (workflow_id, event_id, event_type, attrs) "
                             "VALUES (:w, :e, :t, CAST(:a AS jsonb))"),
                        {"w": workflow_id, "e": last, "t": et, "a": _j(attrs)})
    await s.execute(text("UPDATE workflows SET last_event_id = :l WHERE workflow_id = :w"), {"l": last, "w": workflow_id})
    return last


async def _lock(s, workflow_id: str) -> dict:
    row = (await s.execute(text("SELECT * FROM workflows WHERE workflow_id = :w FOR UPDATE"), {"w": workflow_id})).mappings().first()
    if row is None:
        raise NotFound(f"workflow {workflow_id} not found")
    return dict(row)


# ---- client operations --------------------------------------------------------------------------------
async def start_workflow(sm, workflow_type: str, workflow_id: str, input: Any, task_queue: str = "default") -> dict:
    """Idempotent on workflow_id: starting the same business process twice returns the existing run."""
    run_id = uuid.uuid4()
    try:
        async with sm() as s, s.begin():
            await s.execute(text("INSERT INTO workflows (workflow_id, run_id, workflow_type, task_queue, status, input) "
                                 "VALUES (:w, :r, :t, :q, 'running', CAST(:i AS jsonb))"),
                            {"w": workflow_id, "r": run_id, "t": workflow_type, "q": task_queue, "i": _j(input)})
            await s.execute(text("SELECT 1 FROM workflows WHERE workflow_id = :w FOR UPDATE"), {"w": workflow_id})
            await _append(s, workflow_id, [("WorkflowStarted", {"workflow_type": workflow_type, "input": input,
                                                                "task_queue": task_queue})])
        return {"workflow_id": workflow_id, "run_id": str(run_id), "started": True}
    except IntegrityError:
        async with sm() as s:
            existing = (await s.execute(text("SELECT run_id, status FROM workflows WHERE workflow_id = :w"),
                                        {"w": workflow_id})).first()
        return {"workflow_id": workflow_id, "run_id": str(existing.run_id), "started": False, "status": existing.status}


async def signal(sm, workflow_id: str, name: str, payload: Any) -> None:
    async with sm() as s, s.begin():
        wf = await _lock(s, workflow_id)
        if wf["status"] != "running":
            raise Conflict(f"workflow is {wf['status']}")
        await _append(s, workflow_id, [("SignalReceived", {"name": name, "payload": payload})])
        await s.execute(text("UPDATE workflows SET needs_task = true WHERE workflow_id = :w"), {"w": workflow_id})


async def cancel(sm, workflow_id: str, reason: str = "") -> None:
    async with sm() as s, s.begin():
        wf = await _lock(s, workflow_id)
        if wf["status"] != "running":
            raise Conflict(f"workflow is {wf['status']}")
        await _append(s, workflow_id, [("CancelRequested", {"reason": reason})])
        await s.execute(text("UPDATE workflows SET needs_task = true WHERE workflow_id = :w"), {"w": workflow_id})
        # Pending AND running activities are cancelled. A running one learns it on its next heartbeat (returns
        # False) and its completion is fenced off; without this a started activity could later be reaped and
        # RETRIED for a workflow that no longer wants it.
        await s.execute(text("UPDATE activity_tasks SET status = 'cancelled', lease_until = NULL WHERE workflow_id = :w "
                             "AND status IN ('scheduled', 'started')"), {"w": workflow_id})


async def history(sm, workflow_id: str) -> list[dict]:
    async with sm() as s:
        rows = (await s.execute(text("SELECT event_id, event_type, attrs, created_at FROM history_events WHERE workflow_id = :w "
                                     "ORDER BY event_id"), {"w": workflow_id})).mappings().all()
    return [dict(r) for r in rows]


async def describe(sm, workflow_id: str) -> dict:
    async with sm() as s:
        wf = (await s.execute(text("SELECT * FROM workflows WHERE workflow_id = :w"), {"w": workflow_id})).mappings().first()
        if wf is None:
            raise NotFound("workflow not found")
        acts = (await s.execute(text("SELECT seq, activity_type, status, attempt, last_error FROM activity_tasks "
                                     "WHERE workflow_id = :w ORDER BY seq"), {"w": workflow_id})).mappings().all()
    return {**dict(wf), "activities": [dict(a) for a in acts]}


# ---- workflow tasks ---------------------------------------------------------------------------------------
async def claim_workflow_task(sm, worker_id: str, task_queues: list[str], lease_seconds: float,
                              workflow_types: list[str]) -> dict | None:
    async with sm() as s, s.begin():
        row = (await s.execute(text(
            "UPDATE workflows SET locked_by = :wk, lease_until = now() + make_interval(secs => :l) "
            "WHERE workflow_id = (SELECT workflow_id FROM workflows WHERE status = 'running' AND needs_task "
            "AND task_queue = ANY(:q) AND workflow_type = ANY(:t) AND (lease_until IS NULL OR lease_until < now()) "
            "ORDER BY workflow_id LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *"),
            {"wk": worker_id, "l": lease_seconds, "q": task_queues, "t": workflow_types})).mappings().first()
        if row is None:
            return None
        hist = (await s.execute(text("SELECT event_type, attrs, created_at FROM history_events WHERE workflow_id = :w "
                                     "AND event_id <= :n ORDER BY event_id"),
                                {"w": row["workflow_id"], "n": row["last_event_id"]})).mappings().all()
    return {**dict(row), "history": [dict(h) for h in hist]}


async def complete_workflow_task(sm, wf: dict, outcome: ReplayResult | None, error: str | None = None) -> bool:
    """Returns False if history changed during replay (the task will simply run again)."""
    wid = wf["workflow_id"]
    async with sm() as s, s.begin():
        current = await _lock(s, wid)
        if current["last_event_id"] != wf["last_event_id"] or current["status"] != "running":
            # Only release the lease if it is still ours: if it expired and another worker claimed the task,
            # clearing it would let a third worker run the same task concurrently.
            await s.execute(text("UPDATE workflows SET locked_by = NULL, lease_until = NULL WHERE workflow_id = :w "
                                 "AND locked_by = :k"), {"w": wid, "k": wf["locked_by"]})
            return False
        if outcome is None:
            # Replay itself failed (e.g. non-determinism after a bad deploy): the workflow is NOT failed -- it stays
            # running and blocked so it can resume once correct code is deployed (Temporal does the same).
            await s.execute(text("UPDATE workflows SET error = :e, needs_task = false, locked_by = NULL, lease_until = NULL "
                                 "WHERE workflow_id = :w"), {"e": error, "w": wid})
            return True
        events: list[tuple[str, dict]] = []
        now = datetime.now(timezone.utc)
        for c in outcome.new_commands:
            if c.kind == "schedule_activity":
                a = c.attrs
                events.append(("ActivityScheduled", {"seq": c.seq, "activity_type": a["activity_type"], "args": a["args"],
                                                     "retry": a["retry"]}))
                await s.execute(text(
                    "INSERT INTO activity_tasks (workflow_id, seq, activity_type, input, task_queue, status, retry, "
                    "start_to_close_seconds, heartbeat_timeout_seconds) VALUES (:w, :s, :t, CAST(:i AS jsonb), :q, 'scheduled', "
                    "CAST(:r AS jsonb), :st, :hb)"),
                    {"w": wid, "s": c.seq, "t": a["activity_type"], "i": _j(a["args"]), "q": a["task_queue"] or current["task_queue"],
                     "r": _j(a["retry"]), "st": a["start_to_close"], "hb": a["heartbeat_timeout"]})
            elif c.kind == "start_timer":
                fire_at = now + timedelta(seconds=c.attrs["seconds"])
                events.append(("TimerStarted", {"seq": c.seq, "seconds": c.attrs["seconds"], "fire_at": fire_at.isoformat()}))
                await s.execute(text("INSERT INTO timers (workflow_id, seq, fire_at) VALUES (:w, :s, :f)"),
                                {"w": wid, "s": c.seq, "f": fire_at})
        closed = {"completed": ("WorkflowCompleted", {"result": outcome.result}),
                  "failed": ("WorkflowFailed", {"error": outcome.error}),
                  "cancelled": ("WorkflowCancelled", {})}.get(outcome.status)
        if closed:
            events.append(closed)
        await _append(s, wid, events)
        if closed:
            await s.execute(text("UPDATE workflows SET status = :st, result = CAST(:r AS jsonb), error = :e, closed_at = now(), "
                                 "needs_task = false, locked_by = NULL, lease_until = NULL WHERE workflow_id = :w"),
                            {"st": outcome.status, "r": _j(outcome.result), "e": outcome.error, "w": wid})
            await s.execute(text("UPDATE activity_tasks SET status = 'cancelled', lease_until = NULL WHERE workflow_id = :w "
                                 "AND status IN ('scheduled', 'started')"), {"w": wid})
        else:
            await s.execute(text("UPDATE workflows SET needs_task = false, error = NULL, locked_by = NULL, lease_until = NULL "
                                 "WHERE workflow_id = :w"), {"w": wid})
    return True


# ---- activity tasks ----------------------------------------------------------------------------------------
async def claim_activity(sm, worker_id: str, task_queues: list[str], activity_types: list[str]) -> dict | None:
    async with sm() as s, s.begin():
        row = (await s.execute(text(
            "UPDATE activity_tasks SET status = 'started', attempt = attempt + 1, locked_by = :wk, "
            # Lease = heartbeat timeout when the activity heartbeats (fast dead-worker detection), else start_to_close.
            "lease_until = now() + make_interval(secs => coalesce(heartbeat_timeout_seconds, start_to_close_seconds) + 1), "
            "last_heartbeat_at = now() "
            "WHERE id = (SELECT id FROM activity_tasks WHERE status = 'scheduled' AND visible_at <= now() "
            "AND task_queue = ANY(:q) AND activity_type = ANY(:t) ORDER BY visible_at LIMIT 1 FOR UPDATE SKIP LOCKED) "
            "RETURNING *"), {"wk": worker_id, "q": task_queues, "t": activity_types})).mappings().first()
    return dict(row) if row else None


async def heartbeat(sm, task_id: int, attempt: int, details: Any = None) -> bool:
    """Extends the lease (long activities) and stores progress. False = we lost the task (fenced)."""
    async with sm() as s, s.begin():
        res = await s.execute(text(
            "UPDATE activity_tasks SET last_heartbeat_at = now(), heartbeat_details = CAST(:d AS jsonb), "
            "lease_until = now() + make_interval(secs => coalesce(heartbeat_timeout_seconds, start_to_close_seconds) + 1) "
            "WHERE id = :i AND status = 'started' AND attempt = :a"), {"d": _j(details), "i": task_id, "a": attempt})
    return res.rowcount == 1


async def _closed(s, wf: dict, task: dict) -> bool:
    """A workflow that is no longer running accepts no more history: the activity is just marked cancelled."""
    if wf["status"] == "running":
        return False
    await s.execute(text("UPDATE activity_tasks SET status = 'cancelled', lease_until = NULL WHERE id = :i AND status = 'started'"),
                    {"i": task["id"]})
    return True


async def complete_activity(sm, task: dict, result: Any) -> bool:
    async with sm() as s, s.begin():
        if await _closed(s, await _lock(s, task["workflow_id"]), task):
            return False
        res = await s.execute(text("UPDATE activity_tasks SET status = 'completed', lease_until = NULL WHERE id = :i "
                                   "AND status = 'started' AND attempt = :a"), {"i": task["id"], "a": task["attempt"]})
        if res.rowcount == 0:
            return False          # fenced: our lease expired and another attempt owns it
        await _append(s, task["workflow_id"], [("ActivityCompleted", {"seq": task["seq"], "result": result})])
        await s.execute(text("UPDATE workflows SET needs_task = true WHERE workflow_id = :w AND status = 'running'"),
                        {"w": task["workflow_id"]})
    return True


async def fail_activity(sm, task: dict, error: str, error_type: str, *, timed_out: bool = False) -> str:
    """Retry with backoff per the activity's RetryPolicy, or record ActivityFailed. Returns 'retry'|'failed'|'stale'."""
    policy = RetryPolicy.from_json(task["retry"])
    final = (error_type in policy.non_retryable_errors or error_type == "NonRetryableError"
             or (policy.maximum_attempts and task["attempt"] >= policy.maximum_attempts))
    async with sm() as s, s.begin():
        if await _closed(s, await _lock(s, task["workflow_id"]), task):
            return "stale"
        if not final:
            res = await s.execute(text(
                "UPDATE activity_tasks SET status = 'scheduled', locked_by = NULL, lease_until = NULL, last_error = :e, "
                "visible_at = now() + make_interval(secs => :d) WHERE id = :i AND status = 'started' AND attempt = :a"),
                # +-20% jitter: activities that failed together (e.g. a downstream outage) must not retry in lockstep
                {"e": f"{error_type}: {error}", "d": policy.delay(task["attempt"]) * random.uniform(0.8, 1.2),
                 "i": task["id"], "a": task["attempt"]})
            return "retry" if res.rowcount else "stale"
        res = await s.execute(text("UPDATE activity_tasks SET status = 'failed', lease_until = NULL, last_error = :e "
                                   "WHERE id = :i AND status = 'started' AND attempt = :a"),
                              {"e": f"{error_type}: {error}", "i": task["id"], "a": task["attempt"]})
        if res.rowcount == 0:
            return "stale"
        await _append(s, task["workflow_id"], [("ActivityFailed", {"seq": task["seq"], "activity_type": task["activity_type"],
                                                                   "error": error, "error_type": error_type,
                                                                   "attempts": task["attempt"], "timed_out": timed_out})])
        await s.execute(text("UPDATE workflows SET needs_task = true WHERE workflow_id = :w AND status = 'running'"),
                        {"w": task["workflow_id"]})
    return "failed"


# ---- timers & reaper -------------------------------------------------------------------------------------
async def fire_due_timers(sm, limit: int = 100) -> int:
    async with sm() as s:
        due = (await s.execute(text("SELECT workflow_id, seq FROM timers WHERE NOT fired AND fire_at <= now() "
                                    "ORDER BY fire_at LIMIT :l"), {"l": limit})).all()
    fired = 0
    for wid, seq in due:
        async with sm() as s, s.begin():
            wf = await _lock(s, wid)
            res = await s.execute(text("UPDATE timers SET fired = true WHERE workflow_id = :w AND seq = :s AND NOT fired"),
                                  {"w": wid, "s": seq})
            if res.rowcount and wf["status"] == "running":
                await _append(s, wid, [("TimerFired", {"seq": seq})])
                await s.execute(text("UPDATE workflows SET needs_task = true WHERE workflow_id = :w"), {"w": wid})
                fired += 1
    return fired


async def reap_expired_activities(sm) -> int:
    """Activity leases that expired (worker crashed / hung / missed heartbeats) count as a timed-out attempt."""
    async with sm() as s:
        rows = (await s.execute(text("SELECT * FROM activity_tasks WHERE status = 'started' AND lease_until < now() LIMIT 100"))).mappings().all()
    n = 0
    for r in rows:
        if await fail_activity(sm, dict(r), "lease expired (worker crashed, hung, or missed heartbeats)",
                               "ActivityTimeout", timed_out=True) != "stale":
            n += 1
    return n


async def register_worker(sm, worker_id: str, queues: list[str], workflow_types: list[str], activity_types: list[str]) -> None:
    async with sm() as s, s.begin():
        await s.execute(text(
            "INSERT INTO workers (worker_id, task_queues, workflow_types, activity_types) VALUES (:i, :q, :w, :a) "
            "ON CONFLICT (worker_id) DO UPDATE SET last_heartbeat = now(), task_queues = EXCLUDED.task_queues, "
            "workflow_types = EXCLUDED.workflow_types, activity_types = EXCLUDED.activity_types"),
            {"i": worker_id, "q": queues, "w": workflow_types, "a": activity_types})


async def deregister_worker(sm, worker_id: str) -> None:
    async with sm() as s, s.begin():
        await s.execute(text("DELETE FROM workers WHERE worker_id = :i"), {"i": worker_id})




async def retry_workflow_task(sm, workflow_id: str) -> dict:
    """Operator action after deploying fixed code: a workflow blocked by a replay error (e.g. NonDeterminismError)
    has needs_task = false and would otherwise wait for an unrelated event. Re-queue its workflow task."""
    async with sm() as s, s.begin():
        wf = await _lock(s, workflow_id)
        if wf["status"] != "running":
            raise Conflict(f"workflow is {wf['status']}")
        await s.execute(text("UPDATE workflows SET needs_task = true WHERE workflow_id = :w"), {"w": workflow_id})
    return {"workflow_id": workflow_id, "requeued": True, "previous_error": wf["error"]}


async def release_workflow_lease(sm, workflow_id: str, worker_id: str) -> None:
    """Best-effort hand-back of a claimed workflow task (e.g. on shutdown), so others needn't wait for expiry."""
    async with sm() as s, s.begin():
        await s.execute(text("UPDATE workflows SET locked_by = NULL, lease_until = NULL WHERE workflow_id = :w AND locked_by = :k"),
                        {"w": workflow_id, "k": worker_id})
