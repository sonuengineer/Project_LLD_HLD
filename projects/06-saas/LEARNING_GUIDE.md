# Learning Guide (Hinglish) -- Multi-Tenant SaaS

## Step 1: Multi-tenancy kya hai

Ek hi application, bahut saari companies (tenants). Acme ka data Globex ko kabhi nahi dikhna chahiye.
Teen tarike: har tenant ka alag database, alag schema, ya sab ek table mein `tenant_id` column ke saath.
Yahan teesra (sasta, sabse common) + Postgres Row-Level Security.

## Step 2: RLS -- database khud filter lagata hai

`migrations/versions/0001_initial.py`. Policy: `tenant_id = current_setting('app.tenant_id')`.
Har request apne transaction ke shuru mein `SET LOCAL app.tenant_id` karti hai (`db/session.py`).
Ab agar developer `WHERE tenant_id = ...` bhool bhi jaye, Postgres sirf current tenant ki rows dega:
```bash
../../.venv/Scripts/python -m pytest -q tests/test_rls.py
```
Teen gotchas jo interview mein poochte hain:
1. Superuser aur table owner RLS bypass karte hain -> app alag role `saas_app` se connect karta hai
   (`test_superuser_would_bypass_rls`).
2. `SET` nahi, `SET LOCAL` -- warna pooled connection pe pichhle tenant ka context agli request ko mil
   sakta hai (`test_context_does_not_leak_between_transactions`).
3. Context set na ho toh zero rows (fail closed), sab rows nahi.

## Step 3: Real bug jo test ne pakda (best interview story)

Memberships policy mein `OR user_id = app.user_id` tha (taaki user apne saare workspaces dekh sake).
Role lookup `WHERE user_id = :me` tha -- tenant filter nahi. Bob (sirf Globex ka owner) ne Acme ka URL
khola: query ne Bob ka Globex wala "owner" role return kar diya -> Bob Acme ka owner ban gaya!
Fix: policy strict (sirf tenant_id), "mere workspaces" ke liye alag SECURITY DEFINER function, aur
sensitive queries mein explicit tenant filter bhi. Lesson: policy mein OR = invariant toot gaya.

## Step 4: RBAC vs ABAC

`core/rbac.py`. RBAC: role -> permissions (viewer, member, admin, owner). ABAC: attributes pe rule --
"member apna banaya hua project delete kar sakta hai, doosre ka nahi" (`test_rbac_and_abac`).
Escalation guard: admin kisi ko admin nahi bana sakta, khud ko owner nahi bana sakta, aakhri owner ko
hata/demote nahi kar sakte.

## Step 5: Plans, entitlements, metering

`core/plans.py`. Free: 3 projects, reports feature nahi. Limit check race-safe kyun? 10 parallel
requests ek saath "count < 3?" check karein toh sab pass ho sakti hain. Tenant row pe `FOR UPDATE`
lock -> checks ek-ek karke -> exactly 3 (`test_concurrent_creates_cannot_exceed_plan_limit`).
Rate limit (per second) aur quota (per month) alag cheezein hain: 429 `rate_limited` vs 429 `quota_exceeded`.

## Step 6: Auth -- refresh token rotation

Access token 15 min ka JWT. Refresh token har use pe naya; purana dobara aaya = chori -> poori family
revoke (`test_auth_flow_and_refresh_rotation_with_reuse_detection`). Login mein unknown email pe bhi
bcrypt chalate hain taaki response time se valid emails pata na chalein.

## Step 7: API keys

Hashed store, ek baar dikhai jati hai, scopes. Key ki power = scopes AND creator ka CURRENT role --
creator ko hataya toh key bhi bekaar. Key se user-only routes nahi chalte.

## Step 8: Billing abstraction + idempotent webhooks

`services/billing.py`. App sirf `BillingProvider` interface jaanta hai; mock provider signed webhooks
bhejta hai. Provider same event do baar bhej sakta hai -> `billing_events.id` primary key -> ek hi
baar apply.

## Step 9: Tenant-aware cache aur jobs

Cache key mein tenant id (`saas:cache:{tenant}:projects:list`), warna ek tenant ki list doosre ko.
Jobs mein tenant id, worker `tenant_tx` mein chalata hai -> job ki query filter bhoole tab bhi safe.

## Self-check

1. Shared DB vs schema-per-tenant vs DB-per-tenant -- kab kaunsa?
2. RLS superuser pe kyun kaam nahi karta? FORCE RLS kya karta hai?
3. SET vs SET LOCAL connection pool ke saath?
4. Memberships escalation bug step by step samjhao.
5. RBAC vs ABAC example ke saath?
6. Plan limit race condition aur fix?
7. Refresh token reuse detection kaise kaam karta hai?
8. Tenant data cache se kaise leak ho sakta hai?
