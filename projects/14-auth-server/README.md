# H14 -- OAuth 2.0 / OpenID Connect Authorization Server (TypeScript, zero runtime dependencies)

A hand-written authorization server on Node's built-in `node:http` and `node:crypto` (plus `node:fs` for the
config file, the file-backed store and the key file). No express, no jose, no passport at runtime. Built in stages so every claim here is backed by code and
tests that exist today.

## Status

| Stage | What | Status |
|---|---|---|
| 1 | Authorization Code + PKCE (S256 only), login form with CSRF token, ES256 JWT access tokens, rotating refresh tokens with reuse detection, OIDC id_token / discovery / JWKS / userinfo, RFC 7009 revocation | DONE (125 tests, incl. 8 interop tests with `jose` and `openid-client`) |
| 2 | File-backed persistent store (append-only log, survives a restart), signing-key rotation with overlap (keys generated into the data dir), login session cookie + OIDC RP-initiated logout, id_token on refresh | DONE 2026-11-21 (177 tests, incl. 10 interop tests; 1 test skipped on Windows, see below) |
| 3+ | Consent, SSO (`prompt=none` with the session), client credentials, introspection, sender-constrained tokens, rate limiting, a database store ... | NOT STARTED (ideas in `PLAN.md`) |

No performance numbers are claimed. Nothing has been measured or deployed.

**Storage** sits behind four small interfaces (`TransactionStore`, `CodeStore`, `TokenStore`, `SessionStore` in
`src/store.ts`). Two implementations: in memory (`Map`s, lost on restart; the default and what most tests use) and
file-backed (`src/file-store.ts`, `DATA_DIR`), which survives a restart. Both work for ONE process only. A database
implementation can be added behind the same interfaces; the comments say which operations must be atomic.

## Endpoints

| Path | Method | What |
|---|---|---|
| `/.well-known/openid-configuration` | GET | Discovery document (lists only what is implemented) |
| `/jwks` | GET | Public signing key(s) as JWK, `kid` = RFC 7638 thumbprint |
| `/authorize` | GET | Validates the request, shows the login form |
| `/login` | POST | Login form target; on success redirects to `redirect_uri` with `code`, `state`, `iss` |
| `/token` | POST | `authorization_code` and `refresh_token` grants |
| `/userinfo` | GET, POST | Claims for a Bearer access token |
| `/revoke` | POST | RFC 7009 revocation of refresh tokens |
| `/logout` | GET, POST | OIDC RP-initiated logout (`end_session_endpoint`) |

## What it does, and the test that proves it

Test files are in `test/`. Integration tests start the real HTTP server on an ephemeral port (`test/helpers.ts`
`startServer`) with an injectable clock, so expiry is tested without sleeping.

**1. Authorization Code flow with PKCE**

