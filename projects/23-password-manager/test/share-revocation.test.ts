// Stage 5: a share grant is tracked manager-wide (shareId -> {ownerId, revoked, redeemedAt}), can be revoked
// by its issuer, and is single-use -- claimed synchronously, before any await, the same claim-before-await
// shape as every other race-prone operation in this project.
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

describe("revokeShare", () => {
  it("a revoked share can no longer be redeemed", async () => {
    const { manager, alice, bob } = twoVaults();
    const entry = await manager.addEntry(alice.sessionId, { title: "x", username: "a", password: "p" });
    const bobPublicKey = await manager.getSharingPublicKey(bob.sessionId);
    const token = manager.shareEntry(alice.sessionId, entry.id, bobPublicKey);

    manager.revokeShare(alice.sessionId, token.shareId);

    expect(await asyncErrorCode(() => manager.redeemShare(bob.sessionId, token))).toBe("SHARE_REVOKED");
  });

  it("an unknown shareId throws UNKNOWN_SHARE", () => {
    const { manager, alice } = twoVaults();
    expect(() => manager.revokeShare(alice.sessionId, "not-a-real-share-id")).toThrow(
      expect.objectContaining({ code: "UNKNOWN_SHARE" }),
    );
  });

  it("someone else's shareId also throws UNKNOWN_SHARE -- never distinguishing 'not yours' from 'does not exist'", async () => {
    const { manager, alice, bob } = twoVaults();
    const entry = await manager.addEntry(alice.sessionId, { title: "x", username: "a", password: "p" });
    const bobPublicKey = await manager.getSharingPublicKey(bob.sessionId);
    const token = manager.shareEntry(alice.sessionId, entry.id, bobPublicKey);

    // bob did not issue this share -- alice did -- so bob may not revoke it.
    expect(() => manager.revokeShare(bob.sessionId, token.shareId)).toThrow(expect.objectContaining({ code: "UNKNOWN_SHARE" }));
    // it is still perfectly valid: bob's failed revoke attempt did not revoke it either.
    const redeemed = await manager.redeemShare(bob.sessionId, token);
    expect(redeemed.title).toBe("x");
  });

  it("revoking twice (or revoking an already-redeemed share) is a harmless no-op, not an error", async () => {
    const { manager, alice, bob } = twoVaults();
    const entry = await manager.addEntry(alice.sessionId, { title: "x", username: "a", password: "p" });
    const bobPublicKey = await manager.getSharingPublicKey(bob.sessionId);
    const token = manager.shareEntry(alice.sessionId, entry.id, bobPublicKey);

    manager.revokeShare(alice.sessionId, token.shareId);
    expect(() => manager.revokeShare(alice.sessionId, token.shareId)).not.toThrow();

    const second = manager.shareEntry(alice.sessionId, entry.id, bobPublicKey);
    await manager.redeemShare(bob.sessionId, second);
    expect(() => manager.revokeShare(alice.sessionId, second.shareId)).not.toThrow(); // already redeemed, still fine to revoke
  });
});

describe("redeemShare: unknown and single-use", () => {
  it("a forged shareId (never issued) throws UNKNOWN_SHARE", async () => {
    const { manager, alice, bob } = twoVaults();
    const entry = await manager.addEntry(alice.sessionId, { title: "x", username: "a", password: "p" });
    const bobPublicKey = await manager.getSharingPublicKey(bob.sessionId);
    const token = manager.shareEntry(alice.sessionId, entry.id, bobPublicKey);

    const forged = { ...token, shareId: "never-issued-share-id" };
    expect(await asyncErrorCode(() => manager.redeemShare(bob.sessionId, forged))).toBe("UNKNOWN_SHARE");
  });

  it("a share is single-use: redeeming it a second time throws SHARE_ALREADY_REDEEMED, and no duplicate entry is created", async () => {
    const { manager, alice, bob } = twoVaults();
    const entry = await manager.addEntry(alice.sessionId, { title: "x", username: "a", password: "p" });
    const bobPublicKey = await manager.getSharingPublicKey(bob.sessionId);
    const token = manager.shareEntry(alice.sessionId, entry.id, bobPublicKey);

    await manager.redeemShare(bob.sessionId, token);
    expect(await asyncErrorCode(() => manager.redeemShare(bob.sessionId, token))).toBe("SHARE_ALREADY_REDEEMED");
    expect(manager.listEntries(bob.sessionId)).toHaveLength(1);
  });

  it("two concurrent redemptions of the SAME token: exactly one succeeds, the other gets SHARE_ALREADY_REDEEMED", async () => {
    const { manager, alice, bob } = twoVaults();
    const entry = await manager.addEntry(alice.sessionId, { title: "x", username: "a", password: "p" });
    const bobPublicKey = await manager.getSharingPublicKey(bob.sessionId);
    const token = manager.shareEntry(alice.sessionId, entry.id, bobPublicKey);

    // Neither call is awaited before the other starts -- the claim (synchronous, before any await) still
    // guarantees only one can win, the same way claimEntryOp guarantees it for vault entries.
    const first = manager.redeemShare(bob.sessionId, token);
    const second = manager.redeemShare(bob.sessionId, token);

    const results = await Promise.allSettled([first, second]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: "SHARE_ALREADY_REDEEMED" });
    expect(manager.listEntries(bob.sessionId)).toHaveLength(1); // not two
  });
});
