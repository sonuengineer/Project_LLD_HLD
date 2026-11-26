import { describe, expect, it } from "vitest";
import { LOCKOUT_MS, MAX_FAILED_ATTEMPTS, MIN_MASTER_PASSWORD_LENGTH } from "../src/manager.js";
import { errorCode, setup, T0 } from "./helpers.js";

describe("createVault", () => {
  it("starts locked, with no entries", () => {
    const { manager } = setup();
    const summary = manager.createVault("alice", "correct-horse-battery");
    expect(summary).toMatchObject({ ownerId: "alice", unlocked: false, entryCount: 0, createdAt: T0 });
  });

  it("rejects a master password shorter than the minimum, or an empty ownerId", () => {
    const { manager } = setup();
    expect(errorCode(() => manager.createVault("alice", "a".repeat(MIN_MASTER_PASSWORD_LENGTH - 1)))).toBe("INVALID_REQUEST");
    expect(manager.createVault("alice2", "a".repeat(MIN_MASTER_PASSWORD_LENGTH))).toBeTruthy();
    expect(errorCode(() => manager.createVault("", "correct-horse-battery"))).toBe("INVALID_REQUEST");
  });

  it("a second vault for the same ownerId throws VAULT_ALREADY_EXISTS, and the first vault is unchanged", () => {
    const { manager } = setup();
    manager.createVault("alice", "correct-horse-battery");
    expect(errorCode(() => manager.createVault("alice", "a-totally-different-password"))).toBe("VAULT_ALREADY_EXISTS");
    manager.unlock("alice", "correct-horse-battery"); // the original password still works
  });

  it("an unknown owner throws UNKNOWN_OWNER on any operation", () => {
    const { manager } = setup();
    expect(errorCode(() => manager.getVault("ghost"))).toBe("UNKNOWN_OWNER");
    expect(errorCode(() => manager.unlock("ghost", "correct-horse-battery"))).toBe("UNKNOWN_OWNER");
    expect(errorCode(() => manager.lock("ghost"))).toBe("UNKNOWN_OWNER");
  });
});

describe("unlock / lock", () => {
  it("the correct master password unlocks; the vault reports unlocked: true", () => {
    const { manager } = setup();
    manager.createVault("alice", "correct-horse-battery");
    const summary = manager.unlock("alice", "correct-horse-battery");
    expect(summary.unlocked).toBe(true);
    expect(manager.isUnlocked("alice")).toBe(true);
  });

  it("the wrong master password throws INVALID_MASTER_PASSWORD and leaves the vault locked", () => {
    const { manager } = setup();
    manager.createVault("alice", "correct-horse-battery");
    expect(errorCode(() => manager.unlock("alice", "wrong-password-here"))).toBe("INVALID_MASTER_PASSWORD");
    expect(manager.isUnlocked("alice")).toBe(false);
  });

  it("lock() clears the unlocked state; operations after locking require unlocking again", () => {
    const { manager } = setup();
    manager.createVault("alice", "correct-horse-battery");
    manager.unlock("alice", "correct-horse-battery");
    manager.lock("alice");
    expect(manager.isUnlocked("alice")).toBe(false);
    expect(errorCode(() => manager.addEntry("alice", { title: "x", username: "x", password: "x" }))).toBe("VAULT_LOCKED");
  });

  it(`locks out after ${MAX_FAILED_ATTEMPTS} consecutive wrong attempts, even with the correct password`, () => {
    const { manager } = setup();
    manager.createVault("alice", "correct-horse-battery");
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) {
      expect(errorCode(() => manager.unlock("alice", "wrong-password-here"))).toBe("INVALID_MASTER_PASSWORD");
    }
    expect(errorCode(() => manager.unlock("alice", "correct-horse-battery"))).toBe("LOCKED_OUT");
  });

  it("the cooldown expires after LOCKOUT_MS and a fresh attempt is then evaluated normally", () => {
    const { manager, clock } = setup();
    manager.createVault("alice", "correct-horse-battery");
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) {
      try {
        manager.unlock("alice", "wrong-password-here");
      } catch {
        /* expected */
      }
    }
    expect(errorCode(() => manager.unlock("alice", "correct-horse-battery"))).toBe("LOCKED_OUT");
    clock.advance(LOCKOUT_MS - 1);
    expect(errorCode(() => manager.unlock("alice", "correct-horse-battery"))).toBe("LOCKED_OUT");
    clock.advance(1);
    expect(manager.unlock("alice", "correct-horse-battery").unlocked).toBe(true);
  });

  it("once the cooldown elapses, the failed-attempt counter itself is reset: a single further wrong attempt does not immediately re-lock", () => {
    const { manager, clock } = setup();
    manager.createVault("alice", "correct-horse-battery");
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) {
      try {
        manager.unlock("alice", "wrong-password-here");
      } catch {
        /* expected */
      }
    }
    clock.advance(LOCKOUT_MS);
    expect(errorCode(() => manager.unlock("alice", "wrong-password-here"))).toBe("INVALID_MASTER_PASSWORD"); // not LOCKED_OUT
    expect(manager.unlock("alice", "correct-horse-battery").unlocked).toBe(true); // still not locked out
  });

  it("a successful unlock resets the failed-attempt counter", () => {
    const { manager } = setup();
    manager.createVault("alice", "correct-horse-battery");
    for (let i = 0; i < MAX_FAILED_ATTEMPTS - 1; i++) {
      expect(errorCode(() => manager.unlock("alice", "wrong-password-here"))).toBe("INVALID_MASTER_PASSWORD");
    }
    manager.unlock("alice", "correct-horse-battery"); // one attempt left before lockout; this succeeds
    manager.lock("alice");
    // the counter was reset, so another near-full run of wrong attempts does not immediately lock out
    for (let i = 0; i < MAX_FAILED_ATTEMPTS - 1; i++) {
      expect(errorCode(() => manager.unlock("alice", "wrong-password-here"))).toBe("INVALID_MASTER_PASSWORD");
    }
    expect(manager.unlock("alice", "correct-horse-battery").unlocked).toBe(true);
  });
});
