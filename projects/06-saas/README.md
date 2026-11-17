# Project 6 -- Multi-Tenant SaaS Backend

Production-style SaaS foundation: users, organisations (tenants), memberships and invitations,
RBAC (+ one ABAC rule), subscription plans with entitlements, per-tenant rate limits and usage quotas,
API keys, an append-only audit log, a billing provider abstraction with signed idempotent webhooks,
platform admin, tenant-aware caching and background jobs -- with **Postgres row-level security** as
the isolation backstop.

## What is implemented (verified by tests)

| Feature | Where | Test |
|---|---|---|
| Registration, login (bcrypt, timing-safe), JWT access tokens | `services/auth.py`, `core/security.py` | `test_auth_flow_and_refresh_rotation_with_reuse_detection`, `test_registration_validation` |
| Refresh-token rotation + reuse detection (family revocation) | `AuthService.refresh` | same |
| Tenants, membership, invitations | `services/tenancy.py` | `test_rbac_and_abac`, helpers |
| Tenant isolation: RLS (shared DB, tenant_id), FORCE RLS, non-owner app role | `migrations/versions/0001_initial.py`, `0003_*` | `tests/test_rls.py` (9), `test_tenant_isolation_over_http` |
| RBAC roles -> permissions; ABAC "creator may delete" | `core/rbac.py` | `test_rbac_and_abac` |
| No privilege escalation, last-owner protection | `tenancy.change_role`, `remove_member` | `test_no_privilege_escalation_and_last_owner_protection` |
| Subscription plans, entitlements (limits, features) | `core/plans.py`, `create_project`, `require_feature` | `test_plan_entitlements_and_upgrade_via_billing_webhook` |
| Race-safe limit enforcement (row lock) | `create_project` (`FOR UPDATE`) | `test_concurrent_creates_cannot_exceed_plan_limit` |
| Usage metering + monthly quota | `services/limits.py` | `test_tenant_rate_limit_and_quota` |
| Tenant-specific rate limits (plan-based token bucket) | `TenantLimits.check_rate` | same |
| API keys: hashed, scoped, bounded by creator's current role | `create_api_key`, `api/deps.py` | `test_api_keys_scoped_and_bounded_by_creator` |
| Audit logs: same transaction as the action, append-only at DB level | `services/audit.py`, grants | `test_audit_log_records_actions_with_actor`, `test_audit_log_is_append_only_for_the_app` |
| Billing abstraction + mock provider, signed webhooks, idempotent | `services/billing.py` | `test_plan_entitlements_and_upgrade_via_billing_webhook` |
| Platform admin: list, suspend/activate (audited), usage | `api/routes.py` (`/admin`) | `test_platform_admin_suspension` |
| Tenant-aware caching (tenant-namespaced keys + invalidation) | `services/cache.py` | `test_tenant_aware_cache_never_crosses_tenants` |
| Tenant-aware background jobs (RLS context in the worker) | `services/jobs.py`, `worker.py` | `test_tenant_aware_background_job` |

31 tests passing. RLS performance measurements in [TESTING.md](TESTING.md).

## Run

```bash
docker compose -f ../../infra/docker-compose.yml up -d
../../.venv/Scripts/alembic upgrade head                 # as owner; creates role saas_app + RLS
../../.venv/Scripts/uvicorn saas.main:app --port 8006    # connects as saas_app
../../.venv/Scripts/python -m saas.worker
../../.venv/Scripts/python seed.py http://127.0.0.1:8006
../../.venv/Scripts/python -m saas.cli promote admin@platform.local   # grant platform admin (operator action)
../../.venv/Scripts/python -m pytest -q
```

Docker: `docker compose up -d --build` (API 127.0.0.1:58006) then `python seed.py http://127.0.0.1:58006`.

## Docs

[ARCHITECTURE](ARCHITECTURE.md) . [SYSTEM_DESIGN](SYSTEM_DESIGN.md) . [DATABASE_DESIGN](DATABASE_DESIGN.md) .
[API_DOCUMENTATION](API_DOCUMENTATION.md) . [TRADEOFFS](TRADEOFFS.md) . [FAILURE_SCENARIOS](FAILURE_SCENARIOS.md) .
[SECURITY](SECURITY.md) . [TESTING](TESTING.md) . [DEPLOYMENT](DEPLOYMENT.md) . [LEARNING_GUIDE](LEARNING_GUIDE.md) .
[INTERVIEW_PREPARATION](INTERVIEW_PREPARATION.md)

## Known limitations

- Emails (invitations) are not sent; the invitation token is returned to the inviter.
- Billing provider is a mock (no real Stripe/Razorpay); no proration/dunning; downgrades don't delete over-limit data.
- Access tokens can't be revoked before expiry (15 min); no SSO/MFA.
- API key `last_used_at` is not updated (avoids a write per request).
- Usage is flushed from Redis to Postgres periodically; a Redis loss loses unflushed counts.
