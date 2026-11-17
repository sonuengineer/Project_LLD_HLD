"""Common FastAPI wiring: request ids, access logs, Prometheus metrics, health."""
from __future__ import annotations

import logging
import time
import uuid

from fastapi import FastAPI, Request, Response
from prometheus_client import CONTENT_TYPE_LATEST, Counter, Histogram, generate_latest

from .errors import install_error_handlers
from .logging import request_id_var

log = logging.getLogger("bpcommon.http")

HTTP_REQUESTS = Counter("http_requests_total", "HTTP requests", ["service", "method", "route", "status"])
HTTP_LATENCY = Histogram("http_request_duration_seconds", "HTTP latency", ["service", "method", "route"])


def _route_template(request: Request) -> str:
    # Use the route template (/jobs/{id}) not the raw path, otherwise every id
    # becomes a new Prometheus label value (cardinality explosion).
    route = request.scope.get("route")
    return getattr(route, "path", "unmatched")


def setup_app(app: FastAPI, service: str) -> FastAPI:
    install_error_handlers(app)

    @app.middleware("http")
    async def _observe(request: Request, call_next):
        rid = request.headers.get("x-request-id") or uuid.uuid4().hex
        token = request_id_var.set(rid)
        start = time.perf_counter()
        status = 500
        try:
            response: Response = await call_next(request)
            status = response.status_code
            response.headers["x-request-id"] = rid
            return response
        finally:
            elapsed = time.perf_counter() - start
            route = _route_template(request)
            HTTP_REQUESTS.labels(service, request.method, route, str(status)).inc()
            HTTP_LATENCY.labels(service, request.method, route).observe(elapsed)
            log.info("http_request", extra={"method": request.method, "path": request.url.path,
                                            "status": status, "duration_ms": round(elapsed * 1000, 2)})
            request_id_var.reset(token)

    @app.get("/metrics", include_in_schema=False)
    async def _metrics() -> Response:
        return Response(generate_latest(), media_type=CONTENT_TYPE_LATEST)

    @app.get("/healthz", tags=["ops"])
    async def _health() -> dict:
        return {"status": "ok", "service": service}

    return app
