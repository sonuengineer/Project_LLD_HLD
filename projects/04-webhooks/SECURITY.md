# Security -- Webhook Delivery

## Threats to the SENDER (us)

| Threat | Mitigation | Code |
|---|---|---|
| SSRF: endpoint URL pointing at metadata service / internal hosts | DNS resolved at send time; loopback, private, link-local, reserved, multicast, IPv4-mapped IPv6 all rejected; http only in dev; no redirects; no credentials in URL | `services/ssrf.py`, `follow_redirects=False` |
| DNS rebinding | check after resolution, at every send, and CONNECT TO THE CHECKED IP (Host/SNI keep the name) so a second DNS answer can't be used | `assert_public_destination`, `Dispatcher._send` |
| Slow-loris endpoints tying up dispatchers | 3s connect / 10s total timeout; concurrency semaphore | `Dispatcher.__init__` |
| Huge responses | only first 1KB stored | `max_response_snippet` |
| Unauthorized publish / config | bearer token, constant-time compare | `api/routes.py::require_token` |
| Secret disclosure | secret returned only on create / explicit `/secret`; never in list views | `endpoint_view` |

## Threats to the RECEIVER (our customers), and what we give them

| Threat | Mitigation |
|---|---|
| Forged webhooks | HMAC-SHA256 with a per-endpoint 256-bit secret |
| Replay of a captured request | timestamp is inside the MAC; receiver tolerance 5 min |
| Timing attack on signature compare | `hmac.compare_digest` in the reference verifier |
| Re-serialisation breaking signatures | verify the RAW body before parsing JSON |
| Duplicate processing | stable `webhook-id` for dedupe |
| Leaked secret | rotation with grace period |

## Gaps (documented)

- Secrets stored in plaintext in Postgres (encrypt with KMS / envelope encryption in production).
- Single admin token instead of per-account API keys with scopes.
- No mTLS / static egress IPs (customers often allow-list sender IPs; needs a NAT gateway).
