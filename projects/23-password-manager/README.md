# B5 Password Storage System (low-level design)

A TypeScript library (in memory) for a password manager's vault: a master password unlocks storage for a
user's OTHER credentials, encrypted at rest with AES-256-GCM. The library itself (`src/manager.ts` and
everything it imports) has zero runtime dependencies; the optional HTTP layer added in stage 7 is the one
place this project depends on anything external (Express). There is no UI -- saving an entry goes through a
`VaultStore`, which stage 2 makes a real async call (modeling a disk/network write), but the only
implementation here is in memory. Stage 3 adds breach checking against a fake (but protocol-real)
k-anonymity provider, guarded by a timeout and circuit breaker so that service can never block a save. Stage
4 adds sharing a single entry between two INDEPENDENT vaults, via hybrid/envelope encryption (RSA-OAEP +
AES-256-GCM) -- neither vault ever sees the other's master password or vault key. Stage 5 makes a share
revocable by its issuer and single-use, so it cannot be redeemed twice. Stage 6 makes a session auto-lock
after a period of inactivity. Stage 7 adds an HTTP API in front of the whole library.

Status (2026-11-26): stage 1 DONE -- 48 tests, 30 mutation checks, all caught. Stage 2 DONE -- 63 tests, 46
mutation checks, all caught. Stage 3 DONE -- 90 tests, 17 new mutation checks, all caught. Stage 4 DONE --
106 tests, 13 new mutation checks, all caught. Stage 5 DONE -- 113 tests, 8 new mutation checks, all caught.
Stage 6 DONE -- 122 tests, 7 new mutation checks, all caught. Stage 7 DONE -- 140 tests, 7 new mutation
checks, all caught (see "Mutation checks"). Details in [PLAN.md](PLAN.md).

Seven substantial, distinct stages are now done -- the natural next step for this project is an interview
question bank and a portfolio entry, not an eighth feature stage.

```
npm ci
npm test        # 140 tests
npm run demo    # two devices sharing a vault, a lost session after a password change, an add raced against a rotation, breach checking, sharing an entry between two vaults, revoking a share, idle auto-lock
npm start       # the HTTP API on http://127.0.0.1:3000 (needs PASSWORD_MANAGER_API_KEY in the environment)
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

// Every add/update is checked against a (fake, in-memory) breach-check provider automatically:
const fresh = manager.unlock("alice", "a-new-master-password");
const weak = await manager.addEntry(fresh.sessionId, { title: "Old site", username: "alice", password: "qwerty123" });
weak.breached; // true
await manager.checkBreach("qwerty123"); // true -- also usable standalone, like generatePassword()

// Sharing one entry with a completely independent vault -- neither side ever sees the other's master
// password, vault key, or private key:
manager.createVault("dave", "daves-master-password-123");
const dave = manager.unlock("dave", "daves-master-password-123");
const davePublicKey = await manager.getSharingPublicKey(dave.sessionId); // dave hands this to alice, out of band
const token = manager.shareEntry(fresh.sessionId, weak.id, davePublicKey); // alice seals it for dave; pure, synchronous crypto
const redeemed = await manager.redeemShare(dave.sessionId, token); // dave unwraps it with his OWN private key
manager.getEntry(dave.sessionId, redeemed.id); // dave's own, independent copy of alice's entry

// Shares are single-use and revocable:
await manager.redeemShare(dave.sessionId, token); // throws SHARE_ALREADY_REDEEMED -- already used once
const another = manager.shareEntry(fresh.sessionId, weak.id, davePublicKey);
manager.revokeShare(fresh.sessionId, another.shareId); // alice changes her mind before dave redeems it
await manager.redeemShare(dave.sessionId, another); // throws SHARE_REVOKED

// Sessions auto-lock after a period of inactivity (default 15 minutes), checked lazily on next use:
const idleManager = new PasswordManager({ sessionIdleTimeoutMs: 5 * 60 * 1000 });
// ... after 5+ minutes of no activity on a session ...
idleManager.isSessionActive(someSessionId); // false
idleManager.listEntries(someSessionId); // throws SESSION_IDLE_TIMEOUT
```

