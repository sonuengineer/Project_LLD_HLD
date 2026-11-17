"""Activity registry + context. Activities do the real work (I/O, side effects) and may fail/retry; workflows
only orchestrate them.

Every activity receives ActivityContext.idempotency_key = "<workflow_id>:<seq>" -- identical on every retry and
redelivery of that activity -- so side effects can be made exactly-once (e.g. pass it to a payment provider, or
use it as a unique key, as the example activities do)."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Awaitable, Callable

ACTIVITIES: dict[str, Callable[..., Awaitable[Any]]] = {}


class NonRetryableError(Exception):
    """Raise for errors retrying can't fix; listed in RetryPolicy.non_retryable_errors by type name too."""


def activity(name: str):
    def deco(fn):
        ACTIVITIES[name] = fn
        return fn
    return deco


@dataclass
class ActivityContext:
    workflow_id: str
    activity_type: str
    seq: int
    attempt: int
    idempotency_key: str
    sm: Any
    _heartbeat: Callable[[Any], Awaitable[bool]]

    async def heartbeat(self, details: Any = None) -> bool:
        return await self._heartbeat(details)
