"""Pure replay tests on hand-built histories (no database)."""
import asyncio
from datetime import datetime, timezone

import pytest

from flowengine.runtime import ActivityError, NonDeterminismError, WorkflowCancelled, replay

T = datetime(2026, 1, 1, tzinfo=timezone.utc)


def ev(t, **a):
    return {"event_type": t, "attrs": a, "created_at": T}


async def two_steps(ctx, inp):
    a = await ctx.execute_activity("reserve", inp["sku"])
    b = await ctx.execute_activity("charge", a["id"])
    return {"reserved": a, "charged": b}


async def test_fresh_workflow_emits_first_command_only():
    r = await replay(two_steps, "wf", "run", [ev("WorkflowStarted", input={"sku": "X"})])
    assert r.status == "blocked" and [c.attrs["activity_type"] for c in r.new_commands] == ["reserve"]


async def test_replay_continues_from_history_and_completes():
    h = [ev("WorkflowStarted", input={"sku": "X"}),
         ev("ActivityScheduled", seq=1, activity_type="reserve"), ev("ActivityCompleted", seq=1, result={"id": 7}),
         ev("ActivityScheduled", seq=2, activity_type="charge"), ev("ActivityCompleted", seq=2, result="ok")]
    r = await replay(two_steps, "wf", "run", h)
    assert r.status == "completed" and r.result == {"reserved": {"id": 7}, "charged": "ok"} and r.new_commands == []


async def test_activity_failure_is_raised_in_workflow_code():
    async def wf(ctx, inp):
        try:
            await ctx.execute_activity("charge")
        except ActivityError as e:
            await ctx.execute_activity("compensate", e.error_type)
            return "compensated"
    h = [ev("WorkflowStarted", input={}), ev("ActivityScheduled", seq=1, activity_type="charge"),
         ev("ActivityFailed", seq=1, activity_type="charge", error="card declined", error_type="Declined", attempts=3)]
    r = await replay(wf, "wf", "run", h)
    assert r.status == "blocked" and r.new_commands[0].attrs == {**r.new_commands[0].attrs, "activity_type": "compensate", "args": ["Declined"]}


async def test_non_determinism_detected_when_code_changes():
    async def changed(ctx, inp):                         # someone inserted a step before "reserve"
        await ctx.execute_activity("fraud_check")
        await ctx.execute_activity("reserve", inp["sku"])
    h = [ev("WorkflowStarted", input={"sku": "X"}), ev("ActivityScheduled", seq=1, activity_type="reserve")]
    with pytest.raises(NonDeterminismError):
        await replay(changed, "wf", "run", h)


async def signal_or_timeout(ctx, inp):
    got = await ctx.wait_signal("approve", timeout=60)
    return "approved" if got else "timed_out"


async def test_race_signal_first_wins():
    h = [ev("WorkflowStarted", input={}), ev("TimerStarted", seq=1, seconds=60),
         ev("SignalReceived", name="approve", payload={"by": "ann"}), ev("TimerFired", seq=1)]
    assert (await replay(signal_or_timeout, "wf", "run", h)).result == "approved"


async def test_race_timer_first_wins():
    h = [ev("WorkflowStarted", input={}), ev("TimerStarted", seq=1, seconds=60),
         ev("TimerFired", seq=1), ev("SignalReceived", name="approve", payload={"by": "ann"})]
    assert (await replay(signal_or_timeout, "wf", "run", h)).result == "timed_out"


async def test_signal_before_waiting_is_buffered():
    async def wf(ctx, inp):
        await ctx.execute_activity("prepare")
        return await ctx.wait_signal("go")
    h = [ev("WorkflowStarted", input={}), ev("ActivityScheduled", seq=1, activity_type="prepare"),
         ev("SignalReceived", name="go", payload=42), ev("ActivityCompleted", seq=1, result=None)]
    assert (await replay(wf, "wf", "run", h)).result == 42


async def test_parallel_activities_with_gather():
    async def wf(ctx, inp):
        return await asyncio.gather(*[ctx.execute_activity("send", r) for r in inp["to"]])
    r = await replay(wf, "wf", "run", [ev("WorkflowStarted", input={"to": ["a", "b", "c"]})])
    assert [c.attrs["args"] for c in r.new_commands] == [["a"], ["b"], ["c"]]


async def test_cancellation_delivered_into_workflow_for_compensation():
    async def wf(ctx, inp):
        try:
            await ctx.sleep(3600)
        except WorkflowCancelled:
            await ctx.execute_activity("undo")
            raise
    h = [ev("WorkflowStarted", input={}), ev("TimerStarted", seq=1, seconds=3600), ev("CancelRequested")]
    r = await replay(wf, "wf", "run", h)
    assert r.status == "blocked" and r.new_commands[0].attrs["activity_type"] == "undo"
    h += [ev("ActivityScheduled", seq=2, activity_type="undo"), ev("ActivityCompleted", seq=2, result=None)]
    assert (await replay(wf, "wf", "run", h)).status == "cancelled"


async def test_deterministic_helpers():
    async def wf(ctx, inp):
        return [ctx.uuid4(), ctx.random(), ctx.now().isoformat()]
    a = await replay(wf, "wf", "run-1", [ev("WorkflowStarted", input={})])
    b = await replay(wf, "wf", "run-1", [ev("WorkflowStarted", input={})])
    assert a.result == b.result                      # same history -> same "random" values and time
