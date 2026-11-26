import { describe, expect, it } from "vitest";
import { MAX_NOTES_LENGTH, MAX_PASSWORD_LENGTH, MAX_TITLE_LENGTH, MAX_USERNAME_LENGTH } from "../src/manager.js";
import { asyncErrorCode, errorCode, setup, T0 } from "./helpers.js";

function unlockedVault() {
  const ctx = setup();
  ctx.manager.createVault("alice", "correct-horse-battery");
  const { sessionId } = ctx.manager.unlock("alice", "correct-horse-battery");
  return { ...ctx, sessionId };
}

describe("addEntry", () => {
  it("stores title/username/notes in the clear return value; getEntry later returns the password too", async () => {
    const { manager, sessionId } = unlockedVault();
    const summary = await manager.addEntry(sessionId, { title: "GitHub", username: "alice", password: "s3cret", notes: "2FA on" });
    expect(summary).toMatchObject({ title: "GitHub", username: "alice", createdAt: T0, updatedAt: T0, lastUsedAt: null });
    expect((summary as unknown as Record<string, unknown>).password).toBeUndefined();
    const detail = manager.getEntry(sessionId, summary.id);
    expect(detail).toMatchObject({ password: "s3cret", notes: "2FA on" });
  });

  it("requires a non-empty title, username and password; notes default to empty", async () => {
    const { manager, sessionId } = unlockedVault();
    expect(await asyncErrorCode(() => manager.addEntry(sessionId, { title: "", username: "a", password: "p" }))).toBe("INVALID_REQUEST");
    expect(await asyncErrorCode(() => manager.addEntry(sessionId, { title: "t", username: "", password: "p" }))).toBe("INVALID_REQUEST");
    expect(await asyncErrorCode(() => manager.addEntry(sessionId, { title: "t", username: "a", password: "" }))).toBe("INVALID_REQUEST");
    const summary = await manager.addEntry(sessionId, { title: "t", username: "a", password: "p" });
    expect(manager.getEntry(sessionId, summary.id).notes).toBe("");
  });

  it("rejects fields over their max length (exact max is accepted, max+1 is not)", async () => {
    const { manager, sessionId } = unlockedVault();
    expect(await manager.addEntry(sessionId, { title: "t".repeat(MAX_TITLE_LENGTH), username: "a", password: "p" })).toBeTruthy();
    expect(
      await asyncErrorCode(() => manager.addEntry(sessionId, { title: "t".repeat(MAX_TITLE_LENGTH + 1), username: "a", password: "p" })),
    ).toBe("INVALID_REQUEST");
    expect(await manager.addEntry(sessionId, { title: "t", username: "a".repeat(MAX_USERNAME_LENGTH), password: "p" })).toBeTruthy();
    expect(
      await asyncErrorCode(() =>
        manager.addEntry(sessionId, { title: "t", username: "a".repeat(MAX_USERNAME_LENGTH + 1), password: "p" }),
      ),
    ).toBe("INVALID_REQUEST");
    expect(await manager.addEntry(sessionId, { title: "t", username: "a", password: "p".repeat(MAX_PASSWORD_LENGTH) })).toBeTruthy();
    expect(
      await asyncErrorCode(() =>
        manager.addEntry(sessionId, { title: "t", username: "a", password: "p".repeat(MAX_PASSWORD_LENGTH + 1) }),
      ),
    ).toBe("INVALID_REQUEST");
    expect(
      await manager.addEntry(sessionId, { title: "t", username: "a", password: "p", notes: "n".repeat(MAX_NOTES_LENGTH) }),
    ).toBeTruthy();
    expect(
      await asyncErrorCode(() =>
        manager.addEntry(sessionId, { title: "t", username: "a", password: "p", notes: "n".repeat(MAX_NOTES_LENGTH + 1) }),
      ),
    ).toBe("INVALID_REQUEST");
  });

  it("requires a valid, active session", async () => {
    const { manager } = setup();
    manager.createVault("alice", "correct-horse-battery");
    expect(await asyncErrorCode(() => manager.addEntry("ghost-session", { title: "t", username: "a", password: "p" }))).toBe(
      "UNKNOWN_SESSION",
    );
  });
});

describe("getEntry / listEntries", () => {
  it("getEntry bumps lastUsedAt; listEntries never includes a password", async () => {
    const { manager, clock, sessionId } = unlockedVault();
    const summary = await manager.addEntry(sessionId, { title: "GitHub", username: "alice", password: "s3cret" });
    expect(manager.listEntries(sessionId)[0]!.lastUsedAt).toBeNull(); // listEntries() does not count as "using" an entry
    clock.advance(1000);
    manager.getEntry(sessionId, summary.id);
    expect(manager.getEntry(sessionId, summary.id).lastUsedAt).toBe(T0 + 1000);
    const list = manager.listEntries(sessionId);
    expect(list).toHaveLength(1);
    expect((list[0] as unknown as Record<string, unknown>).password).toBeUndefined();
  });

  it("an unknown entry id throws UNKNOWN_ENTRY", () => {
    const { manager, sessionId } = unlockedVault();
    expect(errorCode(() => manager.getEntry(sessionId, "ghost"))).toBe("UNKNOWN_ENTRY");
  });
});

describe("updateEntry", () => {
  it("patches only the given fields, bumps updatedAt, and re-encrypts", async () => {
    const { manager, clock, sessionId } = unlockedVault();
    const summary = await manager.addEntry(sessionId, { title: "GitHub", username: "alice", password: "old-pw", notes: "n" });
    clock.advance(500);
    await manager.updateEntry(sessionId, summary.id, { password: "new-pw" });
    const detail = manager.getEntry(sessionId, summary.id);
    expect(detail).toMatchObject({ title: "GitHub", username: "alice", password: "new-pw", notes: "n", updatedAt: T0 + 500 });
  });

  it("an invalid patch throws and leaves the entry completely unchanged", async () => {
    const { manager, sessionId } = unlockedVault();
    const summary = await manager.addEntry(sessionId, { title: "GitHub", username: "alice", password: "old-pw" });
    expect(await asyncErrorCode(() => manager.updateEntry(sessionId, summary.id, { title: "" }))).toBe("INVALID_REQUEST");
    expect(manager.getEntry(sessionId, summary.id)).toMatchObject({ title: "GitHub", password: "old-pw", updatedAt: T0 });
  });

  it("an unknown entry id throws UNKNOWN_ENTRY", async () => {
    const { manager, sessionId } = unlockedVault();
    expect(await asyncErrorCode(() => manager.updateEntry(sessionId, "ghost", { title: "x" }))).toBe("UNKNOWN_ENTRY");
  });
});

describe("deleteEntry", () => {
  it("removes the entry; a second delete, or any later get, throws UNKNOWN_ENTRY", async () => {
    const { manager, sessionId } = unlockedVault();
    const summary = await manager.addEntry(sessionId, { title: "GitHub", username: "alice", password: "pw" });
    await manager.deleteEntry(sessionId, summary.id);
    expect(await asyncErrorCode(() => manager.deleteEntry(sessionId, summary.id))).toBe("UNKNOWN_ENTRY");
    expect(errorCode(() => manager.getEntry(sessionId, summary.id))).toBe("UNKNOWN_ENTRY");
    expect(manager.getVault("alice").entryCount).toBe(0);
  });
});