### Over HTTP

```
POST /vaults                                      { ownerId, masterPassword }   -> 201 VaultSummary
POST /vaults/:ownerId/unlock                       { masterPassword }           -> 200 UnlockResult
POST /sessions/:sessionId/entries                  EntryInput                   -> 201 EntrySummary
GET  /sessions/:sessionId/entries/:entryId                                      -> 200 EntryDetail
POST /sessions/:sessionId/entries/:entryId/share   { recipientPublicKey }       -> 201 SharedEntryToken
POST /sessions/:sessionId/shares/redeem            SharedEntryToken             -> 201 EntrySummary
```

Every route (full list in `src/http/app.ts`) needs `Authorization: Bearer <PASSWORD_MANAGER_API_KEY>`; every
error comes back as `{ "error": { "code", "message" } }` with the status from the table in "The rules" below.

```bash
PASSWORD_MANAGER_API_KEY=a-long-random-string npm start
curl -X POST localhost:3000/vaults -H "Authorization: Bearer a-long-random-string" \
  -H "Content-Type: application/json" -d '{"ownerId":"alice","masterPassword":"correct-horse-battery"}'
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
- **Every saved or changed password is checked against a breach-check provider using k-anonymity**: only the
  first 5 hex characters of its SHA-1 hash ever leave the vault (`isPasswordBreached`/`FakeBreachProvider` in
  `src/breach.ts`) -- the same protocol Have I Been Pwned's real password API uses, even though the provider
  here is a small, fixed, explicitly-fake in-memory dataset, not a real network call.
- **A breach check can NEVER block a save -- the opposite instinct from "an error means nothing happened,"
  deliberately.** `BreachChecker.check()` never throws: a provider error, a timeout, or an open circuit
  breaker all degrade to `breached: null` ("unknown"), and the entry is saved regardless. A non-critical
  dependency must never be able to stop someone from saving a password.
- **An error means nothing happened**, with deliberate exceptions: a WRONG unlock/`changeMasterPassword`
  attempt records itself (that count is the point of lockout), `VAULT_BUSY`/`ENTRY_CONFLICT` exist
  specifically to tell a caller "someone else got there first" instead of silently losing their change, and a
  breach-check failure is the one case where a would-be error is deliberately swallowed instead of surfaced.
- **One entry can be shared with a completely independent vault via hybrid (envelope) encryption.** Each
  vault lazily generates its own RSA keypair (`getSharingPublicKey`, only on first use -- a 2048-bit keypair
  costs about 200ms to generate). `shareEntry` decrypts with the sender's own key and re-encrypts under a
  fresh one-time AES key wrapped for the recipient's public key, producing a self-contained token; it needs
  no commit, since nothing about the sender's vault changes. `redeemShare` unwraps that token with the
  recipient's own private key and adds the result through the recipient's ordinary `addEntry` -- so a shared
  credential gets the exact same claim/commit exclusion and the exact same breach check (against the
  RECIPIENT's own configuration) as any other entry, automatically.
- **The sharing keypair's private key is re-wrapped on every `changeMasterPassword`, exactly like every
  entry.** Skipping this would silently and permanently brick sharing the moment the vault's owner changes
  their password -- the private key would still be "encrypted," just under a key the vault's canary no
  longer matches.
- **A share is single-use and revocable.** Every `shareEntry` registers a grant, tracked manager-wide (like
  `sessions`, not inside any vault's own storage). `redeemShare` claims it SYNCHRONOUSLY, before any `await`
  -- the identical claim-before-await shape `claimEntryOp` uses for entries, now protecting a different
  resource -- so two concurrent redemptions of the same token can never both succeed. A precondition failure
  (`NO_SHARING_KEY`) is checked and thrown BEFORE that claim, since it is not a real attempt; a genuine
  failure AFTER claiming (a wrong-recipient token, or the recipient's own `VAULT_BUSY`) releases it, so a
  real retry still gets its one legitimate shot. `revokeShare` reports an unknown shareId and someone else's
  shareId identically (`UNKNOWN_SHARE`) -- the same don't-leak-existence instinct as not telling a failed
  login which part was wrong.
- **A session auto-locks after `sessionIdleTimeoutMs` of inactivity (default 15 minutes), checked LAZILY on
  next use -- never a background timer.** `requireSession` is the single choke point every session-based
  call already goes through, so it both checks the idle deadline and resets it on success; `isSessionActive`
  is a pure read and never resets the clock itself, since a status check that could keep a session alive by
  being polled would defeat the whole point. Each session has its own independent idle clock, so one idle
  device does not affect another device's active session on the same vault.
- **The HTTP API authenticates SERVICES, not end users, with one bearer API key** -- the same scope
  `21-notification`'s API has. Every `PasswordManagerErrorCode` maps to a specific HTTP status (table
  below); none of them maps to `500` -- every one is an expected, documented outcome, and `500` is reserved
  for a genuine bug (logged server-side, never echoed to the caller).

| Code | Status | | Code | Status |
|---|---|---|---|---|
| `INVALID_REQUEST` | 400 | | `VAULT_BUSY` | 409 |
| `UNKNOWN_OWNER` | 404 | | `ENTRY_CONFLICT` | 409 |
| `VAULT_ALREADY_EXISTS` | 409 | | `STORE_TIMEOUT` | 503 |
| `INVALID_MASTER_PASSWORD` | 401 | | `NO_SHARING_KEY` | 409 |
| `LOCKED_OUT` | 423 | | `UNKNOWN_SHARE` | 404 |
| `UNKNOWN_ENTRY` | 404 | | `SHARE_REVOKED` | 410 |
| `DECRYPTION_FAILED` | 400 | | `SHARE_ALREADY_REDEEMED` | 409 |
| `UNKNOWN_SESSION` | 401 | | `SESSION_IDLE_TIMEOUT` | 401 |
| `SESSION_INVALIDATED` | 401 | | | |

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
- A self-contained circuit breaker (`src/circuit-breaker.ts`) instead of importing one from this repo's other
  resilience-themed projects -- every project here is its own standalone package, and the breaker needed for
  breach-checking is small enough that writing it directly (same spirit as `timeout.ts`) beats wiring up a
  cross-project dependency.
- RSA-OAEP (hybrid/envelope encryption) over hand-rolling an ECIES-style scheme on an elliptic curve: Node
  supports `publicEncrypt`/`privateDecrypt` directly, with no extra key-derivation logic to get right, at the
  cost of a slower (but one-time, lazy) keypair generation -- a reasonable trade for a project optimizing for
  a correct, well-understood implementation over raw key-generation speed.
- `redeemShare` reuses `addEntry` wholesale instead of writing its own insertion logic -- a shared credential
  is, from the recipient's point of view, just a new entry whose plaintext happened to come from an envelope
  instead of a form field; duplicating `addEntry`'s claim/commit/breach-check logic for this one caller would
  be the same bug risk twice, for no benefit.
- Share grants live in a manager-wide map, not inside any `VaultRecord` -- they are metadata ABOUT a
  transaction between two vaults, not content belonging to either one, the same reasoning that already put
  `sessions` at the manager level instead of per-vault.
- Idle session expiry is lazy (checked at `requireSession`), not a scheduled sweep -- consistent with every
  other time-based check in this project (the lockout cooldown, `SESSION_INVALIDATED`); a background job
  that proactively walks every session would be more code for a guarantee nothing here actually needs
  (nobody is harmed by an idle session sitting unnoticed until its next use attempt).
- Express 4, matched exactly to `21-notification`'s pinned version, over Express 5 or a different framework
  -- consistency across this repo's HTTP layers matters more than any one project picking its own stack, and
  it is also WHY `asyncRoute()` exists here at all: Express 5 routes a rejected promise to the error handler
  automatically, Express 4 does not.
- No field-level validation duplicated between the HTTP layer and the library -- a body field is read and
  handed straight to the matching `PasswordManager` method, which already validates its own inputs. The one
  deliberate exception is `POST .../shares/redeem`'s body shape, which the library has no equivalent check
  for (it only ever receives a token already structurally valid, from `shareEntry`'s own return value).

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
| test/breach.test.ts | 6 | `sha1Hex` matches a well-known public value and is deterministic, `FakeBreachProvider` returns the right suffix (and nothing for an unrelated prefix, and throws on an already-aborted signal), `isPasswordBreached` is true/false correctly and -- via a spy provider -- never sends more than a 5-character prefix, never the password or the full hash |
| test/circuit-breaker.test.ts | 6 | starts closed, opens after the failure threshold (and never even calls `fn()` while open), fewer-than-threshold failures never open it, a success resets the failure counter, a half-open trial after the cooldown closes on success and re-opens (with a fresh cooldown) on failure |
| test/breach-checker.test.ts | 5 | true/false for the real k-anonymity call, a throwing provider and a provider that never responds both degrade to `null` instead of throwing or hanging, defaults to `DEFAULT_BREACH_CHECK_TIMEOUT_MS` when none is given, the circuit opening makes later checks fail fast without even calling the provider again |
| test/breach-integration.test.ts | 10 | the manager's own zero-config defaults correctly detect a known-breached password end to end, `addEntry`/`updateEntry` set `breached` and only re-check when the password field actually changes, `listEntries` surfaces it without a `getEntry` call, a broken provider never blocks a save, `checkBreach` as a standalone utility (including its own input validation), the `breached` flag never appears in the clear in `exportVault`'s output |
| test/sharing.test.ts | 7 | `generateSharingKeyPair` produces valid, non-colliding PEM keys, `sealForRecipient`/`openAsRecipient` round-trip the exact plaintext, a different recipient's private key cannot open it, a tampered blob or wrappedKey fails, an invalid public key is rejected up front, the same plaintext sealed twice never produces the same token |
| test/sharing-integration.test.ts | 9 | `getSharingPublicKey` lazily generates once and is idempotent on repeat calls, excluded by an in-progress rotation, a full share/redeem round trip between two independent vaults (including deleting the recipient's copy not touching the sender's), the token never contains the plaintext in the clear, breach status is re-checked against the RECIPIENT's own config, `NO_SHARING_KEY` is checked before the one-time claim (repeating the attempt proves it was not consumed), a token meant for someone else throws `DECRYPTION_FAILED` and does NOT consume the share (the real recipient can still redeem it afterward), sharing still works after the sender rotates their master password, and the re-wrapped private key (not the old one) is what actually gets persisted |
| test/share-revocation.test.ts | 7 | a revoked share can no longer be redeemed, an unknown shareId and someone else's shareId both throw `UNKNOWN_SHARE` (and a failed revoke attempt does not revoke it), revoking twice (or revoking an already-redeemed share) is a harmless no-op, a forged shareId throws `UNKNOWN_SHARE`, a share is single-use (`SHARE_ALREADY_REDEEMED` on the second attempt, no duplicate entry), two concurrent redemptions of the same token: exactly one succeeds |
| test/session-idle-timeout.test.ts | 9 | idle longer than the timeout throws `SESSION_IDLE_TIMEOUT`, right-at-the-boundary usage stays active, using a session repeatedly resets its idle clock indefinitely, `isSessionActive` reports it without a throwing call first, polling `isSessionActive` does NOT itself reset the clock, two sessions on one vault have independent idle clocks, a freshly unlocked session's clock starts at unlock time (not some earlier moment), defaults to `DEFAULT_SESSION_IDLE_TIMEOUT_MS` when none is given, a timed-out session is cleaned up and reports `UNKNOWN_SESSION` (not another timeout) on a second touch |
| test/http.test.ts | 18 | auth (missing/wrong API key, too-short apiKey rejected at startup), full vault lifecycle over HTTP (create/read/409 on duplicate/404 on unknown/unlock/wrong-password 401/lockout 423/rotate/export with no plaintext leak), full entry CRUD over HTTP, lock + session status, a complete share/redeem/revoke flow between two sessions, a malformed redeem body is 400 not a crash, breach-check, idle timeout reported and enforced over HTTP, an unknown route (404), wrong Content-Type (415), malformed JSON (400), an oversized body (413), an unexpected library-independent error maps to 500 and is logged rather than leaked to the caller |

## Mutation checks

128 deliberate breaks total across all seven stages (`src/manager.ts`, `src/crypto.ts`, `src/generator.ts`,
`src/timeout.ts`, `src/breach.ts`, `src/circuit-breaker.ts`, `src/breach-checker.ts`, `src/sharing.ts`,
`src/http/app.ts`), each applied alone with the suite run against it, the file restored byte for byte. 128 of
128 caught (one more attempted break, on the revocation wiring, turned out to be malformed rather than a
real mutation -- see the stage 5 note below -- and was discarded rather than counted). Stage 1's check found
one unreachable dead-code guard, removed rather than tested (see stage 1 notes below). Stage 2's check found
three real, genuine gaps, each closed with a new test rather than dismissed:

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

Stage 3's check found two more genuine gaps:

- **A success never reset the circuit breaker's failure counter** (`CB2`): every existing test's failure
  count either stayed well under the threshold or was pushed straight through it, so nothing distinguished
  "the counter resets on success" from "it just happens to not have reached the threshold yet." Closed with a
  test that runs two failures, one success, then one more failure, and checks the circuit is still closed
  (it would read as 3 failures and open if the reset had not happened).
- **The default breach-check timeout was never actually verified** (`BK4`): every existing test either used
  a provider that resolved almost immediately (so any timeout value, including 0, would "work") or passed an
  explicit `timeoutMs`. Closed with a fake-timers test that confirms a call is still pending just under
  `DEFAULT_BREACH_CHECK_TIMEOUT_MS` and settles once that deadline passes.

Stage 4's check (13 breaks across the new sharing wiring) found no survivors on the first run -- the
dedicated round-trip tests (both vaults' crypto, and the end-to-end share/redeem path) already happened to
cover every one of them.

Stage 5's check (the revocation/single-use wiring) attempted 9 breaks; 8 were caught, and the 9th (reordering
the `NO_SHARING_KEY` check relative to the claim) was discovered to be a malformed mutation, not a real gap:
the existing, unrelated `NO_SHARING_KEY` check a few lines earlier already made the moved copy unreachable --
nothing in `record.wrappedPrivateKey` can change between the two checks, so no test could ever observe a
difference. It was discarded rather than given a test for a code path that provably cannot differ, the same
principle as the stage-1 dead-code guard.

Stage 6's check (the idle-timeout wiring, 7 breaks) found no survivors on the first run -- the dedicated
boundary tests (exactly-at-the-deadline, repeated activity resetting the clock, polling never resetting it)
already happened to cover every one of them.

Stage 7's check (`src/http/app.ts`, 7 breaks) also found no survivors on the first run.

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
| manager.ts breach wiring | B1 checkBreach's own input validation removed, B2 updateEntry's re-check-only-if-password-changed condition inverted, B3 `breached` is never surfaced in a summary, B4 addEntry never actually uses the computed breach result |
| breach.ts | BR1 the wrong hash algorithm, BR2 a 6-character prefix sent instead of 5, BR3 the breached/clean comparison inverted, BR4 the already-aborted-signal check removed |
| circuit-breaker.ts | CB1 the opening condition removed, CB2 a success never resets the failure counter, CB3 the cooldown-elapsed comparison inverted, CB4 `fn()` still gets called while open, CB5 `openedAt` never actually recorded (circuit never reaches half-open) |
| breach-checker.ts | BK1 the catch-and-degrade-to-null removed, BK2 the default provider never falls back, BK3 the default breaker never falls back, BK4 the default timeout never falls back |
| manager.ts sharing wiring | SH1 the idempotency check removed (re-generates a keypair every call), SH2/SH3 the new public/private key is never actually applied after a successful commit, SH4 the NO_SHARING_KEY check removed, SH5 shareEntry seals an empty body instead of the real one, SH6 redeemShare swaps username and password, SH7 the private key is never re-wrapped during a rotation, SH8 the re-wrapped key is never actually applied, SH9/SH10 the sharing-key fields are dropped from the persisted snapshot / `exportVault` |
| sharing.ts | SG2 the one-time AES key is the wrong length for AES-256, SG3 an invalid recipient key is never translated into `INVALID_REQUEST`, SG4 a failed unwrap is never translated into `DECRYPTION_FAILED` |
| manager.ts revocation/single-use wiring | RV1 shareEntry never registers the grant, RV2 revokeShare's ownership check removed, RV3 revoking never actually sets revoked, RV4 redeemShare's unknown-share check removed, RV5 the revoked check removed, RV6 the already-redeemed check removed, RV8 the claim is never set (no single-use at all), RV9 a failed redemption never releases its claim |
| manager.ts idle-timeout wiring | IT1 a new session's idle clock starts at an arbitrary fixed time instead of now, IT2/IT7 `isSessionActive`'s idle check removed or off-by-one, IT3 the idle-expiry check in `requireSession` removed, IT4 using a session never resets its idle clock, IT5 off-by-one on the idle deadline (exact-boundary usage incorrectly rejected), IT6 the default idle timeout never falls back |
| http/app.ts | H1 the API-key check removed, H2 the key comparison accepts ANY Bearer value, H3 the Content-Type check removed, H4 the redeem-body shape check removed, H5 a status-code mapping entry wrong, H6 the catch-all 404 route returns 200 instead, H7 `asyncRoute`'s `.catch(next)` removed (an async route's error would hang instead of responding) |

### Stage 1 notes (kept for history)

One stage-1 check found a real (harmless) design issue, not a test gap: a `pools.length > length` guard in
the generator was unreachable dead code, since there are at most 4 character classes and
`MIN_GENERATED_LENGTH` is already 4 -- `length` can never be smaller than the number of enabled classes. The
guard was removed rather than writing a test for a path that cannot occur.

## Known and NOT handled (stage 7)

- **Everything is in memory, one process.** The `VaultStore` abstraction exists so a real disk/network
  backend could be dropped in, but no such backend is implemented here; nothing survives a restart --
  including the `shares` grant registry and session idle clocks, same as `sessions` itself.
- **No ownership or multi-user sharing of a VAULT itself.** One vault per ownerId; sharing is per-entry, via
  an explicit token, not "give someone access to my whole vault."
- **No directory service for exchanging public keys.** Callers are responsible for getting the recipient's
  public key to the sender out of band; this project does not model how that handoff happens.
- **Revocation and single-use only stop a share BEFORE it is redeemed.** Once `redeemShare` succeeds, the
  recipient's copy is theirs permanently and independently -- there is no way to reach into their vault and
  take it back, and no expiry on time, only on first use or explicit revocation.
- **`lock()`'s "discard the key" is best-effort.** JavaScript has no way to reliably zero out a `Buffer`'s
  backing memory or guarantee it is not still sitting in some other retained reference.
- **No automatic retry on `VAULT_BUSY`/`ENTRY_CONFLICT`.** The caller is told someone else got there first and
  must decide whether to retry; this project does not do that for them.
- **`FakeBreachProvider` is a small, fixed, explicitly-fake in-memory dataset -- not a real breach database,
  and not a real network call.** The k-anonymity protocol it speaks is real; the data behind it is not.
- **No 2FA, no password-strength scoring beyond the generator's own charset rules.**
- **Idle expiry is lazy, not proactive.** A session past its idle timeout is only ever noticed the next time
  it is actually used (or `isSessionActive` is checked) -- it keeps occupying memory in the `sessions` map
  until then, rather than being swept away the instant it goes idle. For this project's scale, that is a
  reasonable trade, not a bug.
- **No rate limiting independent of the vault** (a single very persistent attacker making requests for many
  different ownerIds is not covered -- that is a transport/API-layer concern, same note as the other projects
  here that assume a single caller's behavior, not a whole fleet of them).
- **The HTTP API has no CORS, no per-end-user session/cookie layer, and no rate limiting of its own.** It
  authenticates services with one API key, the same scope `21-notification`'s API has; a real deployment
  would put this behind its own backend, not expose it straight to a browser.
- **No URL-encoding beyond what Express's own router handles** for ids placed in a `Location` header; an id
  containing characters that need escaping (none of this project's own generated ids ever do) is not
  specifically tested at the HTTP layer.
