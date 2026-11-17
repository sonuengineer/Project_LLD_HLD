"""Example handlers. `email.send` is the important one: it shows the idempotent-consumer pattern."""
from __future__ import annotations

import asyncio

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert

from ..db.models import EmailOutbox, ProcessedJob
from . import JobContext, PermanentError, Registry

registry = Registry()


@registry.task("email.send")
async def send_email(ctx: JobContext):
    """At-least-once delivery means this may run twice for the same job (worker crashed after
    committing but before acking; lease expired while the handler was still running; ...).

    Defence: claim the job id in `processed_jobs` and write the side effect in ONE transaction.
    Second run -> INSERT ... ON CONFLICT DO NOTHING returns no row -> skip, report duplicate.
    """
    p = ctx.payload
    if "to" not in p or "@" not in p["to"]:
        raise PermanentError(f"invalid recipient {p.get('to')!r}")
    async with ctx.sessionmaker() as session, session.begin():
        claimed = await session.execute(
            insert(ProcessedJob).values(job_id=ctx.job.id, job_type=ctx.job.type, attempt=ctx.attempt)
            .on_conflict_do_nothing(index_elements=["job_id"]).returning(ProcessedJob.job_id))
        if claimed.scalar_one_or_none() is None:
            existing = await session.scalar(select(EmailOutbox.id).where(EmailOutbox.job_id == ctx.job.id))
            return {"duplicate": True, "email_id": existing}
        result = await session.execute(
            insert(EmailOutbox).values(dedupe_key=p.get("dedupe_key", ctx.job.id), job_id=ctx.job.id,
                                       recipient=p["to"], subject=p.get("subject", ""), body=p.get("body", ""))
            .returning(EmailOutbox.id))
        email_id = result.scalar_one()
    # Test hook: simulate the worker dying AFTER the commit but BEFORE the ack.
    if p.get("crash_after_commit") and ctx.attempt == 1:
        await asyncio.sleep(3600)
    return {"duplicate": False, "email_id": email_id}


@registry.task("report.generate")
async def generate_report(ctx: JobContext):
    await asyncio.sleep(float(ctx.payload.get("seconds", 0.05)))
    return {"rows": int(ctx.payload.get("rows", 100)), "format": ctx.payload.get("format", "csv")}


@registry.task("demo.flaky")
async def flaky(ctx: JobContext):
    """Fails until attempt >= succeed_on_attempt. Shows retries + backoff."""
    if ctx.attempt < int(ctx.payload.get("succeed_on_attempt", 3)):
        raise RuntimeError(f"transient failure on attempt {ctx.attempt}")
    return {"succeeded_on_attempt": ctx.attempt}


@registry.task("demo.poison")
async def poison(ctx: JobContext):
    """Always fails: a poison message. Must end in the DLQ, not loop forever."""
    raise ValueError("cannot process this payload")


@registry.task("demo.sleep")
async def sleep(ctx: JobContext):
    await asyncio.sleep(float(ctx.payload.get("seconds", 1)))
    return {"slept": ctx.payload.get("seconds", 1)}


@registry.task("demo.cpu_block")
async def cpu_block(ctx: JobContext):
    """BAD handler on purpose: blocks the event loop (time.sleep). While blocked, the worker can't
    extend leases or heartbeat -> lease expires -> job is redelivered (duplicate execution)."""
    import time
    time.sleep(float(ctx.payload.get("seconds", 1)))
    return {"blocked": ctx.payload.get("seconds", 1)}
