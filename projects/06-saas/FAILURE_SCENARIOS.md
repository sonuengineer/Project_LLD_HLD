# Failure Scenarios -- Multi-Tenant SaaS

| # | Scenario | Behaviour | Test |
|---|---|---|---|
| 1 | Developer forgets `WHERE tenant_id` | RLS returns only the current tenant's rows | `test_unfiltered_query_sees_only_current_tenant` |
| 2 | Code path forgets to set tenant context | zero rows (fail closed) | `test_no_tenant_context_sees_nothing` |
| 3 | Attempt to write into another tenant | rejected by WITH CHECK | `test_cannot_write_into_another_tenant` |
| 4 | Pooled connection reused by another request | SET LOCAL ended with the previous transaction | `test_context_does_not_leak_between_transactions` |
| 5 | Permissive policy + user_id-only query (real bug found) | was privilege escalation; fixed by strict policy + SECURITY DEFINER | `test_unfiltered_membership_query_cannot_return_other_tenant_roles`, `test_tenant_isolation_over_http` |
| 6 | Compromised app tries to erase audit trail | `permission denied` on UPDATE/DELETE | `test_audit_log_is_append_only_for_the_app` |
| 7 | Stolen refresh token replayed | family revoked, both sessions logged out | `test_auth_flow_and_refresh_rotation_with_reuse_detection` |
| 8 | Concurrent creates race past the plan limit | tenant row lock serialises the check: exactly 3 of 10 succeed | `test_concurrent_creates_cannot_exceed_plan_limit` |
| 9 | Billing provider re-delivers a webhook | billing_events PK -> processed once | `test_plan_entitlements_and_upgrade_via_billing_webhook` |
| 10 | Forged/modified webhook | HMAC mismatch -> 401 | same |
| 11 | Member removed / role changed | cache invalidated; takes effect on next request | `test_no_privilege_escalation_and_last_owner_protection` |
| 12 | Creator of an API key is removed or demoted | key perms = scopes AND creator's current role -> shrink immediately | `api/deps.py` |
| 13 | Tenant suspended | every tenant route 403 (cache invalidated) | `test_platform_admin_suspension` |
| 14 | Background job query without tenant filter | RLS context set by worker keeps it inside the tenant | `test_tenant_aware_background_job` |
| 15 | Redis down | cache bypassed, rate limit/quota fail open, API keeps serving | `cache.py`, `limits.py` |
| 16 | Tenant exceeds monthly quota | 429 quota_exceeded until next period/upgrade | `test_tenant_rate_limit_and_quota` |
