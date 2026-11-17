from __future__ import annotations

from enum import StrEnum
from typing import Any

from pydantic import BaseModel, Field, field_validator, model_validator


class JobStatus(StrEnum):
    QUEUED = "queued"        # in the ready zset, waiting for a worker
    DELAYED = "delayed"      # scheduled for later (run_at) or waiting for a retry backoff
    ACTIVE = "active"        # leased by a worker
    SUCCEEDED = "succeeded"
    DEAD = "dead"            # exhausted retries -> dead letter queue
    CANCELLED = "cancelled"


class EnqueueRequest(BaseModel):
    type: str = Field(pattern=r"^[a-z0-9_.]{1,64}$")
    payload: dict[str, Any] = Field(default_factory=dict)
    queue: str = Field(default="default", pattern=r"^[a-z0-9_\-]{1,32}$")
    priority: int = Field(default=5, ge=0, le=9, description="0 lowest .. 9 highest")
    delay_seconds: float | None = Field(default=None, ge=0)
    run_at_ms: int | None = Field(default=None, description="absolute unix ms; scheduled job")
    max_attempts: int = Field(default=5, ge=1, le=50)
    timeout_seconds: float = Field(default=30, gt=0, le=3600)
    backoff_base_seconds: float = Field(default=2, gt=0, le=600)
    backoff_max_seconds: float = Field(default=600, gt=0)
    idempotency_key: str | None = Field(default=None, max_length=200)

    @model_validator(mode="after")
    def _one_schedule(self):
        if self.delay_seconds is not None and self.run_at_ms is not None:
            raise ValueError("use either delay_seconds or run_at_ms, not both")
        return self


class Job(BaseModel):
    id: str
    type: str
    queue: str
    payload: dict[str, Any]
    priority: int
    status: JobStatus
    attempts: int
    max_attempts: int
    timeout_ms: int
    backoff_base_ms: int
    backoff_max_ms: int
    created_at: int
    run_at: int | None = None
    started_at: int | None = None
    finished_at: int | None = None
    lease_until: int | None = None
    worker: str | None = None
    last_error: str | None = None
    last_failure_reason: str | None = None
    result: Any = None
    idempotency_key: str | None = None
    errors: list[dict] = Field(default_factory=list)

    @field_validator("payload", mode="before")
    @classmethod
    def _json(cls, v):
        import json
        return json.loads(v) if isinstance(v, str) else v


class ScheduleRequest(BaseModel):
    name: str = Field(pattern=r"^[a-z0-9_\-]{1,64}$")
    interval_seconds: float = Field(ge=1)
    job: EnqueueRequest
    start_in_seconds: float = Field(default=0, ge=0)
