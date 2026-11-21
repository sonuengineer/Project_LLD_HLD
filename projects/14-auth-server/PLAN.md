# H14 -- plan for later stages

Status on 2026-11-21: stage 1 and stage 2 are done (see README.md). Everything below the "Stage 2" section is
NOT DONE. Each item says why it matters and how it would be proven, so a later stage keeps the same rule: no claim
without a test or a measurement.

## Stage 2 -- DONE 2026-11-21 (what was planned vs what was built)

- **Persistent storage**: planned as PostgreSQL; built as a file-backed store with node:fs only (append-only
  JSON-lines log, write-ahead + fsync, replay, compaction via temp file + rename; `src/file-store.ts`), because
  the project has zero runtime dependencies. Restart proven by `test/persistence.test.ts`. STILL OPEN from the
  original item: a database store and the concurrency test that fires two redemptions of one code at once
  across processes; the file store is ONE process per data directory.
- **Expiry sweep**: done at start only (compaction drops expired codes, refresh tokens, access-token records,
  sessions and unreferenced families). STILL OPEN: a sweep while the process runs; the in-memory store never
  sweeps.
- **Key rotation with overlap**: done (`src/keys.ts` FileKeyRing): next key pre-published, active key signs,
  retired key published for the longest token lifetime, automatic rotation by age, keys generated into the data
  dir with mode 0600. Proven by `test/keys.test.ts` and the jose test in `test/interop.test.ts`. STILL OPEN:
  emergency removal of a compromised key, keys encrypted at rest / KMS, one key ring shared by several processes.
- **Moved forward from stage 3**: login session cookie + RP-initiated logout (`/logout`), and id_token on refresh.

## Stage 2 leftovers (next)

- PostgreSQL (or SQLite) store behind the same interfaces + cross-process concurrency test.
- A data-dir lock so a second process cannot open the same store.
- One commit (one fsync) per request instead of one per record; runtime compaction by log size.
- Per-line checksum in the log so a valid-JSON-but-wrong line is detected.
- DONE 2026-11-21: the keys.json mode test (skipped on Windows) was run on Linux (portfolio-a2): passes, and M29 turns it red. A CI job on Linux would keep it covered.

## Stage 3 -- more of the protocol

- **Consent screen**: show requested scopes, remember the user's decision per client; `prompt=consent`.
- **Login sessions (SSO)**: stage 2 has a session cookie and RP-initiated logout but does NOT use the session
  for silent login. Still to do: `prompt=none` / `prompt=login`, `max_age` + `auth_time` checks, a logout
  confirmation page (so `id_token_hint` can be optional), front-channel / back-channel logout.
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
