// The whole point of stage 2: saving an entry now means a real async round trip to a VaultStore, and two
// devices can be mid-round-trip on the SAME vault at once. Every test here uses a FakeVaultStore whose
// persist() never resolves on its own, so the test controls exactly how two operations interleave --
// mirroring 17-parking-lot's FakeDevice.
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_COMMIT_TIMEOUT_MS } from "../src/manager.js";
import { FakeVaultStore, flush, setup } from "./helpers.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("two devices adding entries at the same time", () => {
  it("both entries survive -- adding is independent per entry, so there is nothing to lose", async () => {
    const store = new FakeVaultStore();
    const { manager } = setup({ store });
    manager.createVault("alice", "correct-horse-battery");
    const phone = manager.unlock("alice", "correct-horse-battery");
    const laptop = manager.unlock("alice", "correct-horse-battery");

    const addFromPhone = manager.addEntry(phone.sessionId, { title: "GitHub", username: "alice", password: "p1" });
    const addFromLaptop = manager.addEntry(laptop.sessionId, { title: "Email", username: "alice", password: "p2" });
    await flush();
    expect(store.pending).toHaveLength(2);

    // Resolve in the OPPOSITE order from how the calls were made -- the outcome should not depend on this.
    store.resolveAt(1);
    store.resolveAt(0);
    await Promise.all([addFromPhone, addFromLaptop]);

    expect(manager.listEntries(phone.sessionId)).toHaveLength(2);
  });
});

describe("an entry operation racing a master-password rotation", () => {
  it("addEntry started WHILE a rotation is in flight is rejected with VAULT_BUSY -- it never half-applies", async () => {
    const store = new FakeVaultStore();
    const { manager } = setup({ store });
    manager.createVault("alice", "correct-horse-battery");
    const session = manager.unlock("alice", "correct-horse-battery");

    // changeMasterPassword runs synchronously up to its own await -- by the time this line returns, the
    // vault is already marked "rotating", before addEntry ever gets a chance to run.
    const rotation = manager.changeMasterPassword("alice", "correct-horse-battery", "a-new-master-password");
    const add = manager.addEntry(session.sessionId, { title: "GitHub", username: "alice", password: "p1" });

    await expect(add).rejects.toMatchObject({ code: "VAULT_BUSY" });
    expect(store.pending).toHaveLength(1); // only the rotation's commit was ever attempted
    store.resolveNext();
    await rotation;

    expect(manager.listEntries(manager.unlock("alice", "a-new-master-password").sessionId)).toHaveLength(0);
  });

  it("changeMasterPassword started WHILE an addEntry is in flight is rejected with VAULT_BUSY -- it never rotates onto a stale snapshot", async () => {
    const store = new FakeVaultStore();
    const { manager } = setup({ store });
    manager.createVault("alice", "correct-horse-battery");
    const session = manager.unlock("alice", "correct-horse-battery");

    const add = manager.addEntry(session.sessionId, { title: "GitHub", username: "alice", password: "p1" });
    // addEntry's claim (pendingEntryOps++) and its store call have already both run synchronously by now,
    // before its own commit resolves -- calling an async function runs it up to its first await immediately.
    const rotation = manager.changeMasterPassword("alice", "correct-horse-battery", "a-new-master-password");

    await expect(rotation).rejects.toMatchObject({ code: "VAULT_BUSY" });
    expect(store.pending).toHaveLength(1); // only addEntry's commit was ever attempted
    store.resolveNext();
    await add;

    // The add is NOT lost: a later, un-raced rotation still carries it forward.
    const secondRotation = manager.changeMasterPassword("alice", "correct-horse-battery", "a-new-master-password");
    store.resolveNext();
    await secondRotation;
    expect(manager.listEntries(manager.unlock("alice", "a-new-master-password").sessionId)).toHaveLength(1);
  });
});

