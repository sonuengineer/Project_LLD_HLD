# B5 Password Storage System (low-level design): plan

Status (2026-11-26): stage 1 DONE (48 tests, 30 mutation checks, all caught).

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

## Stages

| Stage | What | Status |
|---|---|---|
| 1 | Vault lifecycle (create/unlock/lock), lockout after repeated wrong attempts, encrypted entry CRUD, atomic master-password change, encrypted export, a secure password generator; randomized invariant test; mutation checks | DONE 2026-11-26 |
| 2 | Not decided yet; proposed once stage 1's follow-ups are picked (candidates: multiple devices sharing one vault, breach-check integration, shared/team entries, session auto-lock on a timer) | not started |

## Not in scope

A real transport or storage backend (this is all in memory), a UI, browser extension autofill, 2FA on unlock,
sharing an entry between users, breach-database checking, import from another password manager's export format.
