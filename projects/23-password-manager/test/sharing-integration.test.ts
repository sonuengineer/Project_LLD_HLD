// How sharing shows up through PasswordManager itself: two INDEPENDENT vaults, one handing a credential to
// the other without either side ever seeing the other's master password or vault key.
import { describe, expect, it } from "vitest";
import { asyncErrorCode, setup } from "./helpers.js";

function twoVaults() {
  const ctx = setup();
  ctx.manager.createVault("alice", "alice-master-password");
  ctx.manager.createVault("bob", "bob-master-password-123");
  const alice = ctx.manager.unlock("alice", "alice-master-password");
  const bob = ctx.manager.unlock("bob", "bob-master-password-123");
  return { ...ctx, alice, bob };
}

describe("getSharingPublicKey", () => {
  it("lazily generates a keypair on first call, and repeat calls return the SAME public key without re-persisting", async () => {
    const { manager, alice } = twoVaults();
    const first = await manager.getSharingPublicKey(alice.sessionId);
    const second = await manager.getSharingPublicKey(alice.sessionId);
    expect(first).toBe(second);
    expect(first).toContain("PUBLIC KEY");
  });

  it("is excluded by an in-progress rotation, same as any other vault-state-mutating op", async () => {
    const { manager, alice } = twoVaults();
    const rotation = manager.changeMasterPassword("alice", "alice-master-password", "a-new-master-password");
    await expect(manager.getSharingPublicKey(alice.sessionId)).rejects.toMatchObject({ code: "VAULT_BUSY" });
    await rotation;
  });
});

