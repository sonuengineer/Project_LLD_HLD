"""End-to-end: real workers, real Postgres, the five example workflows, and failure recovery."""
import asyncio

from sqlalchemy import text

from flowengine import store
from flowengine.runtime import WORKFLOWS, RetryPolicy, workflow

from .conftest import effects, wait_status, worker


async def events_of(sm, wid):
    return [e["event_type"] for e in await store.history(sm, wid)]


async def test_order_processing_happy_path(sm):
    await store.start_workflow(sm, "order_processing", "order-1",
                               {"order_id": "1", "items": ["book"], "amount": 500, "customer": "a@x.io"})
    async with worker(sm):
        wf = await wait_status(sm, "order-1")
    assert wf["result"]["status"] == "completed" and wf["result"]["tracking"] == "TRK-1"
    assert await effects(sm) == {"reserve": 1, "charge": 1, "ship": 1, "email": 1}
    ev = await events_of(sm, "order-1")
    assert ev[0] == "WorkflowStarted" and ev[-1] == "WorkflowCompleted"
    assert ev.count("ActivityScheduled") == ev.count("ActivityCompleted") == 4


async def test_retries_with_backoff_then_success_effect_once(sm):
    await store.start_workflow(sm, "order_processing", "order-flaky",
                               {"order_id": "2", "items": [], "amount": 100, "card": "flaky", "customer": "b@x.io"})
    async with worker(sm):
        wf = await wait_status(sm, "order-flaky")
    charge = next(a for a in wf["activities"] if a["activity_type"] == "charge_payment")
    assert wf["result"]["status"] == "completed" and charge["attempt"] == 3
    assert (await effects(sm, "charge")) == {"charge": 1}


async def test_non_retryable_failure_runs_compensation(sm):
    await store.start_workflow(sm, "order_processing", "order-declined",
                               {"order_id": "3", "items": ["x"], "amount": 100, "card": "declined", "customer": "c@x.io"})
    async with worker(sm):
        wf = await wait_status(sm, "order-declined")
    assert wf["result"] == {"status": "payment_failed", "reason": "card declined"}
    assert next(a for a in wf["activities"] if a["activity_type"] == "charge_payment")["attempt"] == 1
    assert await effects(sm) == {"reserve": 1, "release": 1}


async def test_saga_compensation_when_shipping_fails(sm):
    await store.start_workflow(sm, "order_processing", "order-noship",
                               {"order_id": "4", "items": ["x"], "amount": 900, "fail_shipping": True, "customer": "d@x.io"})
    async with worker(sm):
        wf = await wait_status(sm, "order-noship")
    assert wf["result"]["status"] == "compensated"
    assert await effects(sm) == {"reserve": 1, "charge": 1, "refund": 1, "release": 1}


async def test_payment_and_refund_signal_vs_timer(sm):
    await store.start_workflow(sm, "payment_and_refund", "pay-delivered", {"amount": 10, "delivery_timeout": 30})
    await store.start_workflow(sm, "payment_and_refund", "pay-lost", {"amount": 20, "delivery_timeout": 0.3})
    async with worker(sm):
        for _ in range(100):
            if "TimerStarted" in await events_of(sm, "pay-delivered"):
                break
            await asyncio.sleep(0.03)
        await store.signal(sm, "pay-delivered", "delivered", {"at": "2026-11-17"})
        a = await wait_status(sm, "pay-delivered")
        b = await wait_status(sm, "pay-lost")
    assert a["result"] == {"status": "paid", "delivered_at": "2026-11-17"}
    assert b["result"] == {"status": "refunded_not_delivered"}
    assert await effects(sm, "refund") == {"refund": 1}


