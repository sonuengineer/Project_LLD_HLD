# B5 Password Storage System (low-level design): plan

Status (2026-11-26): stage 1 DONE (48 tests, 30 mutation checks, all caught). Stage 2 DONE (63 tests, 46
mutation checks, all caught). Stage 3 DONE (90 tests, 17 new mutation checks, all caught). Stage 4 DONE (106
tests, 13 new mutation checks, all caught). Stage 5 DONE (113 tests, 8 new mutation checks, all caught).
Stage 6 DONE (122 tests, 7 new mutation checks, all caught). Stage 7 DONE (140 tests, 7 new mutation checks,
all caught).

## Why this project

"Design a password manager" is the usual framing of this LLD question: a master password unlocks storage for
a user's OTHER credentials (their GitHub password, their email password, ...). That is a different problem
from "how does a web app store its own users' login passwords" -- this repo already covers that angle in
`14-auth-server`. The two hard, test-worthy questions here are: how do you verify a master password without
ever storing it, and what happens the moment someone starts guessing.

## Decisions (one recommendation each)

- **TypeScript, zero runtime dependencies, in memory.** Node's built-in `crypto` module provides everything
  needed (scrypt, AES-256-GCM) -- no third-party crypto package. Same toolchain as the rest of this repo.
- **The master password itself is never stored, not even as a separate hash.** Only a random salt and a
  "canary": a fixed plaintext encrypted once, at vault creation, with the key derived from the real master
  password. Unlocking derives a candidate key from the entered password and tries to decrypt the canary.
  AES-256-GCM is authenticated: a wrong key fails to decrypt (the auth tag will not verify) on its own, with
  no separate comparison needed. One KDF, one artifact, no second "password hash" field that could drift out
  of sync with it.
- **Every entry is one AES-256-GCM blob (title + username + password + notes), with a fresh random IV per
  write.** Reusing an IV with the same key is the one way to badly break AES-GCM, so a new one is generated on
  every `encrypt()` call, including re-encryption on `updateEntry`.
- **Lockout after repeated wrong attempts, using an injectable `Clock`** (same pattern as every other project
  here) so tests sit exactly on the cooldown boundary without sleeping. `changeMasterPassword`'s old-password
  check goes through the exact same lockout gate as `unlock()` -- otherwise it would be an unrated side door
  for guessing the password.
- **`changeMasterPassword` re-encrypts every entry under a new key, atomically.** Every entry is decrypted
  with the old key and re-encrypted with the new one into a fresh map; the vault's salt/canary/entries are
  only reassigned after all of that succeeds. A wrong old password, or any failure, leaves the vault completely
  untouched -- same "an error means nothing happened" rule as the rest of this repo. The vault is left locked
  afterward on purpose, the way a real app re-prompts after a password change.
- **`exportVault` returns ciphertext only, and works without unlocking.** A backup of an encrypted vault
  should not itself require the master password; this is also how the project proves, end to end, that no
  plaintext secret ever reaches storage.
- **A cryptographically secure password generator**, using `crypto.randomInt` (never `Math.random`, which is
  not a secure source of randomness for anything secret).
- **Stage 1 is fully synchronous** (Node's scrypt/AES calls are sync) -- one vault per owner, one process, no
  real concurrency. Multiple devices sharing a vault, and any network/sync layer, are stage 2.

### Stage 2 decisions

- **Saving an entry becomes a real async call to a `VaultStore`** (a disk, a network service) -- the one
  async dependency in the project, and the one place two devices can genuinely race each other. Every
  mutating operation follows the same shape as `17-parking-lot`'s reserve/confirm: a SYNCHRONOUS claim (JS
  cannot preempt synchronous code, so the race is prevented by construction, not by a lock primitive), one
  `await` across the store call, then a synchronous apply (success) or release (failure). Nothing is ever
  applied to the vault until its store write has actually succeeded.
- **Several devices can each hold their own unlocked session on the SAME vault at once.** `unlock()` returns
  a `sessionId`; `lock()` closes only that one session. Recommended over a single shared "unlocked" flag
  because that is how real multi-device sync behaves, and because it is what makes the interesting races
  (two devices acting on one vault) possible to even construct.
