# Trade-offs -- Multi-Tenant SaaS

1. **Pooled tenancy + RLS vs schema/db per tenant.** One schema, one migration, cheap; isolation is
   logical (a Postgres bug or a SECURITY DEFINER mistake could leak). Silos give physical isolation and
   per-tenant restore at much higher operational cost.
2. **RLS as backstop vs app-only filtering.** RLS catches forgotten WHERE clauses (proven); costs a
   per-transaction set_config, care with SECURITY DEFINER functions, and debugging surprises ("why 0 rows?").
3. **SET LOCAL vs SET.** Transaction-scoped context is pool-safe (and PgBouncer transaction-mode safe);
   every tenant query must run inside a transaction.
4. **No OR in policies.** Cross-tenant reads go through explicit functions; slightly more code, but the
   invariant "unfiltered query is safe" holds (the OR version caused a real escalation bug here).
5. **Stateless JWT + rotating refresh tokens.** No DB hit per request for auth; logout/permission
   changes take up to 15 minutes to affect access tokens (membership/role is still checked per request,
   which narrows that window to tenant-level changes only).
6. **RBAC with a small ABAC rule.** Roles are easy to reason about and audit; attributes cover
   ownership-style rules without a full policy engine (OPA/Cedar would be the next step).
7. **Plans in code.** Reviewed, versioned, testable; per-tenant custom deals need an overrides table.
8. **Metering in Redis, flushed to Postgres.** Hot path is one INCR; Redis loss loses up to one flush
   interval of counts, and quota checks fail open if Redis is down.
9. **Rate limits fail open.** Paying customers keep working through a Redis blip; abuse protection is
   temporarily off (monitor it).
10. **Mock billing provider behind a protocol.** Fully testable offline; real-provider edge cases
    (proration, failed renewals, disputes) aren't exercised.
11. **Explicit cache invalidation + TTL.** Fresh after our own writes; changes made outside the app
    (manual SQL) appear after TTL.
