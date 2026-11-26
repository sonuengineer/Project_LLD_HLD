import { describe, expect, it } from "vitest";
import { InMemoryVaultStore } from "../src/index.js";
import { MAX_FAILED_ATTEMPTS } from "../src/manager.js";
import { asyncErrorCode, errorCode, setup } from "./helpers.js";

describe("changeMasterPassword", () => {
  it("persists the NEW salt/canary to the store, not the old ones -- the durable snapshot must match the new password, not just the in-memory record", async () => {
    const store = new InMemoryVaultStore();
    const { manager } = setup({ store });
    manager.createVault("alice", "old-master-password");
    const { sessionId } = manager.unlock("alice", "old-master-password");
    await manager.addEntry(sessionId, { title: "GitHub", username: "alice", password: "s3cret" });
    const before = store.lastPersisted("alice");

    await manager.changeMasterPassword("alice", "old-master-password", "new-master-password");

    const after = store.lastPersisted("alice")!;
    const live = manager.exportVault("alice");
    expect(after.salt).toBe(live.salt);
    expect(after.canary).toEqual(live.canary);
    expect(after.salt).not.toBe(before!.salt); // a crash right after this commit must not leave a stale persisted salt
  });

  it("re-encrypts every entry; the OLD password no longer unlocks, the NEW one does, and entries survive", async () => {
    const { manager } = setup();
    manager.createVault("alice", "old-master-password");
    const { sessionId } = manager.unlock("alice", "old-master-password");
    const summary = await manager.addEntry(sessionId, { title: "GitHub", username: "alice", password: "s3cret" });
    await manager.changeMasterPassword("alice", "old-master-password", "new-master-password");

    expect(errorCode(() => manager.unlock("alice", "old-master-password"))).toBe("INVALID_MASTER_PASSWORD");
    const fresh = manager.unlock("alice", "new-master-password");
    expect(manager.getEntry(fresh.sessionId, summary.id).password).toBe("s3cret");
  });

  it("invalidates every OTHER session immediately -- a stale session can no longer read or write", async () => {
    const { manager } = setup();
    manager.createVault("alice", "old-master-password");
    const staleA = manager.unlock("alice", "old-master-password");
    const staleB = manager.unlock("alice", "old-master-password");
    expect(manager.isSessionActive(staleA.sessionId)).toBe(true);
    expect(manager.isSessionActive(staleB.sessionId)).toBe(true);

    await manager.changeMasterPassword("alice", "old-master-password", "new-master-password");

    expect(manager.isSessionActive(staleA.sessionId)).toBe(false);
    expect(manager.isSessionActive(staleB.sessionId)).toBe(false);
    // Each session is checked fresh here -- the first touch after a rotation reports SESSION_INVALIDATED; a
    // session already lazily cleaned up by an earlier check reports UNKNOWN_SESSION instead (it is gone, not
    // merely stale), which is why this uses two separate sessions rather than touching the same one twice.
    expect(errorCode(() => manager.getEntry(staleA.sessionId, "whatever"))).toBe("SESSION_INVALIDATED");
    expect(await asyncErrorCode(() => manager.addEntry(staleB.sessionId, { title: "t", username: "a", password: "p" }))).toBe(
      "SESSION_INVALIDATED",
    );
  });

  it("does NOT require a session to be active -- it takes the old password directly", async () => {
    const { manager } = setup();
    manager.createVault("alice", "old-master-password");
    await manager.changeMasterPassword("alice", "old-master-password", "new-master-password");
    manager.unlock("alice", "new-master-password");
  });

  it("the WRONG old password changes nothing: salt, canary and every entry are untouched", async () => {
    const { manager } = setup();
    manager.createVault("alice", "old-master-password");
    const { sessionId } = manager.unlock("alice", "old-master-password");
    const summary = await manager.addEntry(sessionId, { title: "GitHub", username: "alice", password: "s3cret" });
    const before = manager.exportVault("alice");

    expect(await asyncErrorCode(() => manager.changeMasterPassword("alice", "totally-wrong-password", "new-master-password"))).toBe(
      "INVALID_MASTER_PASSWORD",
    );

    expect(manager.exportVault("alice")).toEqual(before);
    expect(manager.isSessionActive(sessionId)).toBe(true); // the original session is still good
    expect(manager.getEntry(sessionId, summary.id).password).toBe("s3cret");
  });

  it("a wrong old password counts against the SAME lockout as unlock() -- it is not a side door around it", async () => {
    const { manager } = setup();
    manager.createVault("alice", "old-master-password");
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) {
      expect(await asyncErrorCode(() => manager.changeMasterPassword("alice", "totally-wrong-password", "new-master-password"))).toBe(
        "INVALID_MASTER_PASSWORD",
      );
    }
    expect(errorCode(() => manager.unlock("alice", "old-master-password"))).toBe("LOCKED_OUT");
  });

  it("rejects a new master password shorter than the minimum, leaving the old password in effect", async () => {
    const { manager } = setup();
    manager.createVault("alice", "old-master-password");
    expect(await asyncErrorCode(() => manager.changeMasterPassword("alice", "old-master-password", "short"))).toBe("INVALID_REQUEST");
    manager.unlock("alice", "old-master-password");
  });
});