- **The concrete bug this design prevents: a concurrently-added entry silently lost to a password rotation.**
  Rotating re-encrypts every entry into a brand-new map and then replaces the vault's entries wholesale; if an
  add is allowed to land between the rotation's read and its replace, the add is encrypted under the OLD key
  but the replace discards it. Fixed with two counters on the vault: `rotating` (true while a rotation's
  commit is in flight) and `pendingEntryOps` (count of in-flight add/update/delete commits) -- each entry
  operation's claim checks `rotating`, and rotation's claim checks `pendingEntryOps`, so the two can never be
  in flight on the same vault at the same time. A `test/concurrency.test.ts` test illustrates the un-guarded
  version of this exact bug directly (not through `PasswordManager`), for contrast.
- **A lighter, per-entry version check for two devices editing the SAME entry.** Each entry carries a
  `version`, captured by `updateEntry` before its own store call and re-checked after; if another update (or a
  delete) won the race in between, the loser gets `ENTRY_CONFLICT` and its (already-persisted) write is
  discarded rather than silently overwriting -- or being silently overwritten by -- the winner's.
  `deleteEntry` has the analogous re-check for "was this already deleted:" the second of two concurrent
  deletes gets `UNKNOWN_ENTRY`, not a silent no-op success.
- **Changing the master password invalidates every OTHER session immediately.** This closes a real gap stage
  1 left open: a session that unlocked under the old password, if it kept running, could otherwise still
  write entries encrypted under a key the vault's canary no longer matches. A `generation` counter on the
  vault, bumped on every successful rotation and captured by each session at unlock time, makes this a lazy
  comparison (`SESSION_INVALIDATED`) rather than something that has to eagerly walk and revoke every session.
- **The store call is wrapped in the same `withTimeout`/`AbortSignal` idiom as `17-parking-lot`'s device
  calls.** A hung store fails cleanly (`STORE_TIMEOUT`) instead of leaving the caller waiting forever, and the
  claim it was holding is still released in a `finally`, so one hung commit cannot wedge the vault for every
  later operation.

### Stage 3 decisions

- **Breach-check integration via the real k-anonymity protocol** (the one Have I Been Pwned's password API
  actually uses): only the first 5 hex characters of a password's SHA-1 hash ever leave `isPasswordBreached`;
  the provider returns every breached hash sharing that prefix, and the comparison against the full hash
  happens locally. `FakeBreachProvider` is a small, fixed, explicitly-fake in-memory dataset -- not a real
  network call -- but it speaks the real protocol, which is the part worth testing (`test/breach.test.ts`
  asserts, via a spy provider, that nothing longer than 5 characters -- and never the password itself -- is
  ever sent out).
- **A breach check can NEVER block a save -- the opposite instinct from this project's usual "an error means
  nothing happened" rule, deliberately.** `BreachChecker.check()` never throws: a provider error, a timeout,
  or an open circuit all degrade to `null` ("unknown"), and `addEntry`/`updateEntry` still succeed either way.
  Breach-checking is a non-critical dependency; a flaky third-party service must not be able to stop someone
  from saving a password.
- **A small, self-contained circuit breaker** (closed -> open after `failureThreshold` consecutive failures
  -> a single half-open trial after `cooldownMs`) protects the save path from a slow/down breach-check
  service, on top of a per-call timeout. Not imported from this repo's other resilience-themed projects
  (`18-resilience`, `19-rate-limit`) -- each project here is a standalone package, and the breaker needed here
  is small enough that writing it directly (same pattern as `timeout.ts`/`withTimeout`) is simpler than wiring
  up a cross-project dependency.
- **`updateEntry` only re-checks breach status when the password field actually changes.** Re-checking an
  unchanged password would just be an extra call against the breach-check service for no new information; a
  patch that does not touch the password keeps the entry's existing `breached` value.
- **The breach-check call starts (but is not awaited) before any claim, and is only awaited once the claim
  already holds.** This keeps `claimEntryOp`'s "run synchronously, before any await" invariant from stage 2
  completely intact -- the only new constraint stage 3 added to that machinery was making sure it still
  holds with one more async step in the mix.

### Stage 4 decisions

- **Shared entries between two INDEPENDENT vaults, via hybrid (envelope) encryption** -- the same pattern TLS
  and PGP use: RSA-OAEP is slow and can only encrypt a small payload, so it wraps only a fresh one-time AES
  key; the entry's actual content is encrypted with that AES key through the same AEAD as everywhere else in
  this project (`src/sharing.ts`). This lets one vault hand a credential to another without either side ever
  seeing the other's master password, vault key, or private key.