async def test_customer_onboarding_with_signal_and_durable_timer(sm):
    await store.start_workflow(sm, "customer_onboarding", "onb-1", {"email": "n@x.io", "verify_within": 30, "tips_after": 0.2})
    await store.signal(sm, "onb-1", "verified", {"ok": True})      # arrives early: buffered in history
    async with worker(sm):
        wf = await wait_status(sm, "onb-1")
    assert wf["result"]["verified_in_time"] is True
    async with sm() as s:
        templates = (await s.execute(text("SELECT payload->>'template' FROM activity_effects WHERE kind = 'email' ORDER BY created_at"))).scalars().all()
    assert templates == ["welcome", "tips"]                        # no reminder


async def test_document_approval_escalation_and_cancellation(sm):
    base = {"approvers": "team", "escalation_to": "boss", "escalate_after": 0.2}
    await store.start_workflow(sm, "document_approval", "doc-1", {**base, "doc_id": "D1"})
    await store.start_workflow(sm, "document_approval", "doc-2", {**base, "doc_id": "D2", "escalate_after": 60})
    async with worker(sm):
        for _ in range(200):
            if (await events_of(sm, "doc-1")).count("ActivityCompleted") >= 2:   # notify + escalation notify
                break
            await asyncio.sleep(0.03)
        await store.signal(sm, "doc-1", "decision", {"approved": True, "by": "boss"})
        d1 = await wait_status(sm, "doc-1")
        for _ in range(100):
            if "TimerStarted" in await events_of(sm, "doc-2"):
                break
            await asyncio.sleep(0.03)
        await store.cancel(sm, "doc-2", "superseded")
        d2 = await wait_status(sm, "doc-2", "cancelled")
    assert d1["result"] == {"status": "approved", "by": "boss"}
    async with sm() as s:
        msgs = (await s.execute(text("SELECT payload->>'message' FROM activity_effects WHERE kind = 'notify' ORDER BY created_at"))).scalars().all()
    assert any("cancelled" in m for m in msgs) and any("waiting for approval" in m for m in msgs)
    assert (await events_of(sm, "doc-2"))[-1] == "WorkflowCancelled"


async def test_email_campaign_parallel_batches(sm):
    rcpts = [f"u{i}@x.io" for i in range(6)] + ["bounce@x.io"]
    await store.start_workflow(sm, "email_campaign", "camp-1", {"recipients": rcpts, "batch_size": 3, "pause": 0.05,
                                                                 "template": "promo"})
    async with worker(sm, activity_concurrency=8):
        wf = await wait_status(sm, "camp-1")
    assert wf["result"] == {"sent": 6, "failed": ["bounce@x.io"], "batches": 3}
    assert await effects(sm, "email") == {"email": 6}


async def test_start_is_idempotent_on_workflow_id(sm):
    a = await store.start_workflow(sm, "email_campaign", "same", {"recipients": [], "batch_size": 1, "pause": 0, "template": "t"})
    b = await store.start_workflow(sm, "email_campaign", "same", {"recipients": [], "batch_size": 1, "pause": 0, "template": "t"})
    assert a["started"] and not b["started"] and a["run_id"] == b["run_id"]


async def test_worker_crash_another_worker_resumes_from_history(sm):
    """Worker A runs part of the workflow and 'dies'; worker B (fresh process state) continues from history."""
    await store.start_workflow(sm, "customer_onboarding", "onb-crash", {"email": "z@x.io", "verify_within": 0.2,
                                                                        "tips_after": 0.5})
    async with worker(sm, worker_id="A"):
        for _ in range(200):
            if "TimerStarted" in await events_of(sm, "onb-crash"):
                break
            await asyncio.sleep(0.02)
    # worker A is gone; nothing of the workflow lives in memory anywhere
    async with worker(sm, worker_id="B"):
        wf = await wait_status(sm, "onb-crash")
    assert wf["result"]["verified_in_time"] is False
    assert await effects(sm) == {"account": 1, "email": 3}          # welcome, reminder, tips -- each exactly once


@workflow("heartbeat_test")
async def heartbeat_test(ctx, inp):
    return await ctx.execute_activity("long_task", inp["chunks"], inp["chunk"], heartbeat_timeout=0.5, start_to_close=30,
                                      retry=RetryPolicy(initial_interval=0.05, maximum_attempts=5))


