# Security -- Multi-Tenant SaaS

## Threat model highlights

| Threat | Mitigation |
|---|---|
| Tenant data leakage (missing filter) | RLS + non-owner app role; tenant-first explicit filters on sensitive lookups |
| Leakage via cache | tenant id in every cache key |
| Leakage via background jobs | jobs carry tenant id; worker sets RLS context |
| Tenant enumeration | credentials checked BEFORE tenant lookup (anonymous -> always 401); non-members get 404 (same as non-existent); foreign API keys get 404 |
| Privilege escalation | role grants only below your own; owner-only owner changes; last-owner guard; API key scopes subset of creator permissions and capped by creator's CURRENT role |
| Password attacks | bcrypt (cost 12), 10-72 char passwords, equal-time login for unknown emails; rate limit login at the edge (Project 1) |
| Token theft | 15-min access tokens; single-use refresh tokens with reuse detection; tokens stored hashed |
| API key leak | hashed at rest, shown once, revocable, scoped |
| Audit tampering | DB-level append-only grants; audit row in the same transaction as the action |
| Billing fraud (fake webhooks) | HMAC + timestamp tolerance; idempotent processing; plan values validated |
| SQL injection | bound parameters everywhere; `set_config` with parameters instead of string-built `SET` |
| Platform admin abuse | admin granted only by an operator command (never by self-registration); admin actions written into the tenant's audit log |

## RBAC matrix

| Permission | viewer | member | admin | owner |
|---|---|---|---|---|
| project:read, member:read | x | x | x | x |
| project:write, report:run | | x | x | x |
| project:delete, member:invite, member:manage, apikey:manage, audit:read | | | x | x |
| billing:manage, tenant:manage | | | | x |

ABAC: `project delete` also allowed for the project's creator (`core/rbac.py::can_delete_project`).

## Gaps (documented)

No MFA/SSO, no email verification, no password reset flow, no per-IP login throttling in this service,
access tokens not revocable before expiry, secrets via env (use a secret manager in production).