- **Each vault lazily generates its own RSA keypair, only on first use.** A 2048-bit keypair takes roughly
  200ms to generate synchronously -- fine once per vault that ever shares something, wasteful to pay on
  every `createVault` for vaults that never do. `getSharingPublicKey` is the one entry point: it returns the
  existing public key if there is one, or generates, persists, and returns a new one.
- **The private key is stored only encrypted under the vault's own key, exactly like any entry's secret
  content** -- never in the clear, even inside the vault's own storage. `changeMasterPassword` must re-wrap
  it on every rotation, the same way it re-encrypts every entry; missing this would silently and permanently
  brick sharing after the very first password change (the key would still be "encrypted," just under a key
  the vault's canary no longer matches -- the identical class of bug stage 2 fixed for entries, now
  reappearing for this new piece of state).
- **A share token is a self-contained, portable artifact -- not a live call between two vaults.** `shareEntry`
  is a pure, synchronous read (decrypt with the sender's key, re-encrypt for the recipient); it needs no
  commit and no claim, because nothing about the sender's vault changes. `redeemShare` unwraps the token with
  the recipient's own private key and then calls the recipient's OWN `addEntry` -- so the shared credential
  automatically gets the exact same claim/commit exclusion (stage 2) and the exact same breach check, against
  the RECIPIENT's own configuration, not the sender's (stage 3), with no duplicated logic anywhere.
- **`getSharingPublicKey` goes through the same `claimEntryOp`/commit machinery as `addEntry`,** because it
  mutates persisted vault state (the new keypair) the same way adding an entry does -- it must be excluded by
  (and exclude) an in-flight rotation for exactly the reason stage 2 established.

### Stage 5 decisions

- **Every `shareEntry` call now registers a lightweight grant, tracked manager-wide, not per-vault.** A
  `shares: Map<shareId, {ownerId, revoked, redeemedAt}>` sits alongside the existing `sessions` map, for the
  same reason: this is bookkeeping ABOUT a grant, not vault content, so it never goes through `VaultStore` and
  does not survive a restart (the same already-documented limitation as sessions).
- **Shares are single-use.** `redeemShare` claims the grant (`redeemedAt = now()`) SYNCHRONOUSLY, before any
  `await` -- the identical claim-before-await shape as `claimEntryOp`, now applied to a completely different
  resource. Two concurrent redemptions of the same token can therefore never both succeed, by the same
  construction argument as every other race in this project, not by a lock.
- **A genuine failure after claiming releases it; a precondition failure before claiming never reaches it.**
  `NO_SHARING_KEY` (the recipient never generated a keypair) is checked and thrown BEFORE the claim, because
  it is not an actual redemption attempt and must not burn the one-time use. A tampered/wrong-recipient token,
  or the recipient's own `addEntry` hitting `VAULT_BUSY`, fails AFTER claiming and releases it in a `catch`,
  so a legitimate retry still gets its one real shot.
- **`revokeShare` reports an unknown shareId and someone-else's shareId identically (`UNKNOWN_SHARE`).** Never
  letting a caller distinguish "does not exist" from "exists but is not yours" is the same
  don't-leak-existence instinct used elsewhere (a wrong password and an unknown account should look the same
  to an attacker). Revoking an already-revoked or already-redeemed share is a harmless no-op, not an error.

### Stage 6 decisions

- **Sessions auto-lock after a period of inactivity, via LAZY expiry -- never a background timer.** The same
  idiom this project already uses for the lockout cooldown and `SESSION_INVALIDATED`: checked on next use,
  not on a schedule. `requireSession` is the single choke point every session-based call already goes
  through, so it is the one place that both checks the idle deadline and, on success, resets it -- no other
  call site needs to remember to do either.
  `isSessionActive` is a pure read -- it reports the timeout accurately but never itself resets the idle
  clock, because a status check that could un-expire a session by being polled would defeat the whole point
  of the feature.
- **Each session has its own independent idle clock**, stored on the `Session` record itself
  (`lastActivityAt`), not on the vault. Two devices sharing one vault (stage 2) can have wildly different
  activity patterns -- one idling out while the other stays in active use -- and neither should affect the
  other's timer.

### Stage 7 decisions

