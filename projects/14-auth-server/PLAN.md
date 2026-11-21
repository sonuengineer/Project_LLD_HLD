# H14 -- plan for later stages

Everything in this file is NOT DONE. Stage 1 (see README.md) is the only finished stage. Each item says why it
matters and how it would be proven, so a later stage keeps the same rule: no claim without a test or a measurement.

## Stage 2 -- make it survive a restart and more than one process

- **Persistent storage** (PostgreSQL) behind the existing `TransactionStore` / `CodeStore` / `TokenStore`
  interfaces. Code redemption and refresh rotation must stay atomic:
  `UPDATE codes SET used = true WHERE hash = $1 AND used = false` and check the row count.
  Proof: run the existing test suite against both stores; a concurrency test that fires two redemptions of one code
  at once and expects exactly one 200.
- **Expiry sweep** for codes, transactions, refresh tokens and the access-token `jti` records.
- **Signing key from disk is already possible (`SIGNING_KEY_FILE`); add key rotation with overlap**: publish the next
  key in `/jwks` before it signs, sign with it, keep the old key published until every token it signed has expired.
  Proof: a test where a token signed by the old key still verifies through `jose` after the switch, and stops after
  the overlap window.

## Stage 3 -- more of the protocol

- **Consent screen**: show requested scopes, remember the user's decision per client; `prompt=consent`.
- **Login sessions and logout**: an SSO session cookie, `prompt=none` / `prompt=login`, `max_age` + `auth_time`,
  RP-initiated logout, maybe back-channel logout.
- **Client credentials grant** for service-to-service calls (no user, no refresh token).
- **Token introspection (RFC 7662)** so other resource servers can see revocation.
- **Revocation of access tokens** at `/revoke` (deny-list by `jti` until `exp`).

## Stage 4 -- stronger security

- **Sender-constrained tokens**: DPoP (RFC 9449) or mTLS-bound tokens (RFC 8705), so a stolen access or refresh token
  is useless without the client's key.
- **Login rate limiting** per username and per IP (could reuse the P01 rate limiter design), plus account lockout
  policy and logging of failed logins.
- **`private_key_jwt` client authentication**, PAR (RFC 9126).
- Security headers review, and a test that the login page cannot be framed in a real browser.

## Stage 5 -- measure it

- Cost of scrypt at N=2^17 per login on the target machine (latency and memory), and how many logins per second one
  process can take before the event loop queue grows (scrypt runs on the libuv thread pool, default 4 threads).
- Token endpoint throughput with ES256 signing; `/userinfo` with verification.
- Only numbers from saved raw results, with the machine and conditions written next to them.
