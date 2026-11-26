import { describe, expect, it } from "vitest";
import { setup } from "./helpers.js";

describe("exportVault", () => {
  it("works without unlocking, and contains only ciphertext -- never the plaintext password, title or username", () => {
    const { manager } = setup();
    manager.createVault("alice", "correct-horse-battery");
    manager.unlock("alice", "correct-horse-battery");
    manager.addEntry("alice", { title: "super-secret-site", username: "alice@example.com", password: "p@ssw0rd-plaintext", notes: "n" });
    manager.lock("alice");

    const dump = JSON.stringify(manager.exportVault("alice"));
    expect(dump).not.toContain("p@ssw0rd-plaintext");
    expect(dump).not.toContain("super-secret-site");
    expect(dump).not.toContain("alice@example.com");
    expect(dump).not.toContain("correct-horse-battery");
  });

  it("includes exactly the entries that exist, as base64 ciphertext with an id and timestamps", () => {
    const { manager } = setup();
    manager.createVault("alice", "correct-horse-battery");
    manager.unlock("alice", "correct-horse-battery");
    const summary = manager.addEntry("alice", { title: "t", username: "u", password: "p" });

    const dump = manager.exportVault("alice");
    expect(dump.entries).toHaveLength(1);
    expect(dump.entries[0]).toMatchObject({ id: summary.id, createdAt: summary.createdAt, updatedAt: summary.updatedAt, lastUsedAt: null });
    expect(typeof dump.entries[0]!.blob.ciphertext).toBe("string");
    expect(typeof dump.salt).toBe("string");
  });

  it("an unknown owner throws UNKNOWN_OWNER", () => {
    const { manager } = setup();
    expect(() => manager.exportVault("ghost")).toThrow();
  });
});