async def test_activity_heartbeat_timeout_detects_dead_worker(sm):
    await store.start_workflow(sm, "heartbeat_test", "hb-1", {"chunks": 10, "chunk": 0.1})
    async with worker(sm, worker_id="A", crash=True):
        for _ in range(200):
            async with sm() as s:
                st = await s.scalar(text("SELECT heartbeat_details->>'done' FROM activity_tasks WHERE workflow_id = 'hb-1'"))
            if st and int(st) >= 3:
                break
            await asyncio.sleep(0.02)
    # A crashed mid-activity (no more heartbeats). Lease = heartbeat timeout (0.5s), not start_to_close (30s).
    async with worker(sm, worker_id="B"):
        wf = await wait_status(sm, "hb-1", timeout=10)
    act = wf["activities"][0]
    assert wf["result"] == {"chunks": 10} and act["attempt"] == 2 and "lease expired" in (act["last_error"] or "")
    assert await effects(sm, "long_task") == {"long_task": 1}


async def test_two_workers_process_many_workflows_without_duplicates(sm):
    for i in range(20):
        await store.start_workflow(sm, "order_processing", f"bulk-{i}",
                                   {"order_id": str(i), "items": [], "amount": 1, "customer": f"{i}@x.io"})
    async with worker(sm, worker_id="W1"), worker(sm, worker_id="W2"):
        for i in range(20):
            await wait_status(sm, f"bulk-{i}", timeout=30)
    assert await effects(sm) == {"reserve": 20, "charge": 20, "ship": 20, "email": 20}


async def test_nondeterministic_deploy_is_detected_and_workflow_survives(sm):
    @workflow("versioned")
    async def v1(ctx, inp):
        await ctx.execute_activity("notify", "x", "step 1")
        await ctx.wait_signal("go")
        return "done"
    await store.start_workflow(sm, "versioned", "ver-1", {})
    async with worker(sm):
        for _ in range(200):
            if "ActivityCompleted" in await events_of(sm, "ver-1"):
                break
            await asyncio.sleep(0.02)

    async def v2(ctx, inp):                      # "new deploy": a step inserted before the existing one
        # (a DIFFERENT activity type: like Temporal, replay compares command/activity types, not arguments --
        #  inserting another "notify" with new args would NOT be detected)
        await ctx.execute_activity("archive_document", "compliance")
        await ctx.execute_activity("notify", "x", "step 1")
        await ctx.wait_signal("go")
        return "done"
    WORKFLOWS["versioned"] = v2
    try:
        await store.signal(sm, "ver-1", "go", None)
        async with worker(sm) as w:
            for _ in range(200):
                if w.stats["nondeterminism"]:
                    break
                await asyncio.sleep(0.02)
        d = await store.describe(sm, "ver-1")
        assert d["status"] == "running" and "NonDeterminismError" in d["error"]   # not failed: blocked until fixed
    finally:
        WORKFLOWS["versioned"] = v1                # roll back the bad deploy
    out = await store.retry_workflow_task(sm, "ver-1")     # operator: "fixed code deployed, try again"
    assert "NonDeterminismError" in out["previous_error"]
    async with worker(sm):
        wf = await wait_status(sm, "ver-1")
    assert wf["result"] == "done"


async def test_stale_workflow_task_is_discarded_when_history_moves(sm):
    from flowengine.runtime import replay
    await store.start_workflow(sm, "payment_and_refund", "stale-1", {"amount": 1, "delivery_timeout": 60})
    t = await store.claim_workflow_task(sm, "w", ["default"], 10, sorted(WORKFLOWS))
    outcome = await replay(WORKFLOWS["payment_and_refund"], "stale-1", str(t["run_id"]), t["history"])
    await store.signal(sm, "stale-1", "delivered", {"at": "now"})     # lands while we were replaying
    assert await store.complete_workflow_task(sm, t, outcome) is False
    d = await store.describe(sm, "stale-1")
    assert d["needs_task"] is True and d["activities"] == []          # nothing from the stale result was applied
