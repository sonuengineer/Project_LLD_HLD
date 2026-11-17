# Deployment -- Multi-Tenant SaaS

```bash
docker compose up -d --build     # postgres (owner role), redis, migrate, api (saas_app), worker
python seed.py http://127.0.0.1:58006
```

## Two database identities

| Identity | Used by | Rights |
|---|---|---|
| owner (`SAAS_MIGRATION_DATABASE_URL`) | `alembic upgrade head` only | owns tables, creates role/policies/functions |
| `saas_app` (`SAAS_DATABASE_URL`) | API + worker | DML only, append-only audit, NOBYPASSRLS, not owner |

Never point the app at the owner/superuser URL: RLS would silently stop protecting anything.

## Production checklist

1. Secrets (`SAAS_JWT_SECRET` >= 32 random bytes, DB passwords, billing webhook secret) from a secret manager.
2. Run migrations as a separate step before rolling the API.
3. PgBouncer in **transaction** mode is compatible (SET LOCAL); session-mode features must not be relied on.
4. Worker: at least one replica (jobs + usage flush); jobs are tenant-scoped by design.
5. Put login/registration behind IP rate limiting at the edge.
6. Monitor: 401/403 spikes, `plan_limit_reached`/`quota_exceeded` rates per tenant (upsell signal), cache hit ratio.
7. Backups: per-tenant export means filtered dumps (pooled model) -- document RPO/RTO per tier.
