"""Dispatcher: claims due deliveries from Postgres and POSTs them to customer endpoints.

Claim = one UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED):
  - SKIP LOCKED: concurrent dispatchers skip rows another transaction has locked instead of
    waiting -> N dispatchers pull disjoint batches with no coordination service.
  - The UPDATE sets a lease (locked_until). A dispatcher that dies mid-send leaves the row
    'in_flight' with an expired lease -> the same claim query picks it up again.
  - attempts++ at claim time is the fencing token: the result is only recorded if
    attempts still equals what we claimed (a zombie can't overwrite a newer attempt).
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import random
import socket
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

import httpx
from sqlalchemy import text, update
from sqlalchemy.ext.asyncio import async_sessionmaker

from ..config import Settings
from ..db.models import Delivery
from ..services.ratelimit import EndpointRateLimiter
from ..services.signing import signature_header
from ..services.ssrf import BlockedDestination, assert_public_destination

log = logging.getLogger(__name__)
MAX_RETRY_AFTER_SECONDS = 24 * 3600

CLAIM_SQL = text("""
WITH claimed AS (
  UPDATE deliveries d
     SET status = 'in_flight', attempts = d.attempts + 1, locked_by = :worker,
         locked_until = now() + make_interval(secs => :lease)
   WHERE d.id IN (
         SELECT d2.id FROM deliveries d2
           JOIN endpoints e ON e.id = d2.endpoint_id AND e.enabled
          WHERE (d2.status = 'pending' AND d2.next_attempt_at <= now())
             OR (d2.status = 'in_flight' AND d2.locked_until < now())
          ORDER BY d2.next_attempt_at
          LIMIT :batch
          FOR UPDATE OF d2 SKIP LOCKED)
  RETURNING d.id, d.event_id, d.endpoint_id, d.attempts)
-- Return everything the send needs in the SAME round trip (no per-delivery reads afterwards).
SELECT c.id, c.event_id, c.endpoint_id, c.attempts,
       ev.type, ev.payload, ev.created_at,
       e.url, e.secret, e.previous_secret, e.previous_secret_expires_at, e.rate_limit_per_second
  FROM claimed c JOIN events ev ON ev.id = c.event_id JOIN endpoints e ON e.id = c.endpoint_id
""")

# Record the outcome in ONE statement: fenced delivery update + attempt log + endpoint health.
# The endpoint row is only touched when something changes (failure, or first success after
# failures): every success writing "consecutive_failures = 0" to one shared row made all
# concurrent deliveries for an endpoint queue on that row lock.
RECORD_SQL = text("""
WITH d AS (
  UPDATE deliveries
     SET status = :status, next_attempt_at = COALESCE(:next_at, next_attempt_at),
         delivered_at = :delivered_at, last_status_code = :code, last_error = :err,
         locked_until = NULL, locked_by = NULL
   WHERE id = :id AND attempts = :attempt AND status = 'in_flight'
  RETURNING id),
a AS (
  INSERT INTO delivery_attempts (delivery_id, attempt, started_at, duration_ms, status_code, outcome, error,
                                 response_snippet)
  SELECT id, :attempt, now(), :dur, :code, :outcome, :err, :snippet FROM d),
e AS (
  UPDATE endpoints
     SET consecutive_failures = CASE WHEN :success THEN 0 ELSE consecutive_failures + 1 END,
         enabled = CASE WHEN :gone OR (NOT :success AND consecutive_failures + 1 >= :threshold)
                        THEN false ELSE enabled END,
         disabled_reason = CASE
            WHEN :gone THEN 'endpoint returned 410 Gone'
            WHEN enabled AND NOT :success AND consecutive_failures + 1 >= :threshold
              THEN 'auto-disabled after ' || (consecutive_failures + 1) || ' consecutive failures'
            ELSE disabled_reason END
   WHERE id = :endpoint_id AND EXISTS (SELECT 1 FROM d)
     AND (NOT :success OR consecutive_failures <> 0))
