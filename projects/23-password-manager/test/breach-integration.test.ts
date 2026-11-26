// How breach-checking shows up through PasswordManager itself: addEntry/updateEntry set `breached`
// automatically, and -- the most important property -- a broken breach-check service never blocks a save.
import { describe, expect, it } from "vitest";
import { BreachChecker } from "../src/breach-checker.js";
import { FakeBreachProvider } from "../src/breach.js";
import { setup } from "./helpers.js";

function unlockedVault(breachChecker?: BreachChecker) {
  const ctx = setup({ breachChecker });
  ctx.manager.createVault("alice", "correct-horse-battery");
  const { sessionId } = ctx.manager.unlock("alice", "correct-horse-battery");
  return { ...ctx, sessionId };
}

describe("zero-config defaults (no explicit provider/breaker/timeout)", () => {
  it("PasswordManager's own built-in default BreachChecker correctly detects a known-breached password", async () => {
    const { manager, sessionId } = unlockedVault(); // no breachChecker override at all
    // "qwerty123" is one of FakeBreachProvider's own default entries -- see src/breach.ts.
    const breached = await manager.addEntry(sessionId, { title: "Old site", username: "a", password: "qwerty123" });
    const clean = await manager.addEntry(sessionId, { title: "Bank", username: "a", password: "a-totally-different-password" });
    expect(breached.breached).toBe(true);
    expect(clean.breached).toBe(false);
  });
});

describe("addEntry / updateEntry: breach checking", () => {
  it("addEntry marks a known-breached password as breached: true", async () => {
    const { manager, sessionId } = unlockedVault(new BreachChecker({ provider: new FakeBreachProvider(["password123"]) }));
    const summary = await manager.addEntry(sessionId, { title: "GitHub", username: "alice", password: "password123" });
    expect(summary.breached).toBe(true);
    expect(manager.getEntry(sessionId, summary.id).breached).toBe(true);
  });

  it("addEntry marks a clean password as breached: false", async () => {
    const { manager, sessionId } = unlockedVault(new BreachChecker({ provider: new FakeBreachProvider(["password123"]) }));
    const summary = await manager.addEntry(sessionId, { title: "GitHub", username: "alice", password: "a-totally-different-password" });
    expect(summary.breached).toBe(false);
  });

  it("updateEntry re-checks only when the password actually changes; an unrelated patch leaves breached untouched", async () => {
    const { manager, sessionId } = unlockedVault(new BreachChecker({ provider: new FakeBreachProvider(["password123"]) }));
    const summary = await manager.addEntry(sessionId, { title: "GitHub", username: "alice", password: "password123" });
    expect(summary.breached).toBe(true);

    const afterTitlePatch = await manager.updateEntry(sessionId, summary.id, { title: "GitHub.com" });
    expect(afterTitlePatch.breached).toBe(true); // unchanged -- password was not part of this patch

    const afterPasswordPatch = await manager.updateEntry(sessionId, summary.id, { password: "a-totally-different-password" });
    expect(afterPasswordPatch.breached).toBe(false); // re-checked because the password changed
  });

  it("listEntries surfaces breached status without needing to call getEntry on each one", async () => {
    const { manager, sessionId } = unlockedVault(new BreachChecker({ provider: new FakeBreachProvider(["password123"]) }));
    await manager.addEntry(sessionId, { title: "Breached", username: "a", password: "password123" });
    await manager.addEntry(sessionId, { title: "Clean", username: "a", password: "a-totally-different-password" });
    const list = manager.listEntries(sessionId);
    expect(list.find((e) => e.title === "Breached")!.breached).toBe(true);
    expect(list.find((e) => e.title === "Clean")!.breached).toBe(false);
  });

  it("a broken breach-check provider never blocks addEntry or updateEntry -- it only degrades breached to null", async () => {
    const throwingProvider = { lookupPrefix: () => Promise.reject(new Error("provider down")) };
    const { manager, sessionId } = unlockedVault(new BreachChecker({ provider: throwingProvider }));

    const summary = await manager.addEntry(sessionId, { title: "GitHub", username: "alice", password: "whatever" });
    expect(summary.breached).toBeNull();

    const updated = await manager.updateEntry(sessionId, summary.id, { password: "something-else" });
    expect(updated.breached).toBeNull();
  });
});

describe("checkBreach", () => {
  it("is a standalone utility: no vault or session required, like generatePassword()", async () => {
    const { manager } = setup({ breachChecker: new BreachChecker({ provider: new FakeBreachProvider(["password123"]) }) });
    expect(await manager.checkBreach("password123")).toBe(true);
    expect(await manager.checkBreach("a-totally-different-password")).toBe(false);
  });

  it("validates its input the same way addEntry's password field does", async () => {
    const { manager } = setup();
    await expect(manager.checkBreach("")).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("never throws for a broken provider -- degrades to null", async () => {
    const throwingProvider = { lookupPrefix: () => Promise.reject(new Error("provider down")) };
    const { manager } = setup({ breachChecker: new BreachChecker({ provider: throwingProvider }) });
    expect(await manager.checkBreach("anything")).toBeNull();
  });
});

describe("exportVault: breach status never leaks in the clear", () => {
  it("the breached flag lives inside the encrypted blob, not as plaintext metadata", async () => {
    const { manager, sessionId } = unlockedVault(new BreachChecker({ provider: new FakeBreachProvider(["password123"]) }));
    await manager.addEntry(sessionId, { title: "GitHub", username: "alice", password: "password123" });
    const dump = JSON.stringify(manager.exportVault("alice"));
    expect(dump).not.toContain("breached");
    expect(dump).not.toContain("password123");
  });
});
