# H14 -- OAuth 2.0 / OpenID Connect Authorization Server (TypeScript, zero runtime dependencies)

A hand-written authorization server on Node's built-in `node:http` and `node:crypto` (plus `node:fs` to read the
config file). No express, no jose, no passport at runtime. Built in stages so every claim here is backed by code and
tests that exist today.

## Status

| Stage | What | Status |
|---|---|---|
| 1 | Authorization Code + PKCE (S256 only), login form with CSRF token, ES256 JWT access tokens, rotating refresh tokens with reuse detection, OIDC id_token / discovery / JWKS / userinfo, RFC 7009 revocation | DONE (125 tests, incl. 8 interop tests with `jose` and `openid-client`) |
| 2+ | Persistent storage, consent, key rotation, client credentials, sender-constrained tokens, rate limiting, logout ... | NOT STARTED (ideas in `PLAN.md`) |

No performance numbers are claimed. Nothing has been measured or deployed.

**Storage is in memory** (`src/store.ts`): login transactions, authorization codes, token families and refresh
tokens live in `Map`s behind three small interfaces (`TransactionStore`, `CodeStore`, `TokenStore`). Everything is
lost on restart and works for ONE process only. A database implementation can be added behind the same interfaces;
the comments say which operations must be atomic.

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

**7. Errors** use the OAuth JSON format (`error`, `error_description`) with the RFC status codes (400, 401 with
`WWW-Authenticate`, 403, 405, 413). Checked throughout `token.test.ts`, `userinfo.test.ts`, `revoke.test.ts`.

## Interop with independent libraries (devDependencies only)

`test/interop.test.ts`, 8 tests, all passing:

- **jose 6.2.15**: `createRemoteJWKSet` fetches OUR `/jwks` and `jwtVerify` accepts our access token (with
  `typ: at+jwt`, issuer, audience, ES256) and id_token; it rejects a tampered signature and a wrong audience.
- **openid-client 6.8.9**: `discovery` -> `buildAuthorizationUrl` (PKCE S256, state, nonce) -> our login form ->
  `authorizationCodeGrant` (it validates state, `iss` in the response, PKCE, and the id_token incl. nonce) ->
  `fetchUserInfo` -> `refreshTokenGrant` -> `tokenRevocation`, for a public client (`None()`) and a confidential
  client (`ClientSecretBasic`). It also surfaces our `invalid_grant` on a reused code, rejects a wrong state, and
  rejects a wrong expected nonce.
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

## Run it

```bash
npm install
npm test                 # 125 tests
npx tsc --noEmit
npm run build
CONFIG_FILE=config/example.json PORT=9000 node dist/index.js
curl http://127.0.0.1:9000/.well-known/openid-configuration
node dist/hash-secret.js 'my-new-secret'    # scrypt hash for the config file
```

Environment: `CONFIG_FILE` (required), `PORT` (9000), `HOST` (127.0.0.1), `ISSUER` (default
`http://127.0.0.1:<PORT>`), `SIGNING_KEY_FILE` (optional PKCS#8 PEM, EC P-256). Without a key file a new key is
generated at every start, so all issued tokens become unverifiable after a restart.

The example config contains OBVIOUSLY FAKE secrets: users `alice` / `alice-password-FAKE`, `bob` /
`bob-password-FAKE`, client `demo-web` secret `webapp-secret-FAKE`. Test secrets are generated at runtime.

## Design notes

- Lifetimes: code 60 s, access token 300 s, id_token 300 s, refresh token 14 days, login transaction 10 min.
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

## Not implemented (stage 1)

- Persistent storage; more than one process; expiry sweeping (expired entries stay in memory until restart).
- Consent screen (any allowed scope is granted after login); login sessions / SSO (`prompt`, `max_age`, `id_token_hint`
  are not supported; `prompt=none` always returns `login_required`).
- Signing-key rotation (one key; `/jwks` can publish several, but there is no rotation logic).
- Grants other than authorization_code and refresh_token (no client credentials, no device flow, no implicit, no
  password grant).
- `client_secret_post`, `private_key_jwt`, mTLS client auth; DPoP / mTLS sender-constrained tokens.
- Revocation of access tokens at `/revoke` (only refresh tokens); token introspection (RFC 7662).
- id_token on refresh (not issued); `c_hash`, `acr`, `amr`; request objects / PAR / JAR; `response_mode` other than query.
- Rate limiting of logins (only 5 wrong passwords per login transaction; an attacker can start new transactions).
- Logout / session management; dynamic client registration.
- Any measurement; any deployment.
