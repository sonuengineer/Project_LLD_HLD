"""Workflow replay runtime.

A workflow is ordinary async Python that may only await things it gets from the WorkflowContext
(activities, timers, signals). The engine NEVER stores workflow state: on every workflow task it re-runs the
function from the beginning against the recorded history:

    start the coroutine, let it run until it blocks on ctx futures      ("settle")
    for each history event IN RECORDED ORDER:
        *Scheduled / TimerStarted     -> must match the command the code just produced (determinism check)
        *Completed / Failed / Fired   -> resolve that future, settle again
        SignalReceived                -> deliver to waiting code (or buffer), settle again
        CancelRequested               -> fail pending futures with WorkflowCancelled, settle again
    commands produced but not yet in history  -> NEW commands to persist
    coroutine finished?                       -> workflow completed / failed / cancelled

Feeding events one at a time in their recorded order is what makes races deterministic: if a signal and a
timeout timer both exist in history, the one recorded first wins on every replay.
"""
from __future__ import annotations

import asyncio
import random
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any, Awaitable, Callable


# ---- public definitions ------------------------------------------------------------------------------
@dataclass
class RetryPolicy:
    initial_interval: float = 1.0
    backoff_coefficient: float = 2.0
    maximum_interval: float = 60.0
    maximum_attempts: int = 3                      # 0 = unlimited
    non_retryable_errors: list[str] = field(default_factory=list)

    def to_json(self) -> dict:
        return self.__dict__.copy()

    @classmethod
    def from_json(cls, d: dict) -> "RetryPolicy":
        return cls(**d)

    def delay(self, attempt: int) -> float:
        return min(self.initial_interval * self.backoff_coefficient ** (attempt - 1), self.maximum_interval)


class ActivityError(Exception):
    """Raised inside workflow code when an activity failed permanently (retries exhausted / non-retryable)."""

    def __init__(self, activity: str, message: str, error_type: str = "Error", attempts: int = 0):
        super().__init__(f"activity {activity} failed after {attempts} attempt(s): {error_type}: {message}")
        self.activity, self.message, self.error_type, self.attempts = activity, message, error_type, attempts


class WorkflowCancelled(Exception):
    """Delivered into workflow code when cancellation is requested; catch it to run compensations."""


class NonDeterminismError(Exception):
    """The code no longer produces the commands recorded in history (e.g. a step was inserted/reordered)."""


WorkflowFn = Callable[..., Awaitable[Any]]
WORKFLOWS: dict[str, WorkflowFn] = {}


def workflow(name: str):
    def deco(fn: WorkflowFn) -> WorkflowFn:
        WORKFLOWS[name] = fn
        return fn
    return deco


# ---- context ---------------------------------------------------------------------------------------------
@dataclass
class Command:
    seq: int
    kind: str                                      # schedule_activity | start_timer
    attrs: dict


class WorkflowContext:
    def __init__(self, workflow_id: str, run_id: str, start_time: datetime):
        self.workflow_id, self.run_id = workflow_id, run_id
        self._seq = 0
        self.commands: dict[int, Command] = {}     # produced by the code during this replay
        self._futures: dict[int, asyncio.Future] = {}
        self._signal_queues: dict[str, list] = {}
        self._signal_waiters: dict[str, list[asyncio.Future]] = {}
        self._now = start_time
        self._rng = random.Random(run_id)          # deterministic "randomness"
        self.cancel_requested = False

    # -- deterministic helpers ---------------------------------------------------------------------------
    def now(self) -> datetime:
        """Time of the history event being replayed -- NOT the wall clock (which differs on every replay)."""
        return self._now

    def random(self) -> float:
        return self._rng.random()

    def uuid4(self) -> str:
        return str(uuid.UUID(int=self._rng.getrandbits(128), version=4))

    # -- commands ------------------------------------------------------------------------------------------
    def _next(self) -> int:
        self._seq += 1
        return self._seq

    def _future(self, seq: int) -> asyncio.Future:
        # Note: futures created AFTER cancellation work normally -- that is how compensation activities run.
        # Only what was pending at the moment of cancellation is failed (see _cancel).
        fut = asyncio.get_running_loop().create_future()
        self._futures[seq] = fut
        return fut

    def execute_activity(self, name: str, *args, retry: RetryPolicy | None = None, start_to_close: float = 30.0,
                         heartbeat_timeout: float | None = None, task_queue: str | None = None) -> asyncio.Future:
        seq = self._next()
        self.commands[seq] = Command(seq, "schedule_activity", {
            "activity_type": name, "args": list(args), "retry": (retry or RetryPolicy()).to_json(),
            "start_to_close": start_to_close, "heartbeat_timeout": heartbeat_timeout, "task_queue": task_queue})
        return self._future(seq)

    def sleep(self, seconds: float) -> asyncio.Future:
        """Durable timer: survives worker restarts; the workflow is not consuming anything while it waits."""
        seq = self._next()
        self.commands[seq] = Command(seq, "start_timer", {"seconds": seconds})
        return self._future(seq)

    async def wait_signal(self, name: str, timeout: float | None = None):
        """Next signal `name` (payload), or None on timeout. Signals are buffered, so one that arrived
        before the code started waiting is not lost."""
        q = self._signal_queues.setdefault(name, [])
        if q:
            return q.pop(0)
        fut = asyncio.get_running_loop().create_future()
        self._signal_waiters.setdefault(name, []).append(fut)
        if timeout is None:
            return await fut
        timer = self.sleep(timeout)
        done, _ = await asyncio.wait({fut, timer}, return_when=asyncio.FIRST_COMPLETED)
        if fut in done:
            return fut.result()
        if fut in self._signal_waiters.get(name, []):
            self._signal_waiters[name].remove(fut)
        timer.result()          # re-raises WorkflowCancelled if that's what ended the timer
        return None

    # -- event application (engine side) --------------------------------------------------------------------
    def _resolve(self, seq: int, result=None, exc: Exception | None = None) -> None:
        fut = self._futures.get(seq)
        if fut is None:
            raise NonDeterminismError(f"history has a completion for command {seq}, which the code never issued")
        if fut.done():
            return
        if exc is not None:
            fut.set_exception(exc)
        else:
            fut.set_result(result)

    def _signal(self, name: str, payload) -> None:
        waiters = self._signal_waiters.get(name)
        while waiters:
            fut = waiters.pop(0)
            if not fut.done():
                fut.set_result(payload)
                return
        self._signal_queues.setdefault(name, []).append(payload)

    def _cancel(self) -> None:
        self.cancel_requested = True
        for fut in list(self._futures.values()) + [f for w in self._signal_waiters.values() for f in w]:
            if not fut.done():
                fut.set_exception(WorkflowCancelled())


