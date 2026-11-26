// Randomized: unlock/lock, wrong-password lockout, entry CRUD and master-password changes, checked at every
// step against a shadow model re-derived independently here, not taken from src/. Every operation is awaited
// before the next one starts, so this is a sequential walk (stage 2's actual concurrency is covered by its
// own dedicated tests in concurrency.test.ts) -- the point here is that the async, session-based API behaves
// exactly like the stage-1 API did when nothing overlaps.
import { describe, expect, it } from "vitest";
import { LOCKOUT_MS, MAX_FAILED_ATTEMPTS } from "../src/manager.js";
import { setup, T0 } from "./helpers.js";

function prng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface ShadowEntry {
  title: string;
  username: string;
  password: string;
  notes: string;
}

for (const seed of [1, 2, 3, 4]) {
  it(`seed ${seed}: 150 random operations against a shadow model, including lockout and master-password changes`, async () => {
    // scrypt is deliberately slow; 150 ops with repeated unlock/changeMasterPassword calls can take a few
    // seconds, well past vitest's 5s default.
    const rand = prng(seed);
    const { manager, clock } = setup();
    const OWNER = "alice";
    let masterPassword = "initial-master-password";
    manager.createVault(OWNER, masterPassword);

    const shadow = {
      sessionId: null as string | null,
      failedAttempts: 0,
      lockedUntil: null as number | null,
      entries: new Map<string, ShadowEntry>(),
    };
    const neverLeak = new Set<string>([masterPassword]);
    let nextPasswordVersion = 1;

    // Mirrors manager.ts's verifyMasterPassword exactly: the lockout gate, then the pass/fail outcome.
    function shadowVerify(candidate: string): "OK" | "LOCKED_OUT" | "INVALID_MASTER_PASSWORD" {
      const now = clock.now();
      if (shadow.lockedUntil !== null) {
        if (now < shadow.lockedUntil) return "LOCKED_OUT";
        shadow.lockedUntil = null;
        shadow.failedAttempts = 0;
      }
      if (candidate === masterPassword) {
        shadow.failedAttempts = 0;
        shadow.lockedUntil = null;
        return "OK";
      }
      shadow.failedAttempts++;
      if (shadow.failedAttempts >= MAX_FAILED_ATTEMPTS) shadow.lockedUntil = now + LOCKOUT_MS;
      return "INVALID_MASTER_PASSWORD";
    }

    function errCode(fn: () => unknown): string {
      try {
        fn();
        return "NO_ERROR";
      } catch (err) {
        return (err as { code?: string }).code ?? "UNKNOWN_ERROR";
      }
    }

    async function asyncErrCode(fn: () => Promise<unknown>): Promise<string> {
      try {
        await fn();
        return "NO_ERROR";
      } catch (err) {
        return (err as { code?: string }).code ?? "UNKNOWN_ERROR";
      }
    }

    function assertNeverLeaked() {
      const dump = JSON.stringify(manager.exportVault(OWNER));
      for (const secret of neverLeak) expect(dump).not.toContain(secret);
    }

    for (let step = 0; step < 150; step++) {
      const r = rand();
      const entryIds = [...shadow.entries.keys()];
      const session = shadow.sessionId;

      if (r < 0.3 && session) {
        // add
        const entry: ShadowEntry = {
          title: `title-${seed}-${step}`,
          username: `user-${seed}-${step}`,
          password: `pw-${seed}-${step}-${Math.floor(rand() * 1e9)}`,
          notes: rand() < 0.5 ? `notes-${seed}-${step}` : "",
        };
        const summary = await manager.addEntry(session, entry);
        shadow.entries.set(summary.id, entry);
        neverLeak.add(entry.title).add(entry.username).add(entry.password);
        if (entry.notes) neverLeak.add(entry.notes);
      } else if (r < 0.45 && session && entryIds.length > 0) {
        // update
        const id = entryIds[Math.floor(rand() * entryIds.length)]!;
        const existing = shadow.entries.get(id)!;
        const patch: Partial<ShadowEntry> = { password: `pw-updated-${seed}-${step}-${Math.floor(rand() * 1e9)}` };
        await manager.updateEntry(session, id, patch);
        const merged = { ...existing, ...patch };
        shadow.entries.set(id, merged);
        neverLeak.add(merged.password);
      } else if (r < 0.55 && session && entryIds.length > 0) {
        // delete
        const id = entryIds[Math.floor(rand() * entryIds.length)]!;
        await manager.deleteEntry(session, id);
        shadow.entries.delete(id);
      } else if (r < 0.7 && session && entryIds.length > 0) {
        // get, and check it matches the shadow exactly
        const id = entryIds[Math.floor(rand() * entryIds.length)]!;
        const detail = manager.getEntry(session, id);
        const expected = shadow.entries.get(id)!;
        expect(detail).toMatchObject(expected);
      } else if (r < 0.78 && session) {
        // lock
        manager.lock(session);
        shadow.sessionId = null;
      } else if (r < 0.9) {
        // unlock with the CORRECT current password
        const outcome = shadowVerify(masterPassword);
        if (outcome === "OK") {
          shadow.sessionId = manager.unlock(OWNER, masterPassword).sessionId;
        } else {
          expect(errCode(() => manager.unlock(OWNER, masterPassword))).toBe(outcome);
        }
      } else if (r < 0.96) {
        // unlock with a WRONG password -- exercises (and can trigger) lockout
        const wrong = `${masterPassword}-WRONG-${step}`;
        const outcome = shadowVerify(wrong);
        expect(outcome).not.toBe("OK"); // guaranteed different from masterPassword by construction
        expect(errCode(() => manager.unlock(OWNER, wrong))).toBe(outcome);
      } else if (r < 0.985) {
        // change the master password (always with the correct, currently-known old password)
        const outcome = shadowVerify(masterPassword);
        if (outcome === "OK") {
          const newPassword = `master-v${nextPasswordVersion++}-${seed}`;
          await manager.changeMasterPassword(OWNER, masterPassword, newPassword);
          masterPassword = newPassword;
          neverLeak.add(newPassword);
          shadow.sessionId = null; // changeMasterPassword invalidates every existing session
        } else {
          expect(await asyncErrCode(() => manager.changeMasterPassword(OWNER, masterPassword, "irrelevant-new-password"))).toBe(outcome);
        }
      } else {
        // advance the clock, which is the only way a lockout ever clears
        clock.advance(Math.floor(rand() * (LOCKOUT_MS / 2)));
      }

      expect(manager.getVault(OWNER).entryCount).toBe(shadow.entries.size);
      expect(shadow.sessionId === null || manager.isSessionActive(shadow.sessionId)).toBe(true);
      assertNeverLeaked();
    }

    // Final check: clear any outstanding lockout, unlock with the last known-correct password, and confirm
    // every surviving shadow entry matches exactly, with nothing extra on the manager's side.
    if (shadow.lockedUntil !== null && clock.now() < shadow.lockedUntil) clock.advance(shadow.lockedUntil - clock.now());
    const finalSession = shadow.sessionId ?? manager.unlock(OWNER, masterPassword).sessionId;
    const finalIds = new Set(manager.listEntries(finalSession).map((e) => e.id));
    expect(finalIds).toEqual(new Set(shadow.entries.keys()));
    for (const [id, expected] of shadow.entries) {
      expect(manager.getEntry(finalSession, id)).toMatchObject(expected);
    }
    expect(manager.getVault(OWNER).createdAt).toBe(T0);
  }, 20_000);
}
