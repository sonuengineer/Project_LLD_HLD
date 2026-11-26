import { describe, expect, it } from "vitest";
import { MAX_NOTES_LENGTH, MAX_PASSWORD_LENGTH, MAX_TITLE_LENGTH, MAX_USERNAME_LENGTH } from "../src/manager.js";
import { errorCode, setup, T0 } from "./helpers.js";

function unlockedVault() {
  const ctx = setup();
  ctx.manager.createVault("alice", "correct-horse-battery");
  ctx.manager.unlock("alice", "correct-horse-battery");
  return ctx;
}

describe("addEntry", () => {
  it("stores title/username/notes in the clear return value; getEntry later returns the password too", () => {
    const { manager } = unlockedVault();
    const summary = manager.addEntry("alice", { title: "GitHub", username: "alice", password: "s3cret", notes: "2FA on" });
    expect(summary).toMatchObject({ title: "GitHub", username: "alice", createdAt: T0, updatedAt: T0, lastUsedAt: null });
    expect((summary as unknown as Record<string, unknown>).password).toBeUndefined();
    const detail = manager.getEntry("alice", summary.id);
    expect(detail).toMatchObject({ password: "s3cret", notes: "2FA on" });
  });

  it("requires a non-empty title, username and password; notes default to empty", () => {
    const { manager } = unlockedVault();
    expect(errorCode(() => manager.addEntry("alice", { title: "", username: "a", password: "p" }))).toBe("INVALID_REQUEST");
    expect(errorCode(() => manager.addEntry("alice", { title: "t", username: "", password: "p" }))).toBe("INVALID_REQUEST");
    expect(errorCode(() => manager.addEntry("alice", { title: "t", username: "a", password: "" }))).toBe("INVALID_REQUEST");
    const summary = manager.addEntry("alice", { title: "t", username: "a", password: "p" });
    expect(manager.getEntry("alice", summary.id).notes).toBe("");
  });

  it("rejects fields over their max length (exact max is accepted, max+1 is not)", () => {
    const { manager } = unlockedVault();
    expect(manager.addEntry("alice", { title: "t".repeat(MAX_TITLE_LENGTH), username: "a", password: "p" })).toBeTruthy();
    expect(errorCode(() => manager.addEntry("alice", { title: "t".repeat(MAX_TITLE_LENGTH + 1), username: "a", password: "p" }))).toBe(
      "INVALID_REQUEST",
    );
    expect(manager.addEntry("alice", { title: "t", username: "a".repeat(MAX_USERNAME_LENGTH), password: "p" })).toBeTruthy();
    expect(
      errorCode(() => manager.addEntry("alice", { title: "t", username: "a".repeat(MAX_USERNAME_LENGTH + 1), password: "p" })),
    ).toBe("INVALID_REQUEST");
    expect(manager.addEntry("alice", { title: "t", username: "a", password: "p".repeat(MAX_PASSWORD_LENGTH) })).toBeTruthy();
    expect(
      errorCode(() => manager.addEntry("alice", { title: "t", username: "a", password: "p".repeat(MAX_PASSWORD_LENGTH + 1) })),
    ).toBe("INVALID_REQUEST");
    expect(manager.addEntry("alice", { title: "t", username: "a", password: "p", notes: "n".repeat(MAX_NOTES_LENGTH) })).toBeTruthy();
    expect(
      errorCode(() => manager.addEntry("alice", { title: "t", username: "a", password: "p", notes: "n".repeat(MAX_NOTES_LENGTH + 1) })),
    ).toBe("INVALID_REQUEST");
  });

  it("requires the vault to be unlocked", () => {
    const { manager } = setup();
    manager.createVault("alice", "correct-horse-battery");
    expect(errorCode(() => manager.addEntry("alice", { title: "t", username: "a", password: "p" }))).toBe("VAULT_LOCKED");
  });
});

describe("getEntry / listEntries", () => {
  it("getEntry bumps lastUsedAt; listEntries never includes a password", () => {
    const { manager, clock } = unlockedVault();
    const summary = manager.addEntry("alice", { title: "GitHub", username: "alice", password: "s3cret" });
    expect(manager.listEntries("alice")[0]!.lastUsedAt).toBeNull(); // listEntries() does not count as "using" an entry
    clock.advance(1000);
    manager.getEntry("alice", summary.id);
    expect(manager.getEntry("alice", summary.id).lastUsedAt).toBe(T0 + 1000);
    const list = manager.listEntries("alice");
    expect(list).toHaveLength(1);
    expect((list[0] as unknown as Record<string, unknown>).password).toBeUndefined();
  });

  it("an unknown entry id throws UNKNOWN_ENTRY", () => {
    const { manager } = unlockedVault();
    expect(errorCode(() => manager.getEntry("alice", "ghost"))).toBe("UNKNOWN_ENTRY");
  });
});

describe("updateEntry", () => {
  it("patches only the given fields, bumps updatedAt, and re-encrypts", () => {
    const { manager, clock } = unlockedVault();
    const summary = manager.addEntry("alice", { title: "GitHub", username: "alice", password: "old-pw", notes: "n" });
    clock.advance(500);
    manager.updateEntry("alice", summary.id, { password: "new-pw" });
    const detail = manager.getEntry("alice", summary.id);
    expect(detail).toMatchObject({ title: "GitHub", username: "alice", password: "new-pw", notes: "n", updatedAt: T0 + 500 });
  });

  it("an invalid patch throws and leaves the entry completely unchanged", () => {
    const { manager } = unlockedVault();
    const summary = manager.addEntry("alice", { title: "GitHub", username: "alice", password: "old-pw" });
    expect(errorCode(() => manager.updateEntry("alice", summary.id, { title: "" }))).toBe("INVALID_REQUEST");
    expect(manager.getEntry("alice", summary.id)).toMatchObject({ title: "GitHub", password: "old-pw", updatedAt: T0 });
  });

  it("an unknown entry id throws UNKNOWN_ENTRY", () => {
    const { manager } = unlockedVault();
    expect(errorCode(() => manager.updateEntry("alice", "ghost", { title: "x" }))).toBe("UNKNOWN_ENTRY");
  });
});

describe("deleteEntry", () => {
  it("removes the entry; a second delete, or any later get, throws UNKNOWN_ENTRY", () => {
    const { manager } = unlockedVault();
    const summary = manager.addEntry("alice", { title: "GitHub", username: "alice", password: "pw" });
    manager.deleteEntry("alice", summary.id);
    expect(errorCode(() => manager.deleteEntry("alice", summary.id))).toBe("UNKNOWN_ENTRY");
    expect(errorCode(() => manager.getEntry("alice", summary.id))).toBe("UNKNOWN_ENTRY");
    expect(manager.getVault("alice").entryCount).toBe(0);
  });
});
