# Implementation Status

Last updated: 2026-11-17 -- ALL PHASES COMPLETE

## Environment

- Windows 11, Python 3.14 dev venv at `.venv` (Docker images use python:3.12-slim), Node 20, Docker Desktop.
- Shared infra: `docker compose -f infra/docker-compose.yml up -d` -> Postgres 127.0.0.1:55432 (user bp / bp_dev_password, one DB per project, created by `infra/postgres-init/01-databases.sql`), Redis 127.0.0.1:56379.
- Ports are non-default on purpose (machine already runs other Postgres/Redis instances).
- Shared lib `shared/bpcommon` (installed editable in .venv): JSON non-blocking logging, structured errors, request ids, Prometheus `/metrics`, `/healthz`.
- Git Bash note: prefix docker commands that pass container paths with `MSYS_NO_PATHCONV=1`.

## Progress

| # | Project | Code | Tests (final run 2026-11-17) | Docs | Docker | Interview bank |
|---|---|---|---|---|---|---|
| 1 | Distributed Rate Limiter | done | 39 passed | 12/12 | 3 replicas + nginx, k6 load tested | 106 questions, validator OK |
| 2 | Redis-like DB (minidis) | done | 52 passed | 12/12 | master + replica, benchmarked vs Redis 7 | 110, OK (reconciled) |
| 3 | Distributed Job Queue | done | 30 passed (incl. real kill -9) | 12/12 | api + 3 workers + migrate | 114, OK (reconciled) |
| 4 | Webhook Delivery | done | 41 passed | 12/12 | api + 2 dispatchers + receiver | 112, OK (reconciled) |
| 5 | Mini Kafka (minikafka) | done | 40 passed | 12/12 | API + 3 in-process brokers | 112, OK (reconciled) |
| 6 | Multi-tenant SaaS | done | 31 passed | 12/12 | api + worker + migrate, 2 DB roles | 105, OK (reconciled) |
| 7 | Object Storage | done | 28 passed (2 vs real SeaweedFS S3) | 12/12 | api + worker + seaweedfs | 106, OK (reconciled) |
| 8 | Collaborative Editing | done | 34 passed (fuzz, 2 real servers) | 12/12 | 2 servers + nginx; demo re-run after fixes | 107, OK (reconciled) |
| 9 | Payment System | done | 25 passed | 12/12 | api + mock provider + worker; migrations 0001-0003 from scratch OK; demo re-run | 108, OK (reconciled) |
| 10 | Workflow Engine (flowengine) | done | 30 passed (stable x3) | 12/12 | api + 2 workers; all 5 example workflows re-run | 114, OK (reconciled) |
| - | Cross-project system design | - | - | - | - | 47, OK |
| - | Portfolio + interview website | done (`portfolio/`) | typecheck + build + browser-checked (desktop + 390px) | portfolio/README.md | static build | consumes `validate.py --bundle --with-sources` |

**Totals:** 350 tests passing across 10 projects (raw logs of the final run were kept outside the repo);
1,141 interview questions (1,094 project + 47 cross-project), all validated.

## Notes

- `greenlet` must be installed for SQLAlchemy asyncio (pinned 3.5.6).
- redis-py 8: default async pool RAISES when exhausted -> always use BlockingConnectionPool; default protocol is RESP3 (HELLO 3).
- On Windows use 127.0.0.1, not localhost, for local servers (IPv6 fallback costs ~2s per connect).

## Conventions (keep consistent across projects)

- Each project: `projects/NN-name/<unique_package>/` + `tests/` + 12 docs at project root + `Dockerfile` (context = repo root) + `docker-compose.yml` + `requirements.txt` (pinned) + `.env.example`.
- Unique package names so no import clashes: ratelimiter, minidis, jobqueue, webhooks, minikafka, saas, objstore, collab, payments, flowengine.
- Run tests per project: `cd projects/NN-x && ../../.venv/Scripts/python -m pytest -q`.
- Interview content: `interview/data/<slug>/` validated by `python interview/validate.py`; authoring brief in `interview/AUTHORING_BRIEF.md`.
- Dashboards for backend projects are single-file HTML served by the service (`/dashboard`); the portfolio site is the React app.

## Review-fix history (all with regression tests)

Every project got a code review (mostly while its interview bank was written); confirmed bugs were fixed with a
regression test and recorded in that project's TESTING.md / FAILURE_SCENARIOS.md ("Review fixes"). The interview
banks were then reconciled so they describe fixed items as fixed ("review mein mila -> fix -> test").
Last batch (2026-11-17): P8 tail loss, client_id hijack, live revocation, client resync, slow-client kick;
P9 crash-takeover double refund / new payment id, webhook redelivery after failed apply, saga cancelling a
possibly-charged order, compensation failure reported, per-currency ledger trigger, append-only audit trigger,
429 retryable, refund indexes; P10 KeyError vs NonDeterminismError, cancel of running activities, no history
after close, stale-commit lease clearing, retry jitter, retry-task operator API (constant-time admin token).

## Known gaps (documented per project, not fixed)

Each project's FAILURE_SCENARIOS.md / SECURITY.md lists its remaining known limitations (e.g. P8 presence cleanup
and UTF-16 vs code points in the demo editor; P9 reconciliation day-bucketing and non-idempotent /checkout;
P10 type-level-only determinism check). Benchmarks were all run on one Windows 11 machine with Docker Desktop;
they are relative evidence, not production capacity numbers.

## Not done (needs the owner)

- Public deployment: not done -- requires explicit permission (and a host).
- Git repository / GitHub URL: none exists; the site links to bundled copies of the files instead.
- Real payment sandbox (Stripe / Razorpay test mode): would need sandbox API keys; only the mock provider is used.
- Coding-exercise solutions in the interview banks: some were run by the authoring agents, others are marked as
  unrun sketches in the answer text.
