"""Structured (JSON) logging.

Why JSON: log aggregators (Loki, ELK, CloudWatch) can index fields like
request_id / tenant_id directly instead of regex-parsing free text.
"""
from __future__ import annotations

import contextvars
import atexit
import json
import logging
import logging.handlers
import queue
import sys
import time

# Request-scoped context. contextvars are asyncio-safe: each task sees its own value.
request_id_var: contextvars.ContextVar[str | None] = contextvars.ContextVar("request_id", default=None)

_RESERVED = set(logging.LogRecord("", 0, "", 0, "", (), None).__dict__) | {"message", "asctime"}


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload = {
            "ts": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(record.created)) + f".{int(record.msecs):03d}Z",
            "level": record.levelname,
            "logger": record.name,
            "msg": record.getMessage(),
        }
        # Anything passed via logger.info("...", extra={...}) becomes a top-level field.
        for key, value in record.__dict__.items():
            if key not in _RESERVED and not key.startswith("_"):
                payload[key] = value
        if record.exc_info:
            payload["exc"] = self.formatException(record.exc_info)
        return json.dumps(payload, default=str)


class _ContextQueueHandler(logging.handlers.QueueHandler):
    """Captures the request id on the calling task BEFORE the record crosses to the writer thread
    (contextvars do not follow the record into another thread)."""

    def prepare(self, record: logging.LogRecord) -> logging.LogRecord:
        rid = request_id_var.get()
        record = super().prepare(record)
        if rid and not hasattr(record, "request_id"):
            record.request_id = rid
        return record


_listener: logging.handlers.QueueListener | None = None


def configure_logging(level: str = "INFO", json_output: bool = True) -> None:
    """Logging that never blocks the event loop.

    A plain StreamHandler writes to stdout synchronously. Under load (or with a slow
    container log driver) every write stalls the asyncio loop, and that stall shows up
    as random Redis/DB *timeouts* elsewhere. So: the loop only enqueues the record
    (QueueHandler) and a background thread does the actual I/O (QueueListener).
    """
    global _listener
    if _listener is not None:
        _listener.stop()
    stream = logging.StreamHandler(sys.stdout)
    stream.setFormatter(JsonFormatter() if json_output else logging.Formatter("%(levelname)s %(name)s %(message)s"))
    q: queue.SimpleQueue = queue.SimpleQueue()
    root = logging.getLogger()
    root.handlers[:] = [_ContextQueueHandler(q)]
    root.setLevel(level.upper())
    _listener = logging.handlers.QueueListener(q, stream, respect_handler_level=False)
    _listener.start()
    atexit.register(_listener.stop)