# ---- replay ------------------------------------------------------------------------------------------------
@dataclass
class ReplayResult:
    status: str                                    # blocked | completed | failed | cancelled
    new_commands: list[Command]
    result: Any = None
    error: str | None = None


async def _settle(task: asyncio.Task, ctx: WorkflowContext) -> None:
    """Let the workflow coroutine run until it can't make progress (only awaits unresolved ctx futures)."""
    last = None
    while True:
        for _ in range(3):
            await asyncio.sleep(0)
        state = (task.done(), len(ctx.commands), sum(f.done() for f in ctx._futures.values()))
        if state == last or task.done():
            return
        last = state


async def replay(fn: WorkflowFn, workflow_id: str, run_id: str, history: list[dict]) -> ReplayResult:
    """history: [{"event_type", "attrs", "created_at"}] in event_id order, starting with WorkflowStarted."""
    started = history[0]
    ctx = WorkflowContext(workflow_id, run_id, started["created_at"])
    task = asyncio.ensure_future(fn(ctx, started["attrs"]["input"]))
    recorded: set[int] = set()
    try:
        await _settle(task, ctx)
        for ev in history[1:]:
            ctx._now = ev["created_at"]
            et, a = ev["event_type"], ev["attrs"]
            if et in ("ActivityScheduled", "TimerStarted"):
                cmd = ctx.commands.get(a["seq"])
                want = a.get("activity_type") if et == "ActivityScheduled" else None
                # .get(): the code may now produce a TIMER where history has an activity (no activity_type key);
                # that must surface as NonDeterminismError, not a KeyError the worker can only log.
                if cmd is None or (et == "ActivityScheduled" and cmd.attrs.get("activity_type") != want) \
                        or (et == "TimerStarted" and cmd.kind != "start_timer"):
                    got = None if cmd is None else (cmd.attrs.get("activity_type") or cmd.kind)
                    raise NonDeterminismError(f"command {a['seq']}: history has {et} {want or ''} but code produced {got}")
                recorded.add(a["seq"])
                continue
            if et == "ActivityCompleted":
                ctx._resolve(a["seq"], a.get("result"))
            elif et == "ActivityFailed":
                ctx._resolve(a["seq"], exc=ActivityError(a["activity_type"], a["error"], a.get("error_type", "Error"),
                                                         a.get("attempts", 0)))
            elif et == "TimerFired":
                ctx._resolve(a["seq"], None)
            elif et == "SignalReceived":
                ctx._signal(a["name"], a.get("payload"))
            elif et == "CancelRequested":
                ctx._cancel()
            elif et in ("WorkflowCompleted", "WorkflowFailed", "WorkflowCancelled"):
                break
            await _settle(task, ctx)
        new = [c for s, c in sorted(ctx.commands.items()) if s not in recorded]
        if task.done():
            exc = task.exception()
            if exc is None:
                return ReplayResult("completed", new, result=task.result())
            if isinstance(exc, WorkflowCancelled):
                return ReplayResult("cancelled", new, error="cancelled")
            if isinstance(exc, NonDeterminismError):
                raise exc
            return ReplayResult("failed", new, error=f"{type(exc).__name__}: {exc}")
        return ReplayResult("blocked", new)
    finally:
        if not task.done():
            task.cancel()                          # the coroutine is discarded; next task replays from scratch
            try:
                await task
            except BaseException:
                pass


def fire_time(created_at: datetime, seconds: float) -> datetime:
    return created_at + timedelta(seconds=seconds)
