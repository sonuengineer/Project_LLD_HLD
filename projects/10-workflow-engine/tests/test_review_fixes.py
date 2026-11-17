"""Regression tests for review fixes (2026-11-17)."""
import asyncio
from datetime import datetime, timezone

import pytest
from sqlalchemy import text

from flowengine import store
from flowengine.runtime import ActivityError, NonDeterminismError, RetryPolicy, replay, workflow

from .conftest import effects, wait_status, worker

T = datetime(2026, 1, 1, tzinfo=timezone.utc)


async def test_timer_where_history_has_activity_is_nondeterminism_not_keyerror():
    async def now_sleeps(ctx, inp):          # new code: a timer where the old code scheduled an activity
        await ctx.sleep(5)
    h = [{"event_type": "WorkflowStarted", "attrs": {"input": {}}, "created_at": T},
         {"event_type": "ActivityScheduled", "attrs": {"seq": 1, "activity_type": "reserve"}, "created_at": T}]
    with pytest.raises(NonDeterminismError):
        await replay(now_sleeps, "wf", "run", h)


@workflow("s2c_test")
async def s2c_test(ctx, inp):
    try:
        await ctx.execute_activity("long_task", 50, 0.1, start_to_close=0.3,
                                   retry=RetryPolicy(initial_interval=0.05, maximum_attempts=2))
    except ActivityError as exc:
        return {"failed": exc.error_type, "attempts": exc.attempts}
    return "finished"


async def test_start_to_close_timeout_retries_then_fails(sm):
    await store.start_workflow(sm, "s2c_test", "s2c-1", {})
    async with worker(sm):
        wf = await wait_status(sm, "s2c-1", timeout=10)
    assert wf["result"] == {"failed": "ActivityTimeout", "attempts": 2}
    assert "start_to_close" in wf["activities"][0]["last_error"]
    assert await effects(sm, "long_task") == {}


@workflow("cancel_running")
async def cancel_running(ctx, inp):
    return await ctx.execute_activity("long_task", 100, 0.05, heartbeat_timeout=2, start_to_close=30)


async def test_cancel_stops_running_activity_and_it_is_never_retried(sm):
    await store.start_workflow(sm, "cancel_running", "cr-1", {})
    async with worker(sm):
        for _ in range(300):
            async with sm() as s:
                done = await s.scalar(text("SELECT heartbeat_details->>'done' FROM activity_tasks WHERE workflow_id = 'cr-1'"))
            if done and int(done) >= 2:
                break
            await asyncio.sleep(0.02)
        await store.cancel(sm, "cr-1", "user cancelled")
        wf = await wait_status(sm, "cr-1", status="cancelled")
        await asyncio.sleep(0.5)             # give the activity time to notice (heartbeat -> False) and stop
        async with sm() as s:
            row = (await s.execute(text("SELECT status, attempt FROM activity_tasks WHERE workflow_id = 'cr-1'"))).one()
        assert tuple(row) == ("cancelled", 1)                # stopped, not reaped and retried later
        assert await store.reap_expired_activities(sm) == 0
    ev = [e["event_type"] for e in await store.history(sm, "cr-1")]
    assert ev[-1] == "WorkflowCancelled" and "ActivityCompleted" not in ev   # nothing appended after close
    assert await effects(sm, "long_task") == {}
    assert wf["status"] == "cancelled"


async def test_late_activity_completion_after_close_appends_nothing(sm):
    await store.start_workflow(sm, "cancel_running", "late-1", {})
    async with worker(sm):
        for _ in range(300):
            async with sm() as s:
                if await s.scalar(text("SELECT count(*) FROM activity_tasks WHERE workflow_id = 'late-1' AND status = 'started'")):
                    break
            await asyncio.sleep(0.02)
        async with sm() as s:
            task = dict((await s.execute(text("SELECT * FROM activity_tasks WHERE workflow_id = 'late-1'"))).mappings().one())
        await store.cancel(sm, "late-1")
        await wait_status(sm, "late-1", status="cancelled")
    n_before = len(await store.history(sm, "late-1"))
    assert await store.complete_activity(sm, task, {"late": True}) is False
    assert await store.fail_activity(sm, task, "boom", "Error") == "stale"
    assert len(await store.history(sm, "late-1")) == n_before


async def test_stale_commit_does_not_clear_another_workers_lease(sm):
    await store.start_workflow(sm, "payment_and_refund", "lease-1", {"amount": 1, "delivery_timeout": 60})
    types = ["payment_and_refund"]
    t1 = await store.claim_workflow_task(sm, "w1", ["default"], 0.05, types)
    await asyncio.sleep(0.1)                                   # w1 stalls; its lease expires
    t2 = await store.claim_workflow_task(sm, "w2", ["default"], 30, types)
    assert t1 and t2 and t2["locked_by"] == "w2"
    await store.signal(sm, "lease-1", "delivered", {})         # history moves -> w1's result is stale
    assert await store.complete_workflow_task(sm, t1, None, "late") is False
    async with sm() as s:
        assert await s.scalar(text("SELECT locked_by FROM workflows WHERE workflow_id = 'lease-1'")) == "w2"


async def test_retry_task_requeues_only_running_workflows(sm):
    await store.start_workflow(sm, "cancel_running", "rt-1", {})
    async with sm() as s, s.begin():
        await s.execute(text("UPDATE workflows SET needs_task = false, error = 'NonDeterminismError: x' WHERE workflow_id = 'rt-1'"))
    out = await store.retry_workflow_task(sm, "rt-1")
    assert out["requeued"] and out["previous_error"].startswith("NonDeterminismError")
    await store.cancel(sm, "rt-1")
    async with worker(sm):
        await wait_status(sm, "rt-1", status="cancelled")
    with pytest.raises(Exception, match="cancelled"):
        await store.retry_workflow_task(sm, "rt-1")
