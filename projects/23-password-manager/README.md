# B5 Password Storage System (low-level design)

A TypeScript library (no runtime dependencies, in memory) for a password manager's vault: a master password
unlocks storage for a user's OTHER credentials, encrypted at rest with AES-256-GCM. There is no UI and no
network -- nothing in this project sends anything anywhere.

Status (2026-11-26): stage 1 DONE -- 48 tests, 30 mutation checks, all caught (see "Mutation checks").
Stage 2 is not yet planned (see [PLAN.md](PLAN.md)).

```
npm ci
npm test        # 48 tests
npm run demo    # create/unlock a vault, add entries, lockout, a raw export with no plaintext in it
```

## Usage

```ts
const manager = new PasswordManager();

manager.createVault("alice", "correct-horse-battery-staple"); // starts locked
manager.unlock("alice", "correct-horse-battery-staple");

const entry = manager.addEntry("alice", {
  title: "GitHub",
  username: "alice",
  password: generatePassword({ length: 20 }),
  notes: "2FA via authenticator app",
});

manager.listEntries("alice"); // titles/usernames; never a password
manager.getEntry("alice", entry.id).password; // the one call that returns the secret

manager.changeMasterPassword("alice", "correct-horse-battery-staple", "a-new-master-password");
```

## The rules

- **The master password is never stored, not even as a separate hash.** Only a random salt and a "canary": a
  fixed plaintext, encrypted once at vault creation with the key derived from the real master password.
  Unlocking derives a candidate key and tries to decrypt the canary -- AES-256-GCM's authentication tag makes a
  wrong key fail on its own, which is the entire verification mechanism.
- **Every entry is one AES-256-GCM blob**, covering title, username, password and notes together, with a
  fresh random IV every time it is written (including on `updateEntry`). Reusing an IV under the same key is
  the one way to badly break AES-GCM.
- **Repeated wrong unlock attempts lock the vault out for a cooldown** (`LOCKOUT_MS`, default 30s), tracked
  with an injectable `Clock` so tests do not sleep. `changeMasterPassword`'s own password check goes through
  the identical lockout gate as `unlock()` -- it is not a separate, unrated way to guess the password.
- **`changeMasterPassword` re-encrypts every entry under a new key, all at once.** Every entry is decrypted
  with the old key and re-encrypted with the new one into a fresh map; the vault's salt, canary and entries
  are reassigned only after every entry succeeds. A wrong old password, or any failure, changes nothing. The
  vault is left locked afterward -- the same way a real app asks you to sign back in after this.
- **`exportVault` returns ciphertext only, and works without unlocking.** A vault backup should not itself
  require the master password; this call never decrypts anything.
- **`listEntries` never returns a password; `getEntry` does, and marks that entry as used.** Listing is meant
  to be cheap and safe to show on screen; reading one entry's password is the one call that actually reveals it.
- **An error means nothing happened**, with one deliberate exception: a WRONG unlock (or `changeMasterPassword`
  old-password) attempt deliberately records itself -- that count is the entire point of lockout.

## Design choices

See [PLAN.md](PLAN.md) for the reasoning behind each choice. In short:

- Node's built-in `crypto` (scrypt + AES-256-GCM) instead of a third-party crypto package -- audited, already
  in the runtime, and enough for everything this project needs.
- A single encrypted blob per entry instead of separately-encrypted fields -- there is no requirement to
  search or sort by title/username without unlocking first, so there is nothing to gain from splitting it, and
  splitting it would mean more IVs and more ciphertexts to keep in sync on every write.
- Not used on purpose: a separate stored hash of the master password (the canary does that job with one KDF,
  not two secrets to keep in sync), `Math.random()` anywhere near a secret, deleting entries on a failed
  `changeMasterPassword` before re-encryption is known to have fully succeeded.

## Tests