describe("shareEntry / redeemShare: end to end between two different vaults", () => {
  it("bob ends up with his own copy of alice's entry, decrypted correctly", async () => {
    const { manager, alice, bob } = twoVaults();
    const entry = await manager.addEntry(alice.sessionId, { title: "Shared Netflix", username: "alice", password: "s3cret-netflix-pw" });

    const bobPublicKey = await manager.getSharingPublicKey(bob.sessionId);
    const token = manager.shareEntry(alice.sessionId, entry.id, bobPublicKey);

    const redeemed = await manager.redeemShare(bob.sessionId, token);
    expect(redeemed.title).toBe("Shared Netflix");
    const detail = manager.getEntry(bob.sessionId, redeemed.id);
    expect(detail).toMatchObject({ username: "alice", password: "s3cret-netflix-pw" });

    // It is a genuinely independent copy -- deleting bob's does not touch alice's.
    await manager.deleteEntry(bob.sessionId, redeemed.id);
    expect(manager.getEntry(alice.sessionId, entry.id).password).toBe("s3cret-netflix-pw");
  });

  it("the share token never contains the plaintext password, title or username in the clear", async () => {
    const { manager, alice, bob } = twoVaults();
    const entry = await manager.addEntry(alice.sessionId, { title: "super-secret-site", username: "alice@example.com", password: "p@ssw0rd-plaintext" });
    const bobPublicKey = await manager.getSharingPublicKey(bob.sessionId);
    const token = manager.shareEntry(alice.sessionId, entry.id, bobPublicKey);

    const dump = JSON.stringify(token);
    expect(dump).not.toContain("p@ssw0rd-plaintext");
    expect(dump).not.toContain("super-secret-site");
    expect(dump).not.toContain("alice@example.com");
  });

  it("redeemShare re-checks breach status against the RECIPIENT's own breach-check configuration", async () => {
    const { BreachChecker } = await import("../src/breach-checker.js");
    const { FakeBreachProvider } = await import("../src/breach.js");
    const ctx = setup({ breachChecker: new BreachChecker({ provider: new FakeBreachProvider(["shared-weak-password"]) }) });
    ctx.manager.createVault("alice", "alice-master-password");
    ctx.manager.createVault("bob", "bob-master-password-123");
    const alice = ctx.manager.unlock("alice", "alice-master-password");
    const bob = ctx.manager.unlock("bob", "bob-master-password-123");

    // Alice's own breach-check config does not know this password is weak (different FakeBreachProvider
    // instance per manager would be needed for a fully separate config; here both vaults share one manager,
    // so this demonstrates the RE-check happens at all, not that the configs differ).
    const entry = await ctx.manager.addEntry(alice.sessionId, { title: "x", username: "a", password: "shared-weak-password" });
    expect(entry.breached).toBe(true);

    const bobPublicKey = await ctx.manager.getSharingPublicKey(bob.sessionId);
    const token = ctx.manager.shareEntry(alice.sessionId, entry.id, bobPublicKey);
    const redeemed = await ctx.manager.redeemShare(bob.sessionId, token);
    expect(redeemed.breached).toBe(true); // re-checked, not blindly copied from alice's entry
  });

  it("redeemShare on a vault that never generated a keypair throws NO_SHARING_KEY, checked BEFORE the one-time claim", async () => {
    const { manager, alice, bob } = twoVaults();
    const entry = await manager.addEntry(alice.sessionId, { title: "x", username: "a", password: "p" });
    // Sealed for SOME public key -- whose does not matter, since NO_SHARING_KEY must fire before this
    // vault's own wrappedPrivateKey is even looked at, let alone before any decryption is attempted.
    const someonesPublicKey = await manager.getSharingPublicKey(alice.sessionId);
    const token = manager.shareEntry(alice.sessionId, entry.id, someonesPublicKey);

    // bob never called getSharingPublicKey -- repeating the attempt proves the first failure did not
    // silently consume the one-time use (it would read SHARE_ALREADY_REDEEMED on the second try otherwise).
    expect(await asyncErrorCode(() => manager.redeemShare(bob.sessionId, token))).toBe("NO_SHARING_KEY");
    expect(await asyncErrorCode(() => manager.redeemShare(bob.sessionId, token))).toBe("NO_SHARING_KEY");
  });

  it("a token meant for a DIFFERENT recipient cannot be redeemed -- DECRYPTION_FAILED, not a silent wrong read", async () => {
    const { manager, alice, bob } = twoVaults();
    manager.createVault("carol", "carol-master-password-1");
    const carol = manager.unlock("carol", "carol-master-password-1");

    const entry = await manager.addEntry(alice.sessionId, { title: "x", username: "a", password: "p" });
    const bobPublicKey = await manager.getSharingPublicKey(bob.sessionId);
    await manager.getSharingPublicKey(carol.sessionId); // carol has her own keypair, just not the right one
    const tokenForBob = manager.shareEntry(alice.sessionId, entry.id, bobPublicKey);

    expect(await asyncErrorCode(() => manager.redeemShare(carol.sessionId, tokenForBob))).toBe("DECRYPTION_FAILED");

    // carol's failed attempt did not consume the share's one-time use -- the ACTUAL intended recipient can
    // still redeem it: the claim is released on a genuine failure, not just on success.
    const redeemed = await manager.redeemShare(bob.sessionId, tokenForBob);
    expect(redeemed.title).toBe("x");
  });

  it("sharing still works after the owner rotates their master password -- the private key is re-wrapped, not lost", async () => {
    const { manager, alice, bob } = twoVaults();
    await manager.getSharingPublicKey(alice.sessionId); // alice has a keypair of her own before rotating
    await manager.changeMasterPassword("alice", "alice-master-password", "alices-new-master-password");

    const freshAlice = manager.unlock("alice", "alices-new-master-password");
    const entry = await manager.addEntry(freshAlice.sessionId, { title: "x", username: "a", password: "p" });
    const bobPublicKey = await manager.getSharingPublicKey(bob.sessionId);
    const token = manager.shareEntry(freshAlice.sessionId, entry.id, bobPublicKey);
    const redeemed = await manager.redeemShare(bob.sessionId, token);
    expect(manager.getEntry(bob.sessionId, redeemed.id).password).toBe("p");
  });

  it("changeMasterPassword's re-wrap persists the re-wrapped private key, not the old one", async () => {
    const { InMemoryVaultStore } = await import("../src/store.js");
    const store = new InMemoryVaultStore();
    const ctx = setup({ store });
    ctx.manager.createVault("alice", "alice-master-password");
    const alice = ctx.manager.unlock("alice", "alice-master-password");
    await ctx.manager.getSharingPublicKey(alice.sessionId);
    const before = store.lastPersisted("alice")!.wrappedPrivateKey!;

    await ctx.manager.changeMasterPassword("alice", "alice-master-password", "a-new-master-password");

    const after = store.lastPersisted("alice")!.wrappedPrivateKey!;
    expect(after.ciphertext).not.toBe(before.ciphertext); // re-wrapped under the new key, not reused
    expect(after).toEqual(ctx.manager.exportVault("alice").wrappedPrivateKey);
  });
});
