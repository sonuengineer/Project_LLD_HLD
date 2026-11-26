import { describe, expect, it } from "vitest";
import { MAX_FAILED_ATTEMPTS } from "../src/manager.js";
import { errorCode, setup } from "./helpers.js";

describe("changeMasterPassword", () => {
  it("re-encrypts every entry; the OLD password no longer unlocks, the NEW one does, and entries survive", () => {
    const { manager } = setup();
    manager.createVault("alice", "old-master-password");
    manager.unlock("alice", "old-master-password");
    const summary = manager.addEntry("alice", { title: "GitHub", username: "alice", password: "s3cret" });
    manager.changeMasterPassword("alice", "old-master-password", "new-master-password");

    expect(manager.isUnlocked("alice")).toBe(false); // left locked, like a real app re-prompting
    expect(errorCode(() => manager.unlock("alice", "old-master-password"))).toBe("INVALID_MASTER_PASSWORD");
    manager.unlock("alice", "new-master-password");
    expect(manager.getEntry("alice", summary.id).password).toBe("s3cret");
  });

  it("does NOT require the vault to be currently unlocked -- it takes the old password directly", () => {
    const { manager } = setup();
    manager.createVault("alice", "old-master-password");
    expect(manager.isUnlocked("alice")).toBe(false);
    manager.changeMasterPassword("alice", "old-master-password", "new-master-password");
    manager.unlock("alice", "new-master-password");
  });

  it("the WRONG old password changes nothing: salt, canary and every entry are untouched", () => {
    const { manager } = setup();
    manager.createVault("alice", "old-master-password");
    manager.unlock("alice", "old-master-password");
    const summary = manager.addEntry("alice", { title: "GitHub", username: "alice", password: "s3cret" });
    const before = manager.exportVault("alice");

    expect(errorCode(() => manager.changeMasterPassword("alice", "totally-wrong-password", "new-master-password"))).toBe(
      "INVALID_MASTER_PASSWORD",
    );

    expect(manager.exportVault("alice")).toEqual(before);
    manager.lock("alice");
    manager.unlock("alice", "old-master-password"); // still the original password
    expect(manager.getEntry("alice", summary.id).password).toBe("s3cret");
  });

  it("a wrong old password counts against the SAME lockout as unlock() -- it is not a side door around it", () => {
    const { manager } = setup();
    manager.createVault("alice", "old-master-password");
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) {
      expect(errorCode(() => manager.changeMasterPassword("alice", "totally-wrong-password", "new-master-password"))).toBe(
        "INVALID_MASTER_PASSWORD",
      );
    }
    expect(errorCode(() => manager.unlock("alice", "old-master-password"))).toBe("LOCKED_OUT");
  });

  it("rejects a new master password shorter than the minimum, leaving the old password in effect", () => {
    const { manager } = setup();
    manager.createVault("alice", "old-master-password");
    expect(errorCode(() => manager.changeMasterPassword("alice", "old-master-password", "short"))).toBe("INVALID_REQUEST");
    manager.unlock("alice", "old-master-password");
  });
});
