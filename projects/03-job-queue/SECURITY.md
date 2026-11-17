# Security -- Distributed Job Queue

| Threat | Mitigation | Code |
|---|---|---|
| Unauthenticated job submission (abuse, cost) | Bearer token, constant-time compare | `api/routes.py::require_token` |
| Malicious job types / arbitrary code execution | Only registered handler names run; payload is JSON data, never code (no pickle) | `handlers/__init__.py::Registry`, `queue.py` uses JSON |
| Oversized payloads filling Redis | Validation on type/queue names; add a request body size limit at the proxy (documented) | `core/models.py` |
| Payload secrets visible in dashboard / Redis | Don't put secrets in payloads; pass references (ids) and load secrets in the handler | guidance |
| Error messages leaking internals into job records | Errors truncated to 2000 chars; only exception type + message stored, no locals | `Worker._execute`, `queue.fail` |
| Poison messages as DoS | max_attempts, DLQ, PermanentError | `fail.lua` |
| Redis exposed | Compose keeps Redis/Postgres on the internal network; only API port published on 127.0.0.1 | `docker-compose.yml` |
| SQL injection in handlers | SQLAlchemy Core with bound parameters | `handlers/builtin.py` |
| Dashboard XSS via job data | All values HTML-escaped before rendering | `dashboard.html::esc` |

Gaps (documented): single shared API token (no per-producer identity or scopes), no TLS between
services in compose, no payload encryption at rest.
