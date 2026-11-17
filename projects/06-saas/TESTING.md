# Testing -- Multi-Tenant SaaS

```bash
../../.venv/Scripts/alembic -x url=postgresql+asyncpg://bp:bp_dev_password@127.0.0.1:55432/p06_saas_test upgrade head
../../.venv/Scripts/python -m pytest -q          # 31 tests, ~14s (stable across repeated runs)
../../.venv/Scripts/python bench/rls_bench.py    # RLS + index measurements
```

Tests connect as the real app role `saas_app` (RLS applies); the owner role is used only to truncate.

| File | Count | Covers |
|---|---|---|
| `test_rls.py` | 9 | SQL-level isolation: unfiltered reads, no context, cross-tenant writes/updates/deletes, pool leakage, append-only audit, superuser bypass demonstration, SECURITY DEFINER key lookup, membership escalation regression |
| `test_api.py` | 13 | auth + refresh reuse detection, validation, HTTP isolation, cache isolation, RBAC/ABAC, escalation guards, plan limits + feature gates + billing upgrade + webhook idempotency + forgery, race-safe limits, API keys, audit, rate limit + quota, platform suspension + usage, tenant-aware job |

## Bugs found by tests (fixed)

1. **Cross-tenant privilege escalation** (the important one). The `memberships` policy allowed
   `OR user_id = app.user_id` (to list "my workspaces"). The role lookup `WHERE user_id = :u` then
   returned the caller's role from ANOTHER tenant, so a non-member got owner access to tenant A.
   Caught by `test_tenant_isolation_over_http` (expected 404, got 200). Fix: migration 0003 (strict
   policy + `user_tenants()` SECURITY DEFINER), explicit `tenant_id` filters on membership queries,
   regression test at the SQL level.
2. asyncpg infers one type per bind parameter: reusing `:t` as uuid and text failed. Separate params.
3. Migration with multiple statements per execute failed under asyncpg's extended protocol: split.

## Security review fixes (found while writing the interview bank; regression tests in `test_review_fixes.py`)

| Finding | Fix |
|---|---|
| Tenant enumeration: no/invalid token -> 401 for existing slugs, 404 for missing ones | authenticate before resolving the tenant |
| Timing-equal login wasn't: dummy bcrypt hash cost 4 vs real cost 12 | dummy hash uses the configured cost |
| Platform admin granted by email at registration (no email verification) | removed; operator command `python -m saas.cli promote <email>` |
| Last-owner check raced (two owners demote each other -> zero owners) | tenant row lock in change_role/remove_member |
| Member limit raced; acceptance didn't re-check limit or suspension | tenant row lock on invite; re-check at acceptance |
| API key with member:manage hit a KeyError (500); admins could demote other admins | session required; only roles below yours |
| Billing event applied in two transactions (crash -> half-applied, retry skipped as duplicate); out-of-order events | one transaction (savepoint for dedupe) + `provider_event_at` ordering guard (migration 0004) |
| App role could DELETE tenants, cascading away the append-only audit log | `REVOKE DELETE ON tenants` (migration 0004) |
| Tenant creation in two transactions (ownerless tenant, burnt slug) | one transaction |
| Concurrent duplicate registration -> 500 | 409 |
| Worker ran jobs for suspended tenants; /usage 500 when Redis down | status check; graceful null |

Not fixed (documented): jobs popped with BRPOP are lost if the worker crashes mid-job (use BLMOVE to a
processing list), refresh-token cleanup job, mock checkout endpoint is unauthenticated (demo only).

## Performance (real run, 2026-11-17)

`bench/rls_bench.py`: 100 tenants x 1,000 projects, query `ORDER BY created_at DESC LIMIT 20` as the app role.

| Setup | Server execution (EXPLAIN ANALYZE) | Plan | End-to-end p50 / p95 |
|---|---|---|---|
| RLS + index `(tenant_id, created_at DESC)` | **0.148 ms** | Index Scan, RLS predicate as Index Cond | 10.86 / 16.94 ms |
| RLS, without that index | 2.938 ms (~20x) | Bitmap scan on (tenant_id, name) + top-N sort | 11.75 / 15.81 ms |

Takeaways: RLS adds no special cost -- the policy becomes an ordinary index condition. The index
matters at the server (20x). End-to-end latency here is dominated by three round trips (BEGIN +
set_config, query, COMMIT) through Docker Desktop's port proxy on Windows, which hides the server-side
difference at this data size.