| File | Tests | What |
|---|---|---|
| test/crypto.test.ts | 8 | `deriveKey` determinism and salt-sensitivity, encrypt/decrypt round-trip, a fresh IV every call, wrong key and tampered ciphertext/authTag/IV all fail authentication |
| test/vault.test.ts | 11 | `createVault` validation and dedup, unlock/lock, wrong-password lockout (triggering it, the cooldown boundary, the counter resetting on cooldown AND on success), unknown owner |
| test/entries.test.ts | 10 | add/get/list/update/delete, field length boundaries (exact max accepted, max+1 rejected), `listEntries` never includes a password, `getEntry` bumps `lastUsedAt`, an invalid patch changes nothing |
| test/change-password.test.ts | 5 | re-encrypts every entry and the old password stops working, works without unlocking first, a wrong old password changes nothing, shares the same lockout as `unlock()`, rejects too-short new passwords |
| test/export.test.ts | 3 | works without unlocking, contains no plaintext secret/title/username/master-password, shape of the raw export |
| test/generator.test.ts | 7 | default/explicit length bounds, disabling a class excludes it, enabling one guarantees at least one instance of it, disabling every class throws, the guaranteed characters are not pinned to fixed positions (the result is shuffled) |
| test/invariants.test.ts | 4 | randomized, 4 seeds x 150 operations (add/update/delete/get/lock/unlock-correct/unlock-wrong/change-password/advance-clock) against a shadow model that independently re-derives the lockout gate; checked at every step: entry count, lock state, and that no secret ever used so far appears in the raw export; a full final comparison against the shadow model at the end |

## Mutation checks

30 deliberate breaks across `src/manager.ts`, `src/crypto.ts` and `src/generator.ts`, each applied alone with
the suite run against it, the file restored byte for byte. 30 of 30 caught. One check found a real (harmless)
design issue, not a test gap: a `pools.length > length` guard in the generator was unreachable dead code, since
there are at most 4 character classes and `MIN_GENERATED_LENGTH` is already 4 -- `length` can never be smaller
than the number of enabled classes. The guard was removed rather than writing a test for a path that cannot
occur.

| Area | Breaks |
|---|---|
| createVault | V1 duplicate-vault check removed, V2 a new vault starts unlocked |
| guards | U1 locked check removed, U2 unknown-entry check removed, U3 unknown-owner check removed |
| lockout | L1 cooldown gate bypassed, L2 lockout threshold never trips, L3 failed attempts never counted, L4 the counter is not reset on a successful unlock, L5 the counter is not reset once the cooldown elapses, L6 off-by-one on the minimum master-password length |
| validation | R1 off-by-one on a field's max length, R2 the empty-string check removed |
| entries | E1 updateEntry ignores a patched password, E2 updateEntry does not bump updatedAt, E3 deleteEntry does not delete, E4 getEntry does not bump lastUsedAt, E5 listEntries leaks a password, E6 updateEntry's title patch skips validation |
| changeMasterPassword | C1/C2/C3 the new salt/canary/entries are not actually assigned, C4 the vault is not left locked afterward |
| crypto.ts | K1 deriveKey ignores the salt, K2 encrypt reuses a fixed IV, K3 decrypt never checks the auth tag |
| generator.ts | G1 off-by-one on the max generated length, G2 the empty-charset check removed, G4 the guaranteed-one-per-class draw pulls from the whole charset instead, G5 the output is never shuffled |

## Known and NOT handled (stage 1)

- **Everything is in memory, one process.** No real concurrency, no persistence across a restart, no network.
- **No ownership or multi-user sharing of a vault.** One vault per ownerId; there is no way to give another
  user access to it.
- **`lock()`'s "discard the key" is best-effort.** JavaScript has no way to reliably zero out a `Buffer`'s
  backing memory or guarantee it is not still sitting in some other retained reference (a V8 garbage-collected
  runtime, unlike a language with manual memory management, cannot promise this).
- **No 2FA, no breach-database checking, no password-strength scoring beyond the generator's own charset
  rules.**
- **No rate limiting independent of the vault** (a single very persistent attacker making requests for many
  different ownerIds is not covered -- that is a transport/API-layer concern, same note as the other projects
  here that assume a single caller's behavior, not a whole fleet of them).
