# Database Design -- Multi-Tenant SaaS

```mermaid
erDiagram
  USERS ||--o{ MEMBERSHIPS : has
  TENANTS ||--o{ MEMBERSHIPS : has
  TENANTS ||--o{ INVITATIONS : sends
  TENANTS ||--o{ PROJECTS : owns
  TENANTS ||--o{ API_KEYS : issues
  TENANTS ||--o{ AUDIT_LOGS : records
  TENANTS ||--o{ USAGE_COUNTERS : meters
  TENANTS ||--|| SUBSCRIPTIONS : has
  TENANTS ||--o{ REPORTS : runs
  USERS ||--o{ REFRESH_TOKENS : holds
  TENANTS { uuid id PK text slug UK text plan text status }
  USERS { uuid id PK text email "unique lower()" text password_hash bool is_platform_admin }
  MEMBERSHIPS { uuid tenant_id PK uuid user_id PK text role }
  PROJECTS { uuid id PK uuid tenant_id FK text name uuid created_by }
  API_KEYS { uuid id PK uuid tenant_id FK text key_hash UK text_array scopes timestamptz revoked_at }
  AUDIT_LOGS { bigint id PK uuid tenant_id FK text action jsonb metadata }
  USAGE_COUNTERS { uuid tenant_id PK text metric PK text period PK bigint value }
  REFRESH_TOKENS { uuid id PK uuid family_id text token_hash UK timestamptz revoked_at }
  BILLING_EVENTS { text id PK text type jsonb payload }
```

## Row-level security

- `ENABLE` + `FORCE ROW LEVEL SECURITY` on every tenant table (FORCE = applies to the owner too).
- Policy: `tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid` for USING and WITH CHECK.
- Unset context -> NULL -> no rows: fail closed.
- `SET LOCAL` (via `set_config(..., true)`) -> scoped to the transaction -> safe with connection pools.
- App role `saas_app`: `NOSUPERUSER NOBYPASSRLS`, not the table owner. Superusers bypass RLS (test proves it).
- Cross-tenant needs (API key lookup, invitation acceptance, "my workspaces") go through narrow
  `SECURITY DEFINER` functions that take an exact key/hash/user id and return only the needed columns.
- Policies contain no `OR` escape hatches (migration 0003 removed one that caused privilege escalation).

## Grants

App role: SELECT/INSERT/UPDATE/DELETE on data tables; **SELECT/INSERT only on audit_logs** (append-only).

## Indexes

| Index | Purpose |
|---|---|
| `uq_users_email_lower` | case-insensitive unique email |
| `ix_projects_tenant_created (tenant_id, created_at DESC)` | the list query: index scan + LIMIT, no sort (0.148ms vs 2.94ms without, TESTING.md) |
| `ix_audit_tenant_created`, `ix_reports_tenant`, `ix_api_keys_tenant` | tenant-first composite indexes |
| `projects UNIQUE (tenant_id, name)` | names unique per tenant, not globally |
| `ix_memberships_user` | "my workspaces" |
| `api_keys.key_hash UNIQUE`, `refresh_tokens.token_hash UNIQUE` | O(log n) token lookup |

Rule: in a pooled multi-tenant schema, nearly every index should start with `tenant_id`.

Migrations: `0001_initial` (schema, role, RLS, grants, resolve_api_key), `0002_invitation_lookup`,
`0003_strict_memberships_policy`.
