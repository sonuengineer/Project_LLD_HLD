# B5 Password Storage System (low-level design)

A TypeScript library (no runtime dependencies, in memory) for a password manager's vault: a master password
unlocks storage for a user's OTHER credentials, encrypted at rest with AES-256-GCM. There is no UI -- saving
an entry goes through a `VaultStore`, which stage 2 makes a real async call (modeling a disk/network write),
but the only implementation here is in memory.

Status (2026-11-26): stage 1 DONE -- 48 tests, 30 mutation checks, all caught. Stage 2 DONE -- 63 tests, 46
mutation checks, all caught (see "Mutation checks"). Details in [PLAN.md](PLAN.md).

```
npm ci
npm test        # 63 tests
npm run demo    # two devices sharing a vault, a lost session after a password change, an add raced against a rotation
```

## Usage

```ts
const manager = new PasswordManager();
manager.createVault("alice", "correct-horse-battery-staple"); // starts with no active sessions

const phone = manager.unlock("alice", "correct-horse-battery-staple");
const laptop = manager.unlock("alice", "correct-horse-battery-staple"); // a second device, same vault

const entry = await manager.addEntry(phone.sessionId, {
  title: "GitHub",
  username: "alice",
  password: generatePassword({ length: 20 }),
  notes: "2FA via authenticator app",
});

manager.listEntries(laptop.sessionId); // the laptop already sees what the phone just added
manager.getEntry(laptop.sessionId, entry.id).password; // the one call that returns the secret

await manager.changeMasterPassword("alice", "correct-horse-battery-staple", "a-new-master-password");
manager.isSessionActive(laptop.sessionId); // false -- every OTHER session is invalidated by a rotation
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
- **Several devices can each hold their own unlocked session on the same vault.** `unlock()` returns a
  `sessionId`; `lock(sessionId)` closes only that one session, and `isSessionActive(sessionId)` tells you
  whether it is still good.
- **Saving an entry is a real async call to a `VaultStore`**, which is where two devices can genuinely race
  each other. Every mutating call brackets that one `await` with a synchronous claim before it and a
  synchronous apply (or release, on failure) after -- the race is prevented by construction, not a lock.
  `VAULT_BUSY` means an entry operation and a master-password rotation tried to claim the same vault at once;
  `ENTRY_CONFLICT` means two edits to the SAME entry raced and the loser's (already-persisted) write was
  discarded rather than silently clobbering -- or being clobbered by -- the winner's.
- **`changeMasterPassword` re-encrypts every entry under a new key, all at once, excluding (and excluded by)
  any in-flight add/update/delete.** Every entry is decrypted with the old key and re-encrypted with the new
  one into a fresh map; the vault's salt, canary and entries are reassigned only after that commit succeeds.
  A wrong old password, a conflicting in-flight entry op, or any other failure changes nothing.
  **Every OTHER session is invalidated immediately** (a `generation` counter bumped on rotation, checked
  lazily against what each session captured at unlock time) -- closing the gap where a stale session could
  otherwise keep writing entries encrypted under a key the vault no longer matches.
- **A hung store call times out (`STORE_TIMEOUT`) instead of hanging forever**, via the same
  `withTimeout`/`AbortSignal` idiom as `17-parking-lot`'s device calls -- and whatever claim it was holding is
  still released, so one stuck commit cannot wedge the vault for every later caller.
- **`exportVault` returns ciphertext only, and works regardless of session state.** A vault backup should not
  itself require the master password; this call never decrypts anything.
- **`listEntries` never returns a password; `getEntry` does, and marks that entry as used.** Listing is meant
  to be cheap and safe to show on screen; reading one entry's password is the one call that actually reveals it.
- **An error means nothing happened**, with deliberate exceptions: a WRONG unlock/`changeMasterPassword`
  attempt records itself (that count is the point of lockout), and `VAULT_BUSY`/`ENTRY_CONFLICT` exist
  specifically to tell a caller "someone else got there first" instead of silently losing their change.

## Design choices

See [PLAN.md](PLAN.md) for the reasoning behind each choice. In short:

- Node's built-in `crypto` (scrypt + AES-256-GCM) instead of a third-party crypto package -- audited, already
  in the runtime, and enough for everything this project needs.
- A single encrypted blob per entry instead of separately-encrypted fields -- there is no requirement to
  search or sort by title/username without unlocking first, so there is nothing to gain from splitting it, and
  splitting it would mean more IVs and more ciphertexts to keep in sync on every write.
- The race between an add and a rotation is prevented with two plain counters (`rotating`,
  `pendingEntryOps`) bracketing each operation's one `await`, mirrored from `17-parking-lot`'s reserve/confirm
  -- not a mutex library, not retries, not a database transaction. The claim and its release are both
  synchronous, so the exclusion is a property of JavaScript's execution model, not of anything that needs its
  own correctness proof.
- Not used on purpose: a separate stored hash of the master password (the canary does that job with one KDF,
  not two secrets to keep in sync), `Math.random()` anywhere near a secret, deleting entries on a failed
  `changeMasterPassword` before re-encryption is known to have fully succeeded, eagerly walking and revoking
  every session on a rotation (the lazy `generation` check does the same job without that walk).

## Tests

| File | Tests | What |
|---|---|---|
| test/crypto.test.ts | 8 | `deriveKey` determinism and salt-sensitivity, encrypt/decrypt round-trip, a fresh IV every call, wrong key and tampered ciphertext/authTag/IV all fail authentication |
| test/vault.test.ts | 13 | `createVault` validation and dedup, multiple independent sessions on one vault, locking one session leaves others active, wrong-password lockout (triggering it, the cooldown boundary, the counter resetting on cooldown AND on success), unknown owner/session |
| test/entries.test.ts | 10 | add/get/list/update/delete, field length boundaries (exact max accepted, max+1 rejected), `listEntries` never includes a password, `getEntry` bumps `lastUsedAt`, an invalid patch changes nothing, requires an active session |
| test/change-password.test.ts | 7 | re-encrypts every entry and the old password stops working, the NEW salt/canary (not the old one) is what gets persisted, invalidates every other session immediately, works without an active session, a wrong old password changes nothing, shares the same lockout as `unlock()`, rejects too-short new passwords |
| test/export.test.ts | 3 | works regardless of session state, contains no plaintext secret/title/username/master-password, shape of the raw export |
| test/generator.test.ts | 7 | default/explicit length bounds, disabling a class excludes it, enabling one guarantees at least one instance of it, disabling every class throws, the guaranteed characters are not pinned to fixed positions (the result is shuffled) |
| test/invariants.test.ts | 4 | randomized, 4 seeds x 150 SEQUENTIAL operations (add/update/delete/get/lock/unlock-correct/unlock-wrong/change-password/advance-clock) against a shadow model that independently re-derives the lockout gate; checked at every step: entry count, session validity, and that no secret ever used so far appears in the raw export |
| test/concurrency.test.ts | 11 | the actual races: two devices adding at once (nothing lost), add-vs-rotation and rotation-vs-add both reject with `VAULT_BUSY` and neither side loses data, two concurrent rotations (`VAULT_BUSY`), two devices editing the SAME entry (`ENTRY_CONFLICT` for the loser), update-vs-delete and delete-vs-delete on the same entry (`UNKNOWN_ENTRY` for the loser), a hung store times out (custom and default timeout) and releases its claim, a successful commit clears its timeout timer, and a standalone illustration of the un-guarded version of the bug |

## Mutation checks

76 deliberate breaks total across both stages (`src/manager.ts`, `src/crypto.ts`, `src/generator.ts`,
`src/timeout.ts`), each applied alone with the suite run against it, the file restored byte for byte. 76 of 76
caught. Stage 1's check found one unreachable dead-code guard, removed rather than tested (see stage 1 notes
below). Stage 2's check found three real, genuine gaps, each closed with a new test rather than dismissed:

- **A double-delete race** (`S16`): the re-check after a delete's commit, for whether the entry was already
  removed by a concurrent delete, was never exercised by any existing test -- every prior delete test had
  exactly one caller. Closed with a two-devices-delete-the-same-entry test.
- **A persisted-snapshot bug** (`S22`): `changeMasterPassword` was correctly updating the in-memory vault's
  salt/canary, but the snapshot handed to the store for that same commit could have used the OLD salt/canary --
  no existing test ever inspected what was actually durably saved, only the in-memory result afterward. A
  crash right after that commit (before the in-memory assignment) would have left a durably-saved vault whose
  entries were re-encrypted under the new key but whose salt/canary still pointed at the old one, making it
  unreadable under either password. Closed with a test that reads the store's last-persisted snapshot
  directly and compares it against the live vault.
- **A leaked timer** (`W3`): a successful commit never called `clearTimeout` on its deadline timer in
  `withTimeout`'s `finally`. No existing test asserted anything about timer cleanup. Closed with a
  `vi.getTimerCount()` check after a successful commit under fake timers.

| Area | Breaks |
|---|---|
| createVault / requireVault / requireSession | V1 duplicate-vault check removed, S1 unknown-owner check removed, S2 unknown-session check removed, S3 session-generation mismatch never detected, S4 lock() on an already-closed session never throws, S5 isSessionActive() ignores generation |
| claimEntryOp | S6 rotating check removed, S7 pendingEntryOps never incremented |
| addEntry | S8 the claim is never released, S9 the entry is never applied after a successful commit, S10 the id counter never advances (colliding ids) |
| updateEntry | S11 the captured version is hardcoded instead of read live, S12 the version is never actually bumped, S13 the conflict check removed, S14 the deleted-while-in-flight check removed, S15 the update is never applied after a successful commit |
| deleteEntry | S16 the already-deleted re-check removed |
| changeMasterPassword | S17/S18 the two busy checks removed, S19 the rotating flag is never set, S20 the rotating flag is never cleared, S21 the generation counter never advances, S22 the persisted snapshot uses the OLD salt/canary, S23/S24 the new entries/salt/canary are never actually assigned |
| lockout (carried over) | L1 cooldown gate bypassed, L2 lockout threshold never trips, L3 failed attempts never counted, L4 the counter is not reset on a successful unlock, L5 the counter is not reset once the cooldown elapses, L6 off-by-one on the minimum master-password length |
| validation (carried over) | R1 off-by-one on a field's max length, R2 the empty-string check removed |
| isolation (carried over) | E5 listEntries leaks a password, E6 updateEntry's title patch skips validation |
| timeout.ts | W1 a timeout is never distinguished from any other failure, W2 the store call is never actually aborted, W3 a successful commit leaks its timer |
| crypto.ts (carried over) | K1 deriveKey ignores the salt, K2 encrypt reuses a fixed IV, K3 decrypt never checks the auth tag |
| generator.ts (carried over) | G1 off-by-one on the max generated length, G2 the empty-charset check removed, G4 the guaranteed-one-per-class draw pulls from the whole charset instead, G5 the output is never shuffled |

### Stage 1 notes (kept for history)

One stage-1 check found a real (harmless) design issue, not a test gap: a `pools.length > length` guard in
the generator was unreachable dead code, since there are at most 4 character classes and
`MIN_GENERATED_LENGTH` is already 4 -- `length` can never be smaller than the number of enabled classes. The
guard was removed rather than writing a test for a path that cannot occur.

## Known and NOT handled (stage 2)

- **Everything is in memory, one process.** The `VaultStore` abstraction exists so a real disk/network
  backend could be dropped in, but no such backend is implemented here; nothing survives a restart.
- **No ownership or multi-user sharing of a vault.** One vault per ownerId; there is no way to give another
  user access to it, and no cross-device conflict resolution beyond the per-entry version check.
- **`lock()`'s "discard the key" is best-effort.** JavaScript has no way to reliably zero out a `Buffer`'s
  backing memory or guarantee it is not still sitting in some other retained reference.
- **No automatic retry on `VAULT_BUSY`/`ENTRY_CONFLICT`.** The caller is told someone else got there first and
  must decide whether to retry; this project does not do that for them.
- **No 2FA, no breach-database checking, no password-strength scoring beyond the generator's own charset
  rules, no session expiry on a timer.**
- **No rate limiting independent of the vault** (a single very persistent attacker making requests for many
  different ownerIds is not covered -- that is a transport/API-layer concern, same note as the other projects
  here that assume a single caller's behavior, not a whole fleet of them).
