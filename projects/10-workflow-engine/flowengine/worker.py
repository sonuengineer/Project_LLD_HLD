"""Worker: polls workflow tasks (replay) and activity tasks (execute), fires timers, reaps expired leases,
and registers itself. Workers are stateless -- any worker can continue any workflow from its history."""
from __future__ import annotations

import asyncio
import logging
import os
import socket
import uuid

from . import store
from .activities import ACTIVITIES, ActivityContext, NonRetryableError
from .runtime import WORKFLOWS, NonDeterminismError, replay

log = logging.getLogger(__name__)


class Worker:
    def __init__(self, sm, task_queues: list[str] | None = None, *, workflows=None, activities=None,
                 worker_id: str | None = None, activity_concurrency: int = 8, poll_interval: float = 0.1,
                 workflow_lease: float = 10.0):
        self.sm = sm
        self.queues = task_queues or ["default"]
        self.workflows = workflows if workflows is not None else WORKFLOWS
        self.activities = activities if activities is not None else ACTIVITIES
        self.id = worker_id or f"{socket.gethostname()}-{os.getpid()}-{uuid.uuid4().hex[:6]}"
        self.slots = asyncio.Semaphore(activity_concurrency)
        self.poll = poll_interval
        self.lease = workflow_lease
        self._stop = asyncio.Event()
        self._running: set[asyncio.Task] = set()
        self.shutdown_grace = 10.0
        self.stats = {"workflow_tasks": 0, "activities_ok": 0, "activities_failed": 0, "nondeterminism": 0, "stale": 0}

    def stop(self) -> None:
        """Graceful: stop polling, let in-flight activities finish (up to shutdown_grace)."""
        self._stop.set()

    def kill(self) -> None:
        """Simulated crash (tests): abandon in-flight activities immediately, no cleanup, no heartbeats."""
        for t in list(self._running):
            t.cancel()
        self._killed = True
        self._stop.set()

    async def run(self) -> None:
        await store.register_worker(self.sm, self.id, self.queues, sorted(self.workflows), sorted(self.activities))
        wf_loop = asyncio.create_task(self._workflow_loop())
        tasks = [asyncio.create_task(c) for c in (self._activity_loop(), self._timer_loop(), self._heartbeat_loop())]
        try:
            await self._stop.wait()
        finally:
            # Graceful: the workflow loop checks _stop between tasks, so a claimed workflow task is completed rather
            # than abandoned with its lease held (which blocked other workers for a full lease period).
            try:
                await asyncio.wait_for(wf_loop, self.shutdown_grace)
            except (asyncio.TimeoutError, asyncio.CancelledError):
                pass
            for t in tasks:
                t.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            if self._running:
                # Previously in-flight activities kept running after stop() returned (orphaned tasks).
                _, pending = await asyncio.wait(set(self._running), timeout=self.shutdown_grace)
                for t in pending:
                    t.cancel()          # lease expiry will hand them to another worker
                await asyncio.gather(*pending, return_exceptions=True)
            await store.deregister_worker(self.sm, self.id)

    async def _sleep(self) -> None:
        try:
            await asyncio.wait_for(self._stop.wait(), self.poll)
        except asyncio.TimeoutError:
            pass

    # ---- workflow tasks --------------------------------------------------------------------------------
    async def _workflow_loop(self) -> None:
        while not self._stop.is_set():
            try:
                worked = await self.run_workflow_task_once()
            except Exception:
                log.exception("workflow_task_error")
                worked = False
            if not worked:
                await self._sleep()

    async def run_workflow_task_once(self) -> bool:
        wf = await store.claim_workflow_task(self.sm, self.id, self.queues, self.lease, sorted(self.workflows))
        if wf is None:
            return False
        fn = self.workflows[wf["workflow_type"]]
        try:
            outcome = await replay(fn, wf["workflow_id"], str(wf["run_id"]), wf["history"])
        except asyncio.CancelledError:
            await asyncio.shield(store.release_workflow_lease(self.sm, wf["workflow_id"], self.id))
            raise
        except NonDeterminismError as exc:
            self.stats["nondeterminism"] += 1
            log.error("workflow_nondeterminism", extra={"workflow_id": wf["workflow_id"], "error": str(exc)})
            await store.complete_workflow_task(self.sm, wf, None, f"NonDeterminismError: {exc}")
            return True
        ok = await store.complete_workflow_task(self.sm, wf, outcome)
        if not ok:
            self.stats["stale"] += 1           # history moved on during replay: it will be replayed again
        self.stats["workflow_tasks"] += 1
        return True

    # ---- activities ------------------------------------------------------------------------------------
    async def _activity_loop(self) -> None:
        running = self._running
        while not self._stop.is_set():
            await self.slots.acquire()
            try:
                task = await store.claim_activity(self.sm, self.id, self.queues, sorted(self.activities))
            except Exception:
                log.exception("activity_claim_error")
                task = None
            if task is None:
                self.slots.release()
                await self._sleep()
                continue
            t = asyncio.create_task(self._execute(task))
            running.add(t)
            t.add_done_callback(lambda x: (running.discard(x), self.slots.release()))

    async def run_activity_once(self) -> bool:
        task = await store.claim_activity(self.sm, self.id, self.queues, sorted(self.activities))
        if task is None:
            return False
        await self._execute(task)
        return True

    async def _execute(self, task: dict) -> None:
        fn = self.activities[task["activity_type"]]
        ctx = ActivityContext(task["workflow_id"], task["activity_type"], task["seq"], task["attempt"],
                              f"{task['workflow_id']}:{task['seq']}", self.sm,
                              lambda d=None: store.heartbeat(self.sm, task["id"], task["attempt"], d))
        try:
            result = await asyncio.wait_for(fn(ctx, *task["input"]), task["start_to_close_seconds"])
        except asyncio.TimeoutError:
            outcome = await store.fail_activity(self.sm, task, f"exceeded start_to_close {task['start_to_close_seconds']}s",
                                                "ActivityTimeout", timed_out=True)
            self.stats["activities_failed"] += 1
            log.warning("activity_timeout", extra={"workflow_id": task["workflow_id"], "seq": task["seq"], "outcome": outcome})
        except Exception as exc:
            etype = "NonRetryableError" if isinstance(exc, NonRetryableError) else type(exc).__name__
            outcome = await store.fail_activity(self.sm, task, str(exc), etype)
            self.stats["activities_failed"] += 1
            log.warning("activity_failed", extra={"workflow_id": task["workflow_id"], "seq": task["seq"],
                                                  "error": str(exc), "outcome": outcome})
        else:
            if await store.complete_activity(self.sm, task, result):
                self.stats["activities_ok"] += 1
            else:
                self.stats["stale"] += 1

    # ---- timers, reaper, heartbeat ----------------------------------------------------------------------
    async def _timer_loop(self) -> None:
        while not self._stop.is_set():
            try:
                await store.fire_due_timers(self.sm)
                await store.reap_expired_activities(self.sm)
            except Exception:
                log.exception("timer_loop_error")
            await self._sleep()

    async def _heartbeat_loop(self) -> None:
        while not self._stop.is_set():
            try:
                await store.register_worker(self.sm, self.id, self.queues, sorted(self.workflows), sorted(self.activities))
            except Exception:
                log.exception("worker_heartbeat_error")
            await asyncio.sleep(5)


async def main() -> None:  # pragma: no cover - entry point
    import argparse
    import contextlib
    import signal

    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from bpcommon.logging import configure_logging

    from . import examples  # noqa: F401  (registers the example workflows and activities)
    from .config import get_settings

    ap = argparse.ArgumentParser()
    ap.add_argument("--task-queue", action="append", default=None)
    ap.add_argument("--activity-concurrency", type=int, default=8)
    a = ap.parse_args()
    s = get_settings()
    configure_logging(s.log_level, s.log_json)
    engine = create_async_engine(s.database_url, pool_size=10, max_overflow=10)
    w = Worker(async_sessionmaker(engine, expire_on_commit=False), a.task_queue or ["default"],
               activity_concurrency=a.activity_concurrency, poll_interval=s.poll_interval_seconds,
               workflow_lease=s.workflow_task_lease_seconds)
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        with contextlib.suppress(NotImplementedError):
            loop.add_signal_handler(sig, w.stop)
    try:
        await w.run()
    finally:
        await engine.dispose()


if __name__ == "__main__":  # pragma: no cover
    asyncio.run(main())
