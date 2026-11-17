"""Handler registry. A handler is `async def fn(ctx: JobContext) -> result (JSON-serializable)`."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

from sqlalchemy.ext.asyncio import async_sessionmaker

from ..core.models import Job


class PermanentError(Exception):
    """Raise for errors that retrying can't fix (bad payload, unknown customer...). Job goes
    straight to the DLQ instead of burning its remaining attempts."""


@dataclass
class JobContext:
    job: Job
    attempt: int
    sessionmaker: async_sessionmaker | None
    worker_id: str
    extras: dict[str, Any] = field(default_factory=dict)

    @property
    def payload(self) -> dict[str, Any]:
        return self.job.payload


Handler = Callable[[JobContext], Awaitable[Any]]


class Registry:
    def __init__(self) -> None:
        self._handlers: dict[str, Handler] = {}

    def task(self, name: str):
        def deco(fn: Handler) -> Handler:
            self._handlers[name] = fn
            return fn
        return deco

    def get(self, name: str) -> Handler | None:
        return self._handlers.get(name)

    def names(self) -> list[str]:
        return sorted(self._handlers)
