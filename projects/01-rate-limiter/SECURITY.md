# Security -- Distributed Rate Limiter

## Threats and mitigations

| Threat | Mitigation | Code |
|---|---|---|
| Brute force on login | `login_bruteforce`: exact sliding log, 5/min per IP, **fails closed** | `policies.json` |
| IP spoofing via `X-Forwarded-For` / `X-Real-IP` | Header trusted only when `RL_TRUST_FORWARDED_FOR=true`, which is set only for instances reachable solely through our Nginx (which overwrites `X-Real-IP` with `$remote_addr`) | `api/deps.py::client_ip` |
| Rotating IPs to evade limits | Per-user and per-API-key scopes are independent of IP | `domain/models.py::Scope` |
| Leaked Redis dump exposes API keys | Keys stored as SHA-256 hashes; raw key shown once at creation | `services/api_keys.py` |
| Admin token timing attack | `hmac.compare_digest` constant-time comparison | `api/deps.py::require_admin` |
| Flood of bogus API keys hammering Redis | Negative cache for unknown keys | `ApiKeyStore.lookup` |
| Unauthenticated policy changes | Admin router requires `X-Admin-Token` | `api/routes.py` |
| Malformed policy disabling limits | Pydantic validation (`limit > 0`, algorithm-specific params required) | `domain/models.py::Policy` |
| Stack traces leaking internals | Global handler returns generic 500 with request id; trace only in logs | `shared/bpcommon/errors.py` |
| Redis exposed to network | Compose binds Redis to the internal network / 127.0.0.1 only | `docker-compose.yml`, `infra/docker-compose.yml` |

## Secrets

- `RL_ADMIN_TOKEN` must be set via environment; the default `change-me-admin-token` is for local use only.
- No secrets are committed; `.env.example` contains placeholders.

## Not covered (documented gaps)

- Admin auth is a shared token, not per-operator identity with audit logs (Project 6 shows RBAC + audit logs).
- No Redis AUTH/TLS configured in the demo compose; production Redis must use `requirepass`/ACLs and TLS.
- IPv6 clients could be limited per /64 prefix instead of per address; currently per address.