- **An Express HTTP API in front of `PasswordManager`, matching `21-notification`'s pattern** (same Express
  version, same constant-time bearer-API-key auth, same `{ error: { code, message } }` shape, same
  `asyncRoute` wrapper for the methods that are genuinely async). For OTHER SERVICES, not browsers: one API
  key, no CORS, no per-user login layered on top -- the library's own security model (a sessionId proves
  which vault a call acts on; a master password proves you know it) already does that job, and the HTTP
  layer adds only "are you a legitimate caller of this API at all."
- **Every `PasswordManagerErrorCode` maps to a specific HTTP status**, not a blanket 400 or 500: `404` for
  "no such resource," `409` for a conflicting operation or state, `410` specifically for a revoked share
  (it existed, it is just gone now), `423` for a locked-out vault, `503` for a store that did not respond in
  time. None of the library's own error codes map to `500` -- every one of them is an expected, documented
  outcome, not a server bug; `500` is reserved for truly unexpected errors (and is logged server-side, never
  echoed to the caller).
- **`asyncRoute()` wraps every route that calls an async `PasswordManager` method.** Express 4 does not route
  a rejected promise to its error-handling middleware on its own (unlike Express 5) -- a route that forgot
  this wrapper would silently hang instead of returning an error. Routes calling a SYNCHRONOUS method
  (`createVault`, `unlock`, `shareEntry`, `revokeShare`, ...) do not need it, since Express 4 already routes a
  synchronous throw correctly.
- **No field-level validation is duplicated in the HTTP layer.** A body field is read and handed straight to
  the matching `PasswordManager` method, which already validates its own inputs and throws `INVALID_REQUEST`
  (mapped to 400) for a wrong type or shape. The one exception is `POST .../shares/redeem`: its body is a
  whole `SharedEntryToken` structure, and a malformed one would otherwise reach `openAsRecipient` as a raw
  `TypeError` (e.g. `Buffer.from(undefined)`) rather than a clean 400 -- so its shape IS checked at the HTTP
  boundary, the one place in this layer where the library has no equivalent check of its own to defer to.

## Stages

| Stage | What | Status |
|---|---|---|
| 1 | Vault lifecycle (create/unlock/lock), lockout after repeated wrong attempts, encrypted entry CRUD, atomic master-password change, encrypted export, a secure password generator; randomized invariant test; mutation checks | DONE 2026-11-26 |
| 2 | Multiple devices/sessions per vault, saving an entry as a real async store call, the add-vs-rotation and update-vs-update/delete races reproduced and fixed, session invalidation on password change, store timeout + AbortSignal; mutation checks | DONE 2026-11-26 |
| 3 | Breach-check integration via k-anonymity, a circuit breaker + timeout so a flaky breach-check service can never block a save; mutation checks | DONE 2026-11-26 |
| 4 | Shared entries between two independent vaults via hybrid/envelope encryption (RSA-OAEP + AES-256-GCM), a lazily-generated per-vault keypair whose private key is re-wrapped on every master-password rotation; mutation checks | DONE 2026-11-26 |
| 5 | Share revocation and single-use redemption: a manager-wide grant registry, claim-before-await for single-use (same shape as `claimEntryOp`), don't-leak-existence authorization on revoke; mutation checks | DONE 2026-11-26 |
| 6 | Session auto-lock on an idle timeout, via lazy expiry at `requireSession` (never a background timer), independent per-session idle clocks; mutation checks | DONE 2026-11-26 |
| 7 | An Express HTTP API exposing the full library surface, every error code mapped to a specific HTTP status, `asyncRoute` for Express 4's lack of automatic rejected-promise routing; mutation checks | DONE 2026-11-26 |

Seven substantial, distinct stages are now done. The next natural step for this project is an interview
question bank and a portfolio entry, the same finishing move `17-parking-lot` and `21-notification` took
once their own LLD stages were complete -- not an eighth feature stage.

## Not in scope

A real transport or storage backend (the `VaultStore` here is in memory), a real breach-check network call
(`FakeBreachProvider` is a fixed in-memory dataset), a UI, browser extension autofill, 2FA on unlock, expiring
a share after a time limit (only explicit revocation or single-use redemption end it), a directory service
for exchanging public keys (callers exchange them out of band), password-strength scoring beyond the
generator's own charset rules, import from another password manager's export format, actually persisting
across a restart, a background sweep that proactively evicts idle sessions (idle sessions are only ever
noticed lazily, on their next use), CORS or a browser-facing session/cookie layer on top of the HTTP API
(this API authenticates SERVICES with one API key, the same way `21-notification`'s does), rate limiting at
the HTTP layer independent of the library's own lockout.