describe("two devices updating the SAME entry at the same time", () => {
  it("the loser gets ENTRY_CONFLICT; the winner's write survives, not a silent mix of the two", async () => {
    const store = new FakeVaultStore();
    const { manager } = setup({ store });
    manager.createVault("alice", "correct-horse-battery");
    const phone = manager.unlock("alice", "correct-horse-battery");
    const laptop = manager.unlock("alice", "correct-horse-battery");
    const seedAdd = manager.addEntry(phone.sessionId, { title: "GitHub", username: "alice", password: "original" });
    store.resolveNext();
    const entry = await seedAdd;

    const fromPhone = manager.updateEntry(phone.sessionId, entry.id, { password: "from-phone" });
    const fromLaptop = manager.updateEntry(laptop.sessionId, entry.id, { password: "from-laptop" });
    await flush();
    expect(store.pending).toHaveLength(2);

    store.resolveAt(0); // the phone's write lands first
    store.resolveAt(0); // then the laptop's (index 0 again -- the phone's call already left the queue)

    await expect(fromPhone).resolves.toMatchObject({ id: entry.id });
    await expect(fromLaptop).rejects.toMatchObject({ code: "ENTRY_CONFLICT" });
    expect(manager.getEntry(phone.sessionId, entry.id).password).toBe("from-phone");
  });
});

describe("an update racing a delete of the same entry", () => {
  it("the update detects UNKNOWN_ENTRY instead of resurrecting a deleted entry", async () => {
    const store = new FakeVaultStore();
    const { manager } = setup({ store });
    manager.createVault("alice", "correct-horse-battery");
    const phone = manager.unlock("alice", "correct-horse-battery");
    const laptop = manager.unlock("alice", "correct-horse-battery");
    const seedAdd = manager.addEntry(phone.sessionId, { title: "GitHub", username: "alice", password: "original" });
    store.resolveNext();
    const entry = await seedAdd;

    const update = manager.updateEntry(phone.sessionId, entry.id, { password: "from-phone" });
    const remove = manager.deleteEntry(laptop.sessionId, entry.id);
    await flush();
    expect(store.pending).toHaveLength(2); // update was pushed at index 0, delete at index 1

    store.resolveAt(1); // the delete's commit lands FIRST, removing the entry
    store.resolveAt(0); // the update's commit lands second, onto an entry that is now gone

    await expect(remove).resolves.toBeUndefined();
    await expect(update).rejects.toMatchObject({ code: "UNKNOWN_ENTRY" });
    expect(manager.listEntries(phone.sessionId)).toHaveLength(0);
  });
});

describe("two devices deleting the SAME entry at the same time", () => {
  it("the loser gets UNKNOWN_ENTRY instead of a silent second no-op success", async () => {
    const store = new FakeVaultStore();
    const { manager } = setup({ store });
    manager.createVault("alice", "correct-horse-battery");
    const phone = manager.unlock("alice", "correct-horse-battery");
    const laptop = manager.unlock("alice", "correct-horse-battery");
    const seedAdd = manager.addEntry(phone.sessionId, { title: "GitHub", username: "alice", password: "original" });
    store.resolveNext();
    const entry = await seedAdd;

    const fromPhone = manager.deleteEntry(phone.sessionId, entry.id);
    const fromLaptop = manager.deleteEntry(laptop.sessionId, entry.id);
    await flush();
    expect(store.pending).toHaveLength(2);

    store.resolveAt(0); // the phone's delete lands first, actually removing the entry
    store.resolveAt(0); // the laptop's delete lands second, onto an entry that is already gone

    await expect(fromPhone).resolves.toBeUndefined();
    await expect(fromLaptop).rejects.toMatchObject({ code: "UNKNOWN_ENTRY" });
  });
});

