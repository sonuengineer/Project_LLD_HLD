# API -- Multi-Tenant SaaS

OpenAPI: `/docs`. Auth header: `Authorization: Bearer <access JWT | sk_... API key>`.
Errors: `{"error": {"code", "message", "details", "request_id"}}`.

## Auth and user

| Method | Path | Notes |
|---|---|---|
| POST | `/auth/register` | `{email, password (10-72 chars), full_name?}` |
| POST | `/auth/login` | -> `{access_token, refresh_token, expires_in}` |
| POST | `/auth/refresh` | `{refresh_token}` -> new pair; reuse of an old token revokes the family |
| POST | `/auth/logout` | revoke the refresh family |
| GET | `/me` | user + tenants with roles |
| POST | `/tenants` | `{slug, name}` -> caller becomes owner, plan free |
| POST | `/invitations/accept` | `{token}`; email must match |

## Tenant scoped: `/t/{slug}`

| Method | Path | Permission / feature |
|---|---|---|
| GET | `` | any member: plan, role, permissions, limits |
| GET | `/members` | member:read |
| POST | `/invitations` | member:invite; role below yours; member limit |
| PATCH | `/members/{user_id}` | member:manage; no escalation; last owner protected |
| DELETE | `/members/{user_id}` | member:manage (or yourself) |
| GET/POST | `/projects` | project:read / project:write + max_projects |
| GET/DELETE | `/projects/{id}` | project:read / admin or creator (ABAC) |
| GET/POST/DELETE | `/api-keys` | apikey:manage; scopes subset of yours |
| GET | `/audit-logs` | audit:read |
| GET | `/audit-logs/export` | audit:read + feature `audit_export` (CSV) |
| GET | `/usage` | current month API calls vs quota |
| POST | `/reports`, GET `/reports/{id}` | report:run + feature `reports`; async job |
| POST | `/billing/checkout` | billing:manage |

## Billing and admin

| Method | Path | Notes |
|---|---|---|
| POST | `/billing/webhook` | provider callback, header `x-billing-signature: t=...,v1=...`; idempotent |
| POST | `/billing/mock/checkout/{session}/complete` | demo: simulate payment |
| GET | `/admin/tenants` | platform admin |
| POST | `/admin/tenants/{id}/status` | `{status: active|suspended, reason}` (audited in the tenant) |
| GET | `/admin/tenants/{id}/usage` | flushes Redis counters, returns usage |

## Error codes

`unauthorized` 401, `forbidden` 403, `plan_limit_reached` 403, `feature_not_in_plan` 403, `not_found` 404
(also for tenants you're not a member of), `conflict` 409, `rate_limited` 429, `quota_exceeded` 429.