SELECT count(*) FROM d
""")


@dataclass
class Claimed:
    id: int
    event_id: str
    endpoint_id: str
    attempt: int
    event_type: str = ""
    payload: dict | None = None
    event_created_at: datetime | None = None
    url: str = ""
    secret: str = ""
    previous_secret: str | None = None
    previous_secret_expires_at: datetime | None = None
    rate_limit_per_second: float = 10.0


@dataclass
class SendResult:
    outcome: str                 # success | http_error | timeout | connect_error | blocked | rate_limited
    status_code: int | None = None
    error: str | None = None
    snippet: str | None = None
    retry_after_s: float | None = None
    duration_ms: int = 0


def _retry_after(resp: httpx.Response) -> float | None:
    raw = resp.headers.get("retry-after")
    if raw is None:
        return None
    try:
        # Cap: a hostile or buggy endpoint must not park a delivery for years.
        return min(max(float(raw), 0.0), MAX_RETRY_AFTER_SECONDS)
    except ValueError:
        return None  # HTTP-date form not supported; fall back to our schedule


class Dispatcher:
    def __init__(self, settings: Settings, sessionmaker: async_sessionmaker, limiter: EndpointRateLimiter, *,
                 transport: httpx.AsyncBaseTransport | None = None, worker_id: str | None = None,
                 batch_size: int = 20, concurrency: int = 20):
        self.cfg = settings
        self.sm = sessionmaker
        self.limiter = limiter
        self.id = worker_id or f"{socket.gethostname()}-{os.getpid()}"
        self.batch_size = batch_size
        self.sem = asyncio.Semaphore(concurrency)
        self.client = httpx.AsyncClient(
            transport=transport, follow_redirects=False,   # redirects are an SSRF bypass
            timeout=httpx.Timeout(settings.request_timeout_seconds, connect=settings.connect_timeout_seconds),
            headers={"user-agent": "bp-webhooks/1.0"})
        self._stop = asyncio.Event()
        self.stats = {"sent": 0, "succeeded": 0, "failed": 0, "dead": 0, "rate_limited": 0, "stale": 0}

    def stop(self) -> None:
        self._stop.set()

    async def aclose(self) -> None:
        await self.client.aclose()

    # ---- loop ---------------------------------------------------------------------------------
    async def run(self, idle_sleep: float = 0.5) -> None:
        backoff = idle_sleep
        while not self._stop.is_set():
            try:
                n = await self.run_once()
                backoff = idle_sleep
            except Exception:
                # Postgres restart / network blip: log and retry with backoff instead of exiting the process.
                log.exception("dispatch_loop_error")
                n = 0
                backoff = min(backoff * 2, 30.0)
            if n == 0:
                try:
                    await asyncio.wait_for(self._stop.wait(), timeout=backoff)
                except asyncio.TimeoutError:
                    pass

    async def run_once(self) -> int:
        batch = await self.claim()
        await asyncio.gather(*[self._guarded(c) for c in batch])
        return len(batch)

    async def _guarded(self, c: Claimed) -> None:
        async with self.sem:
            try:
                await self.deliver(c)
            except Exception as exc:
                # Count the crash as a failed attempt so retry limits / the DLQ still apply. (Previously the row
                # stayed in_flight and was re-claimed forever with unbounded attempts.) If recording fails too,
                # the lease expires and the claim-time backstop below dead-letters exhausted rows.
                log.exception("deliver_crashed", extra={"delivery_id": c.id})
                try:
                    await self._record(c, SendResult("internal_error", error=f"{type(exc).__name__}: {exc}"[:500]))
                except Exception:
                    log.exception("record_after_crash_failed", extra={"delivery_id": c.id})

    async def claim(self) -> list[Claimed]:
        async with self.sm() as s, s.begin():
            # Backstop: rows whose lease expired after their LAST allowed attempt go dead, not round again.
            await s.execute(text(
                "UPDATE deliveries SET status = 'dead', locked_until = NULL, locked_by = NULL, "
                "last_error = coalesce(last_error, '') || ' [dead: lease expired after final attempt]' "
                "WHERE status = 'in_flight' AND locked_until < now() AND attempts >= :max"),
                {"max": len(self.cfg.retry_schedule_seconds) + 1})
            rows = (await s.execute(CLAIM_SQL, {"worker": self.id, "lease": self.cfg.lease_seconds,
                                                "batch": self.batch_size})).all()
        return [Claimed(*r) for r in rows]

    # ---- one delivery -------------------------------------------------------------------------
    async def deliver(self, c: Claimed) -> str:
        wait_ms = await self.limiter.acquire(c.endpoint_id, c.rate_limit_per_second)
        if wait_ms:
            return await self._reschedule_without_attempt(c, wait_ms)
        body = json.dumps({"id": c.event_id, "type": c.event_type, "created_at": c.event_created_at.isoformat(),
                           "data": c.payload}, separators=(",", ":")).encode()
        result = await self._send(c, body)
        return await self._record(c, result)

    def _active_secrets(self, c: Claimed) -> list[str]:
        secrets = [c.secret]
        if c.previous_secret and c.previous_secret_expires_at and c.previous_secret_expires_at > datetime.now(timezone.utc):
            secrets.append(c.previous_secret)
        return secrets

    async def _send(self, c: Claimed, body: bytes) -> SendResult:
        started = time.perf_counter()
        msg_id = c.event_id
        try:
            pinned_ip = await assert_public_destination(c.url, allow_private=self.cfg.allow_private_destinations)
        except BlockedDestination as exc:
            return SendResult("blocked", error=str(exc))
        ts = int(time.time())
        headers = {"content-type": "application/json", "webhook-id": msg_id, "webhook-timestamp": str(ts),
                   "webhook-signature": signature_header(self._active_secrets(c), msg_id, ts, body)}
        req = self.client.build_request("POST", c.url, content=body, headers=headers)
        if pinned_ip:
            # Connect to the IP we validated, not to whatever DNS answers next (DNS rebinding TOCTOU).
            # Host header and TLS SNI/cert verification still use the original hostname.
            host = req.url.host
            req.headers["host"] = req.url.netloc.decode()
            req.url = req.url.copy_with(host=pinned_ip)
            req.extensions["sni_hostname"] = host
        try:
            resp = await self.client.send(req, stream=True)
            try:
                snippet_bytes = b""
                async for chunk in resp.aiter_bytes():   # never read more than we keep (works for pre-read bodies too)
                    snippet_bytes += chunk
                    if len(snippet_bytes) >= self.cfg.max_response_snippet:
                        break
            finally:
                await resp.aclose()
        except httpx.TimeoutException as exc:
            return SendResult("timeout", error=f"{type(exc).__name__}: timed out",
                              duration_ms=int((time.perf_counter() - started) * 1000))
        except httpx.HTTPError as exc:
            return SendResult("connect_error", error=f"{type(exc).__name__}: {exc}"[:500],
                              duration_ms=int((time.perf_counter() - started) * 1000))
        dur = int((time.perf_counter() - started) * 1000)
        snippet = snippet_bytes[: self.cfg.max_response_snippet].decode("utf-8", "replace")
        if 200 <= resp.status_code < 300:
            return SendResult("success", resp.status_code, snippet=snippet, duration_ms=dur)
        return SendResult("http_error", resp.status_code, error=f"HTTP {resp.status_code}", snippet=snippet,
                          retry_after_s=_retry_after(resp), duration_ms=dur)

    def _next_delay(self, attempt: int, result: SendResult) -> float | None:
        """None = no more attempts."""
        schedule = self.cfg.retry_schedule_seconds
        if attempt > len(schedule):
            return None
        delay = schedule[attempt - 1] * random.uniform(0.8, 1.2)   # +-20% jitter
        if result.retry_after_s is not None and result.status_code in (429, 503):
            delay = max(delay, result.retry_after_s)                  # receiver asked us to back off
        return delay

    async def _record(self, c: Claimed, r: SendResult) -> str:
        now = datetime.now(timezone.utc)
        success = r.outcome == "success"
        gone = r.status_code == 410
        next_at = None
        if success:
            status, final = "succeeded", "succeeded"
        else:
            delay = None if (gone or r.outcome == "blocked") else self._next_delay(c.attempt, r)
            if delay is None:
                status, final = "dead", "dead"
            else:
                status, final = "pending", "retry"
                next_at = now + timedelta(seconds=delay)
        params = {"id": c.id, "attempt": c.attempt, "status": status, "next_at": next_at,
                  "delivered_at": now if success else None, "code": r.status_code, "err": r.error,
                  "dur": r.duration_ms, "outcome": r.outcome, "snippet": r.snippet, "success": success,
                  "gone": gone, "threshold": self.cfg.auto_disable_after_failures, "endpoint_id": c.endpoint_id}
        async with self.sm() as s, s.begin():
            updated = await s.scalar(RECORD_SQL, params)
        if not updated:
            # Fencing: our lease expired and a newer attempt owns this delivery now.
            self.stats["stale"] += 1
            log.warning("stale_delivery_result", extra={"delivery_id": c.id, "attempt": c.attempt})
            return "stale"
        self.stats["sent"] += 1
        self.stats["succeeded" if final == "succeeded" else "dead" if final == "dead" else "failed"] += 1
        log.info("delivery_attempt", extra={"delivery_id": c.id, "endpoint": c.endpoint_id, "attempt": c.attempt,
                                            "outcome": r.outcome, "status_code": r.status_code, "result": final})
        return final

    async def _reschedule_without_attempt(self, c: Claimed, wait_ms: int) -> str:
        """Rate limited by OUR per-endpoint budget: not the endpoint's fault, so give the attempt back."""
        self.stats["rate_limited"] += 1
        async with self.sm() as s, s.begin():
            await s.execute(update(Delivery).where(Delivery.id == c.id, Delivery.attempts == c.attempt)
                            .values(status="pending", attempts=Delivery.attempts - 1, locked_until=None,
                                    locked_by=None,
                                    next_attempt_at=datetime.now(timezone.utc) + timedelta(milliseconds=wait_ms)))
        return "rate_limited"
