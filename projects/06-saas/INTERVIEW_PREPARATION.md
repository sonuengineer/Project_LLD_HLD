# Interview Preparation -- Multi-Tenant SaaS

Question bank: `interview/data/p06-saas/` (validated), browsable in the portfolio website.

## Stories

1. **RLS as a backstop** -- forgotten WHERE still safe; superuser bypass; SET LOCAL and pools.
2. **The escalation bug** -- an OR in a policy + a user-only lookup = owner access to another tenant; caught by a test, fixed at the policy level.
3. **Authorization design** -- RBAC + ABAC rule, escalation guards, API keys bounded by creator's current role.
4. **Plans** -- entitlements, race-safe limits with a row lock, rate limit vs quota, idempotent billing webhooks.
5. **Tenant-awareness beyond SQL** -- cache keys, background jobs, admin actions audited inside the tenant.
