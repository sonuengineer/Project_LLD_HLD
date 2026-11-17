# API Documentation -- Distributed Rate Limiter

Interactive OpenAPI docs: `GET /docs` (Swagger UI) and `GET /openapi.json`.

## Authentication

- Demo API: optional `X-API-Key: rlk_...`. Without it the caller is `anonymous` and keyed by IP.
- Admin API: `X-Admin-Token: <RL_ADMIN_TOKEN>`.

## Response headers (every rate limited route)

| Header | Meaning |
|---|---|
| `RateLimit-Limit` / `X-RateLimit-Limit` | limit of the *binding* policy (the one closest to denying) |
| `RateLimit-Remaining` / `X-RateLimit-Remaining` | remaining units in that policy |
| `RateLimit-Reset` / `X-RateLimit-Reset` | seconds until the policy fully resets |
| `RateLimit-Policy` | `<policy>;alg=<algorithm>` |
| `Retry-After` | on 429/503 only; whole seconds, minimum 1 |
| `X-RateLimit-Status: degraded` | Redis was unavailable and the policy failed open |
| `x-request-id` | correlation id (echoed if sent) |

## Demo endpoints

| Method | Path | Route group (policies) |
|---|---|---|
| GET | `/api/resource` | default: ip_global, user_plan |
| GET | `/api/search?q=` | search: ip_global, user_plan, search_burst |
| POST | `/api/login` | login: login_bruteforce (fails closed) |
| POST | `/api/reports` | reports: ip_global, reports_smooth |

## Admin endpoints

| Method | Path | Body / notes |
|---|---|---|
| POST | `/admin/api-keys` | `{"user_id": "alice", "plan": "pro"}` -> returns raw key once |
| GET | `/admin/policies` | route groups + effective policies |
| PUT | `/admin/policies/{name}` | full Policy JSON; validated; stored in Redis |
| DELETE | `/admin/policies/{name}/override` | revert to policies.json default |
| GET | `/admin/stats` | this instance's allowed/denied/degraded counters |

## Ops endpoints

`GET /healthz`, `GET /metrics` (Prometheus), `GET /dashboard` (HTML).

## Errors

All errors share one shape:

```json
{"error": {"code": "rate_limited", "message": "Rate limit exceeded for policy 'user_plan'",
           "details": {"policy": "user_plan", "algorithm": "fixed_window", "retry_after_ms": 41000},
           "request_id": "9c1f..."}}
```

Codes: `rate_limited` (429), `service_unavailable` (503), `unauthorized` (401), `forbidden` (403),
`validation_error` / `unprocessable` (422), `not_found` (404), `internal_error` (500).

## Example

```bash
curl -i -H "X-API-Key: $KEY" http://127.0.0.1:8001/api/search?q=redis
# HTTP/1.1 200 OK
# ratelimit-limit: 30
# ratelimit-remaining: 29
# ratelimit-policy: search_burst;alg=token_bucket
```
