// Peer's handshake/session orchestration, driven directly with Buffers -- no sockets. transport.test.ts
// covers the same scenarios again over real UDP to prove the wiring, but the protocol logic itself is all
// here, fast and deterministic.
import { describe, expect, it } from "vitest";
import { Peer } from "../src/peer.js";
import { VpnError } from "../src/errors.js";
import { trustedPeerPair } from "./helpers.js";

// Runs a full two-message handshake directly between two Peer instances, with no transport in between.
function handshake(initiator: Peer, responder: Peer): void {
  const msg1 = initiator.initiateHandshake(responder.name);
  const resultInit = responder.receiveHandshakeInit(msg1);
  if (!resultInit.ok) throw new Error(`handshake init rejected: ${resultInit.reason}`);
  const resultResp = initiator.receiveHandshakeResponse(resultInit.response);
  if (!resultResp.ok) throw new Error(`handshake response rejected: ${resultResp.reason}`);
}

describe("Peer handshake", () => {
  it("a successful handshake lets alice encrypt and bob decrypt the exact same payload", () => {
    const { a: alice, b: bob } = trustedPeerPair("alice", "bob");
    handshake(alice, bob);
    expect(alice.hasSession("bob")).toBe(true);
    expect(bob.hasSession("alice")).toBe(true);

    const wire = alice.encryptPacket("bob", Buffer.from("hello bob"));
    const result = bob.decryptPacket(wire);
    expect(result).toEqual({ ok: true, peerName: "alice", payload: Buffer.from("hello bob") });
  });

  it("works in both directions once established", () => {
    const { a: alice, b: bob } = trustedPeerPair("alice", "bob");
    handshake(alice, bob);

    const toBob = alice.encryptPacket("bob", Buffer.from("from alice"));
    expect(bob.decryptPacket(toBob)).toEqual({ ok: true, peerName: "alice", payload: Buffer.from("from alice") });

    const toAlice = bob.encryptPacket("alice", Buffer.from("from bob"));
    expect(alice.decryptPacket(toAlice)).toEqual({ ok: true, peerName: "bob", payload: Buffer.from("from bob") });
  });

  it("initiateHandshake throws UNKNOWN_PEER if trustPeer was never called", () => {
    const alice = new Peer("alice");
    expect(() => alice.initiateHandshake("bob")).toThrow(VpnError);
    try {
      alice.initiateHandshake("bob");
    } catch (err) {
      expect((err as VpnError).code).toBe("UNKNOWN_PEER");
    }
  });

  it("encryptPacket throws NO_SESSION before any handshake completes", () => {
    const { a: alice } = trustedPeerPair("alice", "bob");
    expect(() => alice.encryptPacket("bob", Buffer.from("x"))).toThrow(VpnError);
  });

  it("initiateHandshake throws HANDSHAKE_IN_PROGRESS if called again before the first one resolves", () => {
    const { a: alice } = trustedPeerPair("alice", "bob");
    alice.initiateHandshake("bob");
    expect(() => alice.initiateHandshake("bob")).toThrow(VpnError);
  });

  // Mutation check P5 (see README's "Mutation checks"): receiveHandshakeResponse must clear the completed
  // attempt out of pendingHandshakes. A mutation that forgot to do so passed every other test (replaying the
  // same message 2 again is harmless, since it just re-derives and re-installs the identical session) -- the
  // only observable effect was THIS: the stale pending entry permanently blocks any later handshake attempt
  // with the same peer, since initiateHandshake's own "already pending" guard sees it and never clears.
  it("a successful handshake clears its pending entry, so a later re-handshake with the same peer is not blocked", () => {
    const { a: alice, b: bob } = trustedPeerPair("alice", "bob");
    handshake(alice, bob);
    expect(alice.hasSession("bob")).toBe(true);

    // If the completed attempt were still sitting in pendingHandshakes, this would throw HANDSHAKE_IN_PROGRESS.
    expect(() => alice.initiateHandshake("bob")).not.toThrow();
  });

  it("the initiator using bob's WRONG static public key never produces a working session", () => {
    const alice = new Peer("alice");
    const bob = new Peer("bob");
    const impostor = new Peer("impostor-of-bob");
    alice.trustPeer("bob", impostor.staticPublicKey); // wrong: not bob's real key
    bob.trustPeer("alice", alice.staticPublicKey);

    const msg1 = alice.initiateHandshake("bob");
    const resultInit = bob.receiveHandshakeInit(msg1);
    expect(resultInit).toEqual({ ok: false, reason: "AUTH_FAILED" });
    expect(alice.hasSession("bob")).toBe(false);
    expect(bob.hasSession("alice")).toBe(false);
  });

  it("the responder trusting the WRONG static public key for the initiator rejects the real initiator", () => {
    const alice = new Peer("alice");
    const bob = new Peer("bob");
    const impostor = new Peer("impostor-of-alice");
    alice.trustPeer("bob", bob.staticPublicKey); // correct
    bob.trustPeer("alice", impostor.staticPublicKey); // wrong: not alice's real key

    const msg1 = alice.initiateHandshake("bob");
    const resultInit = bob.receiveHandshakeInit(msg1);
    expect(resultInit).toEqual({ ok: false, reason: "UNTRUSTED_PEER" });
    expect(alice.hasSession("bob")).toBe(false);
    expect(bob.hasSession("alice")).toBe(false);
  });

  it("a malformed HANDSHAKE_INIT is rejected, not thrown", () => {
    const bob = new Peer("bob");
    const result = bob.receiveHandshakeInit(Buffer.from([1, 2, 3]));
    expect(result).toEqual({ ok: false, reason: "MALFORMED" });
  });

  it("a HANDSHAKE_RESPONSE with no matching pending handshake is rejected, not thrown", () => {
    const { a: alice, b: bob } = trustedPeerPair("alice", "bob");
    const msg1 = alice.initiateHandshake("bob");
    const resultInit = bob.receiveHandshakeInit(msg1);
    expect(resultInit.ok).toBe(true);
    if (!resultInit.ok) return;

    // A fresh alice (no memory of the handshake she started) receives the real response -- there is no
    // pending handshake to match it against.
    const freshAlice = new Peer("alice-again");
    const result = freshAlice.receiveHandshakeResponse(resultInit.response);
    expect(result).toEqual({ ok: false, reason: "NO_PENDING_HANDSHAKE" });
  });

  it("a malformed HANDSHAKE_RESPONSE is rejected, not thrown", () => {
    const { a: alice } = trustedPeerPair("alice", "bob");
    alice.initiateHandshake("bob");
    const result = alice.receiveHandshakeResponse(Buffer.from([2, 2, 3]));
    expect(result).toEqual({ ok: false, reason: "MALFORMED" });
  });

  it("decryptPacket on an unknown session (never handshaked) is rejected, not thrown", () => {
    const { a: alice, b: bob } = trustedPeerPair("alice", "bob");
    handshake(alice, bob);
    const wire = alice.encryptPacket("bob", Buffer.from("hi"));

    const stranger = new Peer("stranger");
    const result = stranger.decryptPacket(wire);
    expect(result).toEqual({ ok: false, reason: "UNKNOWN_SESSION" });
  });

  it("decryptPacket on a malformed buffer is rejected, not thrown", () => {
    const { a: alice } = trustedPeerPair("alice", "bob");
    const result = alice.decryptPacket(Buffer.from([3, 1, 2]));
    expect(result).toEqual({ ok: false, reason: "MALFORMED" });
  });

  it("a replayed transport packet is rejected through the full Peer API", () => {
    const { a: alice, b: bob } = trustedPeerPair("alice", "bob");
    handshake(alice, bob);
    const wire = alice.encryptPacket("bob", Buffer.from("once"));
    expect(bob.decryptPacket(wire)).toEqual({ ok: true, peerName: "alice", payload: Buffer.from("once") });
    expect(bob.decryptPacket(wire)).toEqual({ ok: false, reason: "REPLAY" });
  });

  it("a tampered transport packet is rejected through the full Peer API", () => {
    const { a: alice, b: bob } = trustedPeerPair("alice", "bob");
    handshake(alice, bob);
    const wire = Buffer.from(alice.encryptPacket("bob", Buffer.from("tamper me")));
    wire[wire.length - 1] = (wire[wire.length - 1]! ^ 0xff) & 0xff;
    expect(bob.decryptPacket(wire)).toEqual({ ok: false, reason: "AUTH_FAILED" });
  });

  it("re-trusting a peer under a new key starts a clean slate for future handshakes", () => {
    const alice = new Peer("alice");
    const bob = new Peer("bob");
    const impostor = new Peer("impostor-of-bob");
    alice.trustPeer("bob", impostor.staticPublicKey);
    alice.trustPeer("bob", bob.staticPublicKey); // corrected
    bob.trustPeer("alice", alice.staticPublicKey);

    handshake(alice, bob);
    expect(alice.hasSession("bob")).toBe(true);
  });
});
