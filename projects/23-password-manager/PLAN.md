# B5 Password Storage System (low-level design): plan

Status (2026-11-26): stage 1 DONE (48 tests, 30 mutation checks, all caught). Stage 2 DONE (63 tests, 46
mutation checks, all caught). Stage 3 DONE (90 tests, 17 new mutation checks, all caught).

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

## Stages

| Stage | What | Status |
|---|---|---|
| 1 | Vault lifecycle (create/unlock/lock), lockout after repeated wrong attempts, encrypted entry CRUD, atomic master-password change, encrypted export, a secure password generator; randomized invariant test; mutation checks | DONE 2026-11-26 |
| 2 | Multiple devices/sessions per vault, saving an entry as a real async store call, the add-vs-rotation and update-vs-update/delete races reproduced and fixed, session invalidation on password change, store timeout + AbortSignal; mutation checks | DONE 2026-11-26 |
| 3 | Breach-check integration via k-anonymity, a circuit breaker + timeout so a flaky breach-check service can never block a save; mutation checks | DONE 2026-11-26 |
| 4 | Not decided yet; proposed once stage 3's follow-ups are picked (candidates: shared/team entries, session auto-lock on a timer, an HTTP API layer) | not started |

## Not in scope

A real transport or storage backend (the `VaultStore` here is in memory), a real breach-check network call
(`FakeBreachProvider` is a fixed in-memory dataset), a UI, browser extension autofill, 2FA on unlock, sharing
an entry between users, password-strength scoring beyond the generator's own charset rules, import from
another password manager's export format, actually persisting across a restart.