| Rule | Test |
|---|---|
| Whole flow: authorize -> login form (CSRF) -> redirect with code -> token -> userinfo -> refresh -> revoke | `flow.test.ts` "public client: authorize -> login (CSRF) -> code -> token -> userinfo -> refresh -> revoke"; "confidential client authenticates with client_secret_basic ..." |
| PKCE required, S256 only: missing challenge, `plain`, missing method (= plain per RFC 7636), malformed challenge are refused | `authorize.test.ts` "missing PKCE ...", "code_challenge_method=plain ...", "code_challenge without a method ...", "malformed S256 challenge ..." |
| Wrong / missing verifier at the token endpoint | `token.test.ts` "wrong code_verifier -> invalid_grant", "missing code_verifier -> invalid_request", "the challenge itself sent as verifier ..."; RFC 7636 appendix B vector in `units.test.ts` |
| `state` is passed through (success and error redirects) | `login.test.ts` "correct credentials ... with code, state and iss"; `authorize.test.ts` error tests check `state` |
| Exact redirect_uri match (no prefix, trailing slash, extra query, other port, case, host, other client's URI); never redirect to an unregistered URI | `authorize.test.ts` "redirect_uri %s -> 400 page, no redirect" (8 cases); `token.test.ts` "redirect_uri different from the authorization request" |
| Codes are single-use; a reused code fails AND revokes the tokens issued from it | `token.test.ts` "a reused code fails AND revokes the tokens issued from it", "the code is burned by its first presentation, even a failed one" |
| Codes are short-lived (60 s) | `token.test.ts` "an expired code (older than 60 s)", "a code just inside its lifetime still works" |
| A code only works for the client it was issued to | `token.test.ts` "a code issued to another client" |
| Other `/authorize` errors: `unsupported_response_type`, `invalid_scope`, repeated parameter, `prompt=none` -> `login_required`, `response_mode` other than query | `authorize.test.ts` |

**2. Clients from a static config file**

| Rule | Test |
|---|---|
| Config is validated: http redirect only for loopback, no fragments, confidential needs a scrypt hash, public must not have one, only known scopes and grants | `units.test.ts` "rejects a client with %s" (8 cases) |
| The shipped `config/example.json` loads and its documented FAKE secrets verify | `units.test.ts` "the shipped example config loads ..." |
| Confidential clients: `client_secret_basic` only; wrong secret -> 401 `invalid_client` + `WWW-Authenticate`; no credentials -> 401; `client_secret_post` refused | `token.test.ts` "/token client authentication" block |
| Public clients cannot send Basic credentials | `token.test.ts` "Basic credentials for a PUBLIC client are refused" |

**3. Login page**

| Rule | Test |
|---|---|
| Passwords hashed with scrypt (N=2^17, r=8, p=1 by default; parameters stored in the hash) | `units.test.ts` "scrypt hash round trip ...", "the default cost is the OWASP minimum ..." |
| CSRF synchronizer token bound to the login transaction cookie (HttpOnly, SameSite=Lax) | `login.test.ts` "bad CSRF token -> 403", "missing CSRF token -> 403", "a CSRF token from ANOTHER login transaction is rejected", "missing transaction cookie -> 400"; `authorize.test.ts` "sets an HttpOnly SameSite cookie ..." |
| Unknown user and wrong password look the same (same status and message; a dummy scrypt runs for unknown users) | `login.test.ts` "wrong password ...", "unknown user ..." |
| Transaction is single-use, expires after 10 minutes, dies after 5 wrong passwords | `login.test.ts` |
| Page is no-store, not frameable (CSP `frame-ancestors 'none'`, `X-Frame-Options: DENY`), every value HTML-escaped | `authorize.test.ts` "sets an HttpOnly SameSite cookie ..."; `units.test.ts` "escapes every dynamic value ..." |
| Constant-time comparison wherever secrets are compared: CSRF token and PKCE challenge via `safeEqual` (hash both, `timingSafeEqual`), scrypt outputs via `timingSafeEqual`. Codes and refresh tokens are looked up by their SHA-256 hash, so the secret itself is never compared | `units.test.ts` "safeEqual compares contents ..." (correctness only; timing is NOT measured) |

**4. Token endpoint**

| Rule | Test |
|---|---|
| Access token: ES256 JWT, `typ: at+jwt`, `iss aud sub exp iat jti scope client_id`, 300 s lifetime | `flow.test.ts` first test; `interop.test.ts` (verified by `jose`) |
| Refresh tokens are opaque, stored as SHA-256 hashes, rotated on every use | `refresh.test.ts` "every use returns a NEW refresh token; the old one stops working" |
| Reuse of an old refresh token revokes the whole family (including the newest token and its access tokens at `/userinfo`) | `refresh.test.ts` "reusing an old refresh token revokes the WHOLE family ..." |
| Refresh token of another client, unknown, expired; scope may narrow but not widen | `refresh.test.ts` |
| `Cache-Control: no-store` and `Pragma: no-cache` on every token response, success and error | `flow.test.ts`; `token.test.ts` `expectOAuthError` checks it on every error |

**5. OpenID Connect**

| Rule | Test |
|---|---|
| `openid` scope -> `id_token` with `nonce` echoed and `aud` = client_id; no `openid` -> no id_token | `flow.test.ts`; `interop.test.ts` (openid-client validates it, and rejects a wrong nonce) |
| `at_hash` (left half of SHA-256 over the access token, base64url) | `flow.test.ts` "at_hash is the left half of SHA-256 ..." (computed independently in the test) |
| Discovery and JWKS (public key only, `kid` = thumbprint) | `discovery.test.ts` |
| `/userinfo`: Bearer token; signature, `typ`, `iss`, `aud`, `exp` checked; revoked family -> 401; no `openid` scope -> 403 `insufficient_scope`; claims filtered by scope | `userinfo.test.ts` (tampered signature, tampered payload, other key with same kid, `alg: none`, id_token presented, wrong audience, wrong issuer, expired, unknown jti) |

**6. Revocation (RFC 7009)**: refresh token revocation kills its family; unknown token -> 200; another client's
token is left alone (200); client authentication required. `revoke.test.ts`.

**8. Persistent storage (stage 2)** -- `src/file-store.ts`, tests in `test/persistence.test.ts`

| Rule | Test |
|---|---|
| Restart on the same data dir (same port, so the same issuer): the old access token works at `/userinfo`, the refresh token works, `/jwks` is unchanged | "access token, refresh token and signing key all work after a restart on the same data dir" |
| Security state survives the restart: a refresh token used before it is still reuse after it (family revoked, and that revocation is itself persisted); a code redeemed before it is still single-use; a revoked family stays revoked | "a refresh token used BEFORE the restart ...", "an authorization code redeemed before the restart ...", "a revoked token family stays revoked after a restart" |
| Only hashes on disk: the log contains SHA-256 of the code, the refresh token and the session cookie, never the raw values | "the log holds only hashes ..." |
| Write-ahead: a failed disk write leaves memory unchanged | "write-ahead: when the disk write fails, the in-memory state does not change" |
| Torn last line (crash mid-append) dropped; a bad line in the middle refuses to start | "a torn LAST line ...", "a bad line in the MIDDLE of the log is corruption ..." |
| Compaction at start drops expired codes / refresh tokens / unreferenced families and keeps used / revoked flags | "compaction at start drops ...", "compaction keeps live entries with their state" |
| Login transactions are NOT persisted (documented limitation, tested so it cannot change silently) | "login transactions are NOT persisted ..." |

How it works: every change is one JSON line, written with `writeSync` + `fsyncSync` and only THEN applied in memory;
the HTTP response goes out after that. At start the log is replayed through the same `apply()` function, then
compacted: the live state is written to `store.jsonl.tmp`, fsync'ed and renamed over `store.jsonl`.

Crash safety, honestly:
- Crash between two appends: every acknowledged change is on disk. A request that wrote only some of its records
  fails closed (for example: code consumed, family not created -> the code is burned and the client got nothing;
  refresh token marked used, new one not saved -> the client never got the new token, its retry with the old one
  is reuse and kills the family).
- Crash in the middle of an append: the torn last line is dropped at the next start (it was never acknowledged).
- Crash during compaction: the old log is untouched until the rename; a leftover temp file is overwritten.
  On POSIX the rename is atomic and the directory is fsync'ed. On Windows node's rename uses
  `MoveFileEx(REPLACE_EXISTING)`, which is not documented as atomic, and directories cannot be fsync'ed.
- fsync is only as good as the disk (write caches that lie). NOT tested with real power loss: the tests write a torn
  line themselves. There is no per-line checksum, so a line that is valid JSON but wrong is not detected.
- ONE process per data directory and NO lock file: a second process on the same directory would double-redeem
  codes and not see the other's revocations.

**9. Signing-key rotation (stage 2)** -- `src/keys.ts` `FileKeyRing`, tests in `test/keys.test.ts` and `test/interop.test.ts`

| Rule | Test |
|---|---|
| First start generates an `active` key and a pre-published `next` key into `<DATA_DIR>/keys.json`; both are in `/jwks`, only the active one signs | `keys.test.ts` "first start generates ..." |
| Keys are read back at the next start (same kids); a file with two active keys or a wrong kid is refused | "the keys are read back ...", "a file with two active keys ..." |
| `keys.json` mode 0600 | "keys.json is created with mode 0600" -- SKIPPED on Windows (node ignores the mode there), so it did NOT run on the machine these results come from |
| `rotate()`: next -> active, active -> retired, a new next appears; tokens signed by the retired key still pass `/userinfo` | "rotate(): the pre-published key starts signing ..." |
| The retired key stays published until its last token has expired (retention = longest JWT lifetime = 300 s), then disappears | "the retired key stays published until ...", "the retention is the longest token lifetime ..." |
| Automatic rotation when the active key is older than `rotateAfterMs` (CLI: `KEY_ROTATE_DAYS`, default 30) | "automatic rotation once the active key is older than rotateAfterMs" |
| Rotation is persisted; expired retired keys are removed from the file at the next rotation | "a rotation is written to keys.json ...", "expired retired keys are removed ..." |
| jose across a rotation: a JWKS fetched BEFORE the rotation already verifies the new token (pre-published key; jose does not refetch inside its 30 s cooldown), old and new tokens verify, after the overlap the old kid gives `JWKSNoMatchingKey` | `interop.test.ts` "a JWKS fetched BEFORE the rotation ..." |

One response is always signed with one key (access token and id_token have the same kid). Private keys are PKCS#8
PEM, NOT encrypted at rest; never committed (generated at first start; `data/` is git-ignored).

**10. Login session and RP-initiated logout (stage 2)** -- tests in `test/logout.test.ts`

| Rule | Test |
|---|---|
| A successful login creates a session: cookie `auth_session` (random, HttpOnly, SameSite=Lax, Path=/, 12 h, Secure on https), stored only as a hash; the public `sid` goes into the id_token | "a successful login sets an HttpOnly SameSite=Lax session cookie ...", "each login gets its own sid" |
| `/logout` with `id_token_hint` + registered `post_logout_redirect_uri`: 302 to exactly that URI with `state`, session cookie cleared, every token family of the session revoked (refresh -> `invalid_grant`, access token -> 401) | "id_token_hint + registered post_logout_redirect_uri ...", "no state parameter ...", "POST form works the same way" |
| Without `post_logout_redirect_uri`: 200 "Signed out" page | "without post_logout_redirect_uri ..." |
| `post_logout_redirect_uri` exact match (prefix, trailing slash, extra query, the LOGIN redirect_uri, other host -> 400, no redirect, nothing revoked) | "post_logout_redirect_uri %s -> 400 page ..." (5 cases); config validation in `units.test.ts` |
| `id_token_hint` is required and fully verified (signature with a published key, `typ: JWT`, iss, aud); only `exp` is ignored (an expired hint is accepted, as the spec allows) | "missing id_token_hint", "tampered signature", "signed by a key this server does not publish", "an access token is not an id_token_hint", "an EXPIRED id_token is still accepted"; `units.test.ts` "ignoreExpiry skips ONLY the exp check" |
| `client_id` must equal the hint's `aud`; repeated parameters refused | "client_id that differs ...", "a repeated parameter" |
| Only that session ends; the browser's session cookie is ended too if it belongs to the SAME user, never another user's | "only the families of THAT session ...", "the browser's session cookie is ended too ...", "a session cookie of ANOTHER user is not ended ..." |
| Idempotent; an id_token from a refresh names the same session | "a second logout ...", "the id_token from a REFRESH also names the session ..." |
| Discovery advertises `end_session_endpoint` | `discovery.test.ts`; `interop.test.ts` (openid-client reads it) |

**11. id_token on refresh (stage 2, OIDC Core 12.2)**: same iss, sub, aud, auth_time and sid, new iat, no nonce,
at_hash of the new access token; none when the narrowed scope has no `openid`. `refresh.test.ts`; openid-client
validates it in `interop.test.ts`.

**7. Errors** use the OAuth JSON format (`error`, `error_description`) with the RFC status codes (400, 401 with
`WWW-Authenticate`, 403, 405, 413). Checked throughout `token.test.ts`, `userinfo.test.ts`, `revoke.test.ts`.

## Interop with independent libraries (devDependencies only)

`test/interop.test.ts`, 10 tests, all passing:

- **jose 6.2.15**: `createRemoteJWKSet` fetches OUR `/jwks` and `jwtVerify` accepts our access token (with
  `typ: at+jwt`, issuer, audience, ES256) and id_token; it rejects a tampered signature and a wrong audience.
- **openid-client 6.8.9**: `discovery` -> `buildAuthorizationUrl` (PKCE S256, state, nonce) -> our login form ->
  `authorizationCodeGrant` (it validates state, `iss` in the response, PKCE, and the id_token incl. nonce) ->
  `fetchUserInfo` -> `refreshTokenGrant` -> `tokenRevocation`, for a public client (`None()`) and a confidential
  client (`ClientSecretBasic`). It also surfaces our `invalid_grant` on a reused code, rejects a wrong state, and
  rejects a wrong expected nonce.
- **Stage 2 additions**: jose across a key rotation (see section 9); openid-client reads `end_session_endpoint`
  from discovery, `buildEndSessionUrl` (it adds `client_id` itself) goes through our `/logout` with
  `id_token_hint`, `post_logout_redirect_uri` and `state`, and `refreshTokenGrant` afterwards gets `invalid_grant`;
  openid-client also validates the id_token in the refresh response.
- What does NOT interoperate / is not covered: openid-client only BUILDS the logout URL; there is no library-side
  handling of the logout response to test, so the test follows the redirect itself. openid-client does not verify
  id_token signatures from the token endpoint by default (TLS-protected response, allowed by OIDC), so the key
  rotation is checked with jose only, not with openid-client.
- Two honest caveats: openid-client is a client library, so the test posts the login form itself (it follows the URL
  openid-client built and hands the redirect back). And `allowInsecureRequests` is enabled because the test server
  runs on plain `http://127.0.0.1`.

## Proving the tests can fail (mutation checks)

Each rule was broken on purpose in the source, the full suite was run, and the source was restored from git. Then
the whole suite was run green again.

| # | Rule broken (where) | Tests that turned red |
|---|---|---|
| M1 | redirect_uri prefix match instead of exact (`server.ts` `redirectUriAllowed`) | `authorize.test.ts` redirect_uri "prefix match", "trailing slash", "extra query parameter" |
| M2 | accept `plain` / missing method (`handleAuthorize`) | `authorize.test.ts` "code_challenge_method=plain", "code_challenge without a method" |
| M3 | skip PKCE verifier check (`codeGrant`) | `token.test.ts` "wrong code_verifier", "the challenge itself sent as verifier", "the code is burned by its first presentation" |
| M4 | reused code rejected but issued tokens NOT revoked (`codeGrant`) | `token.test.ts` "a reused code fails AND revokes the tokens issued from it" |
| M5 | code never marked used (`store.ts` `MemoryCodeStore.consume`) | `token.test.ts` "a reused code fails ...", "the code is burned ..."; `interop.test.ts` "openid-client surfaces our errors: reused code" |
| M6 | code expiry check removed (`codeGrant`) | `token.test.ts` "an expired code (older than 60 s)" |
| M7 | refresh reuse rejected but family NOT revoked (`reuseDetected`) | `refresh.test.ts` "reusing an old refresh token revokes the WHOLE family" |
| M8 | refresh token never marked used = no rotation (`MemoryTokenStore.markUsed`) | first run: ONLY "reusing an old refresh token ..." (gap, see below); after the fix also "every use returns a NEW refresh token; the old one stops working" |
| M9 | CSRF check removed (`handleLogin`) | `login.test.ts` "bad CSRF token", "missing CSRF token", "a CSRF token from ANOTHER login transaction" |
| M10 | client secret not verified (`authenticateClient`) | `token.test.ts` "wrong client secret"; `revoke.test.ts` "client authentication is required" |
| M11 | JWT signature not verified (`jwt.ts` `verifyJwt`) | `userinfo.test.ts` "tampered signature", "tampered payload", "a token signed by a different key with the same kid"; `units.test.ts` "unknown kid, malformed token and bad signature" |
| M12 | audience not checked (`verifyJwt`) | `userinfo.test.ts` "a correctly signed token with the wrong audience"; `units.test.ts` "wrong audience -> JwtError" |
| M13 | `state` dropped from the success redirect (`handleLogin`) | `login.test.ts` "correct credentials ..."; `flow.test.ts` first test; 4 tests in `interop.test.ts` (openid-client checks state) |
| M14 | `Cache-Control: no-store` removed from token success responses (`sendTokens`) | `flow.test.ts` first test |
| M15 | revocation ignores which client owns the token (`handleRevoke`) | `revoke.test.ts` "another client cannot revoke my token" |

**Gap found**: with M8 the rotation test stayed green. Its name said "the old one stops working" but it only checked
that the three tokens were different. It now presents the old token and expects `invalid_grant`, and turns red under
M8. Note also: the id_token-as-access-token test did NOT turn red under M12, because the `typ` check rejects it too;
the dedicated wrong-audience test is the one that catches M12.

### Stage 2 mutation checks (M16-M40)

Same procedure, scripted: each mutation is a string replacement in one source file, the full suite runs with the
vitest JSON reporter, the failed tests are counted, and the file is restored with `git checkout`. Then the whole
suite was run green again.

| # | Rule broken (where) | Failed tests | Which |
|---|---|---|---|
| M16 | write-ahead broken: apply in memory BEFORE the disk write (`file-store.ts`) | 1 | `persistence.test.ts` "write-ahead: when the disk write fails, the in-memory state does not c..." |
| M17 | code consumption not logged (memory only) (`file-store.ts`) | 4 | `persistence.test.ts` "an authorization code redeemed before the restart is still single-use...", "a torn LAST line (crash in the middle of an append) is dropped...", "compaction at start drops expired codes and refresh tokens (and famili...", "compaction keeps live entries with their state (used, revoked)" |
| M18 | refresh-token use not logged (memory only) (`file-store.ts`) | 2 | `persistence.test.ts` "a refresh token used BEFORE the restart is still detected as reuse AFT...", "write-ahead: when the disk write fails, the in-memory state does not c..." |
| M19 | family revocation not logged (memory only) (`file-store.ts`) | 3 | `persistence.test.ts` "a refresh token used BEFORE the restart is still detected as reuse AFT...", "a revoked token family stays revoked after a restart", "compaction keeps live entries with their state (used, revoked)" |
| M20 | corrupt middle line silently skipped instead of refusing to start (`file-store.ts`) | 1 | `persistence.test.ts` "a bad line in the MIDDLE of the log is corruption: the store refuses t..." |
| M21 | compaction keeps expired refresh tokens (`file-store.ts`) | 1 | `persistence.test.ts` "compaction at start drops expired codes and refresh tokens (and famili..." |
| M22 | session cookie stored raw instead of hashed (`server.ts`) | 1 | `persistence.test.ts` "the log holds only hashes of codes, refresh tokens and session cookies..." |
| M23 | next key not pre-published in /jwks (`keys.ts`) | 3 | `interop.test.ts` "a JWKS fetched BEFORE the rotation already has the new key..."; `keys.test.ts` "first start generates an active and a pre-published next key...", "rotate(): the pre-published key starts signing, the old key stays publ..." |
| M24 | retired key dropped at once (no overlap) (`keys.ts`) | 6 | `interop.test.ts` "a JWKS fetched BEFORE the rotation already has the new key..."; `keys.test.ts` "rotate(): the pre-published key starts signing, the old key stays publ...", "the retired key stays published until its last token has expired, then...", "automatic rotation once the active key is older than rotateAfterMs", "a rotation is written to keys.json, so a restart keeps the retired key...", "expired retired keys are removed from keys.json at the next rotation" |
| M25 | retired key never dropped (`keys.ts`) | 3 | `interop.test.ts` "a JWKS fetched BEFORE the rotation already has the new key..."; `keys.test.ts` "the retired key stays published until its last token has expired, then...", "expired retired keys are removed from keys.json at the next rotation" |
| M26 | rotation does not switch the signing key (old key keeps signing) (`keys.ts`) | 3 | `interop.test.ts` "a JWKS fetched BEFORE the rotation already has the new key..."; `keys.test.ts` "rotate(): the pre-published key starts signing, the old key stays publ...", "automatic rotation once the active key is older than rotateAfterMs" |
| M27 | automatic rotation by age disabled (`keys.ts`) | 1 | `keys.test.ts` "automatic rotation once the active key is older than rotateAfterMs" |
| M28 | rotation not written to keys.json (`keys.ts`) | 2 | `keys.test.ts` "a rotation is written to keys.json, so a restart keeps the retired key...", "expired retired keys are removed from keys.json at the next rotation" |
| M29 | keys.json created without mode 0600 (`keys.ts`) | 0 | NONE on this machine (Windows): the only test for it is skipped on win32 -- see below |
| M30 | post_logout_redirect_uri prefix match instead of exact (`server.ts`) | 3 | `logout.test.ts` "post_logout_redirect_uri prefix -> 400 page, no redirect, nothing revo...", "post_logout_redirect_uri trailing slash -> 400 page, no redirect, noth...", "post_logout_redirect_uri extra query -> 400 page, no redirect, nothing..." |
| M31 | id_token_hint not verified (decoded only) (`server.ts`) | 2 | `logout.test.ts` "an id_token_hint with a tampered signature -> 400, nothing revoked", "an id_token_hint signed by a key this server does not publish -> 400" |
| M32 | logout deletes the session but does not revoke its token families (`server.ts`) | 10 | `interop.test.ts` "RP-initiated logout: discovery advertises end_session_endpoint, buildE..."; `logout.test.ts` "id_token_hint + registered post_logout_redirect_uri: redirect with sta...", "without post_logout_redirect_uri: 200 'signed out' page, no redirect,...", "an EXPIRED id_token is still accepted as a hint (signature, iss, aud s...", "only the families of THAT session are revoked...", "the browser's session cookie is ended too when it belongs to the same...", "a session cookie of ANOTHER user is not ended by this user's id_token", "a second logout with the same hint is harmless (200, still logged out)", "POST form works the same way", "the id_token from a REFRESH also names the session and logs it out" |
| M33 | state dropped from the post-logout redirect (`server.ts`) | 3 | `interop.test.ts` "RP-initiated logout: discovery advertises end_session_endpoint, buildE..."; `logout.test.ts` "id_token_hint + registered post_logout_redirect_uri: redirect with sta...", "POST form works the same way" |
| M34 | session cookie not cleared at logout (`server.ts`) | 2 | `logout.test.ts` "id_token_hint + registered post_logout_redirect_uri: redirect with sta...", "without post_logout_redirect_uri: 200 'signed out' page, no redirect,..." |
| M35 | cookie session of ANOTHER user ended too (sub check removed) (`server.ts`) | 1 | `logout.test.ts` "a session cookie of ANOTHER user is not ended by this user's id_token" |
| M36 | client_id vs aud mismatch not checked at logout (`server.ts`) | 1 | `logout.test.ts` "client_id that differs from the id_token's aud -> 400" |
| M37 | expired id_token_hint refused (ignoreExpiry off) (`server.ts`) | 1 | `logout.test.ts` "an EXPIRED id_token is still accepted as a hint (signature, iss, aud s..." |
| M38 | no sid claim in id_tokens (`server.ts`) | 11 | `interop.test.ts` "RP-initiated logout: discovery advertises end_session_endpoint, buildE..."; `logout.test.ts` "a successful login sets an HttpOnly SameSite=Lax session cookie...", "each login gets its own sid", "without post_logout_redirect_uri: 200 'signed out' page, no redirect,...", "an EXPIRED id_token is still accepted as a hint (signature, iss, aud s...", "only the families of THAT session are revoked...", "the browser's session cookie is ended too when it belongs to the same...", "a session cookie of ANOTHER user is not ended by this user's id_token", "a second logout with the same hint is harmless (200, still logged out)", "POST form works the same way", "the id_token from a REFRESH also names the session and logs it out" |
| M39 | no id_token on refresh (`server.ts`) | 5 | `flow.test.ts` "public client: authorize -> login (CSRF) -> code -> token -> userinfo..."; `interop.test.ts` "public client (token_endpoint_auth_method none) + PKCE: discovery, cod...", "confidential client with client_secret_basic"; `logout.test.ts` "the id_token from a REFRESH also names the session and logs it out"; `refresh.test.ts` "OIDC Core 12.2: a refresh returns a new id_token with the same iss, su..." |
| M40 | refreshed id_token gets auth_time = now instead of the original login time (`server.ts`) | 1 | `refresh.test.ts` "OIDC Core 12.2: a refresh returns a new id_token with the same iss, su..." |

**Gap found and fixed (M16)**: in the first run M16 turned NOTHING red. The write-ahead test closes the store and
expects the write to fail with memory unchanged, but the "store is closed" check ran before both the write and the
apply, so swapping their order changed nothing the test could see. The check now lives inside the write step
(`durable()` in `src/file-store.ts`), so "apply before write" really applies first and the test turns red (the
row above is the re-run).

**Gap NOT closed (M29)**: writing `keys.json` with mode 0644 is caught by no test on this machine. The mode test
is `it.skipIf(process.platform === "win32")` because node on Windows ignores the mode (apart from the read-only
bit), and these results come from a Windows machine. It needs a run on Linux / macOS to count.

Also note: M18 turns the write-ahead test red as a side effect (an unlogged markUsed no longer touches the closed
store), not because that test is about M18.

## Run it

```bash
npm install
npm test                 # 177 tests (1 skipped on Windows)
npx tsc --noEmit
npm run build
CONFIG_FILE=config/example.json PORT=9000 DATA_DIR=./data node dist/index.js
curl http://127.0.0.1:9000/.well-known/openid-configuration
node dist/hash-secret.js 'my-new-secret'    # scrypt hash for the config file
```

Environment: `CONFIG_FILE` (required), `PORT` (9000), `HOST` (127.0.0.1), `ISSUER` (default
`http://127.0.0.1:<PORT>`), `DATA_DIR` (file-backed store `store.jsonl` and rotating keys `keys.json`; created with
mode 0700 / 0600), `KEY_ROTATE_DAYS` (30). Without `DATA_DIR` the store is in memory and the key comes from
`SIGNING_KEY_FILE` (optional PKCS#8 PEM, EC P-256) or is generated at every start, so all issued tokens become
unverifiable after a restart. `./data` is git-ignored by the repository's `.gitignore`.

The example config contains OBVIOUSLY FAKE secrets: users `alice` / `alice-password-FAKE`, `bob` /
`bob-password-FAKE`, client `demo-web` secret `webapp-secret-FAKE`. Test secrets are generated at runtime.

## Design notes

- Lifetimes: code 60 s, access token 300 s, id_token 300 s, refresh token 14 days, login transaction 10 min,
  login session 12 h. A retired signing key stays published for 300 s (the longest JWT lifetime).
- Access tokens are self-contained JWTs, so a third-party API verifying them offline cannot see a revocation until
  `exp` (max 300 s). Only this server's `/userinfo` honours revocation, because it records each access token's `jti`
  and its token family.
- A "token family" = everything issued from one authorization code. Code reuse, refresh-token reuse and revocation
  all revoke the whole family.
- An authorization code is burned on its first presentation, even if that request fails (for example a wrong
  verifier). A failed CLIENT authentication does not burn it (the request never reaches the grant).
- In memory the check-and-set of "used" is one synchronous step, so two concurrent redemptions cannot both win on
  Node's single thread. A database must do the same atomically (see comments in `src/store.ts`).
- `/revoke` answers 200 for a token that belongs to another client and leaves it alone, so the endpoint does not tell
  a client which tokens exist. RFC 7009 2.1 says such a request is "refused"; I chose not to reveal it instead.

## NOT implemented (after stage 2)

- A database store; more than one process per data directory (no lock file, no shared state); a lock that stops a
  second process from opening the same `DATA_DIR`.
- Expiry sweeping while running (the file store compacts at start only; the in-memory store never sweeps).
- One fsync per request (today one per record; a code grant writes 5 records); per-line checksums in the log.
- Real power-loss testing of the crash-safety claims.
- Login transactions and the failed-password counter survive a restart (they are memory only, by design).
- Keys encrypted at rest / KMS / HSM; emergency removal of a compromised key (today: stop the server and edit
  `keys.json`); one key ring shared by several processes. The 0600 mode test has not run on Windows.
- SSO: the session cookie is set and cleared but NOT used to skip the login form; `prompt=none` still always
  returns `login_required`; no `prompt=login`, `max_age`.
- Logout without `id_token_hint` (no confirmation page), `logout_hint`, front-channel and back-channel logout
  (other RPs are not told); "log out everywhere" for a user. Access tokens verified offline by third parties stay
  valid until `exp` after logout (only our `/userinfo` sees the revocation).
- Consent screen (any allowed scope is granted after login).
- Grants other than authorization_code and refresh_token (no client credentials, no device flow, no implicit, no
  password grant).
- `client_secret_post`, `private_key_jwt`, mTLS client auth; DPoP / mTLS sender-constrained tokens.
- Revocation of access tokens at `/revoke` (only refresh tokens); token introspection (RFC 7662).
- `c_hash`, `acr`, `amr`; request objects / PAR / JAR; `response_mode` other than query.
- Rate limiting of logins (only 5 wrong passwords per login transaction; an attacker can start new transactions).
- Dynamic client registration.
- Any measurement; any deployment.