describe("two concurrent master-password rotations on the same vault", () => {
  it("the second is rejected with VAULT_BUSY -- it never rotates twice onto the same claim", async () => {
    const store = new FakeVaultStore();
    const { manager } = setup({ store });
    manager.createVault("alice", "correct-horse-battery");

    const first = manager.changeMasterPassword("alice", "correct-horse-battery", "first-new-password");
    const second = manager.changeMasterPassword("alice", "correct-horse-battery", "second-new-password");

    await expect(second).rejects.toMatchObject({ code: "VAULT_BUSY" });
    expect(store.pending).toHaveLength(1); // only the first rotation's commit was ever attempted
    store.resolveNext();
    await first;

    manager.unlock("alice", "first-new-password"); // the first rotation's password is the one that won
  });
});

describe("a store that never responds", () => {
  it("times out with STORE_TIMEOUT, applies nothing, and releases its claim for the next operation", async () => {
    vi.useFakeTimers();
    const store = new FakeVaultStore();
    const { manager } = setup({ store, commitTimeoutMs: 1_000 });
    manager.createVault("alice", "correct-horse-battery");
    const session = manager.unlock("alice", "correct-horse-battery");

    const add = manager.addEntry(session.sessionId, { title: "GitHub", username: "alice", password: "p1" });
    const assertion = expect(add).rejects.toMatchObject({ code: "STORE_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;

    expect(manager.listEntries(session.sessionId)).toHaveLength(0); // nothing was applied

    // The claim was released even though the commit never resolved -- a later, un-raced rotation works fine.
    vi.useRealTimers();
    const rotation = manager.changeMasterPassword("alice", "correct-horse-battery", "a-new-master-password");
    store.resolveNext();
    await rotation;
  });

  it("a commit that succeeds before the deadline clears its timeout timer -- no stray timer is left pending", async () => {
    vi.useFakeTimers();
    const store = new FakeVaultStore();
    const { manager } = setup({ store, commitTimeoutMs: 1_000 });
    manager.createVault("alice", "correct-horse-battery");
    const session = manager.unlock("alice", "correct-horse-battery");

    const add = manager.addEntry(session.sessionId, { title: "GitHub", username: "alice", password: "p1" });
    store.resolveNext();
    await add;

    expect(vi.getTimerCount()).toBe(0); // a leaked timer here would otherwise keep the deadline alive for nothing
  });

  it(`defaults to a ${DEFAULT_COMMIT_TIMEOUT_MS}ms timeout when none is given`, async () => {
    vi.useFakeTimers();
    const store = new FakeVaultStore();
    const { manager } = setup({ store });
    manager.createVault("alice", "correct-horse-battery");
    const session = manager.unlock("alice", "correct-horse-battery");

    const add = manager.addEntry(session.sessionId, { title: "GitHub", username: "alice", password: "p1" });
    const assertion = expect(add).rejects.toMatchObject({ code: "STORE_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(DEFAULT_COMMIT_TIMEOUT_MS);
    await assertion;
  });
});

describe("the bug this design prevents (illustration, not using PasswordManager)", () => {
  it("an unguarded 'snapshot, await, then overwrite' step silently drops a concurrently-added entry", async () => {
    const entries = new Map<string, string>([["e1", "alpha"]]);
    let release!: () => void;
    const deviceCall = new Promise<void>((resolve) => {
      release = resolve;
    });

    async function naiveRotate() {
      const snapshot = new Map(entries); // read, BEFORE the concurrent add below happens
      await deviceCall; // the async step -- held open on purpose, standing in for the store round trip
      entries.clear();
      for (const [id, value] of snapshot) entries.set(id, value); // wholesale overwrite: no claim, no version check
    }

    const rotating = naiveRotate();
    entries.set("e2", "beta"); // a second device's add, landing while the rotation is "in flight"
    release();
    await rotating;

    // This is exactly the bug PasswordManager's rotating/pendingEntryOps claim (and VAULT_BUSY) prevents --
    // real changeMasterPassword can never reach its overwrite while an add is uncommitted, and real addEntry
    // can never start once rotating is true.
    expect(entries.has("e2")).toBe(false);
  });
});
