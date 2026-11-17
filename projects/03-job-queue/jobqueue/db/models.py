"""Postgres tables used by job HANDLERS (the business side), not by the queue mechanics."""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, Integer, String, Text, func
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


class ProcessedJob(Base):
    """Idempotency ledger. A handler inserts its job id here IN THE SAME TRANSACTION as its side
    effect. If the job is delivered again (at-least-once), the insert conflicts and the handler
    skips the side effect -> effectively-once processing on top of at-least-once delivery."""
    __tablename__ = "processed_jobs"

    job_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    job_type: Mapped[str] = mapped_column(String(64))
    attempt: Mapped[int] = mapped_column(Integer)
    completed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class EmailOutbox(Base):
    """Stand-in for 'an email was sent'. The unique constraint is a second line of defence:
    even a buggy handler can't create two rows for one logical email."""
    __tablename__ = "email_outbox"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    dedupe_key: Mapped[str] = mapped_column(String(200), unique=True)
    job_id: Mapped[str] = mapped_column(String(64), index=True)
    recipient: Mapped[str] = mapped_column(String(320))
    subject: Mapped[str] = mapped_column(String(500))
    body: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
