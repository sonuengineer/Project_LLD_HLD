// Stage 2: periodic session rekeying. Pure Peer-to-Peer tests (no sockets) exercise the protocol logic
// directly, the same split test/peer.test.ts already uses for stage 1; the last test in this file drives the
// whole thing over real UDP loopback sockets, like test/transport.test.ts and test/invariants.test.ts do.
import { afterEach, describe, expect, it } from "vitest";
import { ManualClock } from "../src/clock.js";
import { VpnError } from "../src/errors.js";
import { Peer } from "../src/peer.js";
import { VpnNode } from "../src/transport.js";
import { trustedPeerPair, waitFor } from "./helpers.js";

// Runs one full handshake (initial, or a rekey -- the wire exchange is identical either way) directly
// between two Peer instances, with no transport in between. Mirrors test/peer.test.ts's own helper.
function handshake(initiator: Peer, responder: Peer): void {
  const msg1 = initiator.initiateHandshake(responder.name);
  const resultInit = responder.receiveHandshakeInit(msg1);
  if (!resultInit.ok) throw new Error(`handshake init rejected: ${resultInit.reason}`);
  const resultResp = initiator.receiveHandshakeResponse(resultInit.response);
  if (!resultResp.ok) throw new Error(`handshake response rejected: ${resultResp.reason}`);
}

describe("session rekeying", () => {
  it("a rekey is NOT due before the configured time threshold is reached", () => {
    const clock = new ManualClock(0);
    const { a: alice, b: bob } = trustedPeerPair("alice", "bob", { clock, rekeyAfterMs: 1000 });
    handshake(alice, bob);

    clock.advance(999);
    expect(alice.checkRekey(clock.now())).toEqual([]);
  });

  it("a rekey triggers automatically once the configured time threshold is reached (ManualClock.advance)", () => {
    const clock = new ManualClock(0);
    const { a: alice, b: bob } = trustedPeerPair("alice", "bob", { clock, rekeyAfterMs: 1000 });
    handshake(alice, bob);

    clock.advance(1000);
    expect(alice.checkRekey(clock.now())).toEqual([{ peerName: "bob", reason: "TIME" }]);
    // The responder never rekeys on its own, no matter how much time passes -- only the original initiator does.
    expect(bob.checkRekey(clock.now())).toEqual([]);
  });

  it("a rekey triggers once a configured message-count threshold is reached, independent of elapsed time", () => {
    const clock = new ManualClock(0);
    const { a: alice, b: bob } = trustedPeerPair("alice", "bob", { clock, rekeyAfterMessages: 3 });
    handshake(alice, bob);

    alice.encryptPacket("bob", Buffer.from("1"));
    alice.encryptPacket("bob", Buffer.from("2"));
    expect(alice.checkRekey(clock.now())).toEqual([]);
    alice.encryptPacket("bob", Buffer.from("3"));
    expect(alice.checkRekey(clock.now())).toEqual([{ peerName: "bob", reason: "MESSAGES" }]);
  });

  it("checkRekey does not re-report a peer while a rekey attempt is already pending", () => {
    const clock = new ManualClock(0);
    const { a: alice, b: bob } = trustedPeerPair("alice", "bob", { clock, rekeyAfterMs: 1000 });
    handshake(alice, bob);
    clock.advance(1000);

    expect(alice.checkRekey(clock.now())).toEqual([{ peerName: "bob", reason: "TIME" }]);
    alice.initiateHandshake("bob"); // the caller (VpnNode in real use) would do this for every entry checkRekey returned
    expect(alice.checkRekey(clock.now())).toEqual([]); // already pending -- not reported again
  });

  it("a rekey produces a new session: generation increments and the session is still usable both ways", () => {
    const { a: alice, b: bob } = trustedPeerPair("alice", "bob");
    handshake(alice, bob);
    expect(alice.sessionGeneration("bob")).toBe(1);
    expect(bob.sessionGeneration("alice")).toBe(1);

    handshake(alice, bob); // a manual rekey -- identical wire exchange to the original handshake
    expect(alice.sessionGeneration("bob")).toBe(2);
    expect(bob.sessionGeneration("alice")).toBe(2);

    const wire = alice.encryptPacket("bob", Buffer.from("on the new session"));
    expect(bob.decryptPacket(wire)).toEqual({ ok: true, peerName: "alice", payload: Buffer.from("on the new session") });
  });

  it("a packet encrypted on the OLD session right before a rekey still decrypts correctly after the new session exists", () => {
    const { a: alice, b: bob } = trustedPeerPair("alice", "bob");
    handshake(alice, bob);

    const inFlight = alice.encryptPacket("bob", Buffer.from("sent just before the rekey"));

    handshake(alice, bob); // rekey: bob now has a NEW current session for "alice", but the old one must still work
    expect(bob.sessionGeneration("alice")).toBe(2);

    const result = bob.decryptPacket(inFlight);
    expect(result).toEqual({ ok: true, peerName: "alice", payload: Buffer.from("sent just before the rekey") });
  });

  it("the old and new sessions' anti-replay windows are independent (same counter value accepted on each)", () => {
    const { a: alice, b: bob } = trustedPeerPair("alice", "bob");
    handshake(alice, bob);

    // Counter 0 on the OLD session.
    const oldWire = alice.encryptPacket("bob", Buffer.from("old-counter-0"));

    handshake(alice, bob); // rekey -- the new session starts its OWN counter at 0 too

    // Counter 0 on the NEW session -- a completely different nonce space, even though the wire counter is
    // numerically identical to the old packet's.
    const newWire = alice.encryptPacket("bob", Buffer.from("new-counter-0"));

    expect(bob.decryptPacket(oldWire)).toEqual({ ok: true, peerName: "alice", payload: Buffer.from("old-counter-0") });
    expect(bob.decryptPacket(newWire)).toEqual({ ok: true, peerName: "alice", payload: Buffer.from("new-counter-0") });

    // Each window independently rejects its OWN exact replay...
    expect(bob.decryptPacket(oldWire)).toEqual({ ok: false, reason: "REPLAY" });
    expect(bob.decryptPacket(newWire)).toEqual({ ok: false, reason: "REPLAY" });
  });

  it("the old session is retired (its grace period expires) and then stops accepting packets entirely", () => {
    const clock = new ManualClock(0);
    const { a: alice, b: bob } = trustedPeerPair("alice", "bob", { clock, rekeyGraceMs: 500 });
    handshake(alice, bob);
    const oldWire = alice.encryptPacket("bob", Buffer.from("will outlive its session"));

    handshake(alice, bob); // rekey -- old session now retiring on bob's side, retireAt = now(0) + 500

    clock.advance(499);
    bob.pruneRetiredSessions(clock.now());
    // Still within grace: the old session is still reachable.
    expect(bob.decryptPacket(oldWire)).toEqual({ ok: true, peerName: "alice", payload: Buffer.from("will outlive its session") });

    // Build a second old-session packet to test retirement against (the first one is now REPLAY, not useful).
    // We can't encrypt on bob's side with alice's send key, so instead advance past the deadline and confirm
    // the OLD wire packet -- which just succeeded above -- is a REPLAY, while a FRESH attempt to decrypt a
    // never-before-seen counter from that same (now-expired) receiverId reports UNKNOWN_SESSION once pruned.
    clock.advance(2); // now 501 since rekey: past the 500ms grace deadline
    bob.pruneRetiredSessions(clock.now());
    expect(bob.decryptPacket(oldWire)).toEqual({ ok: false, reason: "UNKNOWN_SESSION" });
  });

  it("a lost rekey HANDSHAKE_INIT does not disrupt the still-valid old session, and a later rekey attempt succeeds", () => {
    const clock = new ManualClock(0);
    const { a: alice, b: bob } = trustedPeerPair("alice", "bob", { clock, rekeyAfterMs: 1000, rekeyRetryMs: 500 });
    handshake(alice, bob);
    clock.advance(1000);

    expect(alice.checkRekey(clock.now())).toEqual([{ peerName: "bob", reason: "TIME" }]);
    alice.initiateHandshake("bob"); // built, but never delivered to bob -- simulates a dropped HANDSHAKE_INIT

    // Ongoing traffic on the still-current OLD session is completely unaffected.
    const wire = alice.encryptPacket("bob", Buffer.from("still works while a rekey is stuck"));
    expect(bob.decryptPacket(wire)).toEqual({ ok: true, peerName: "alice", payload: Buffer.from("still works while a rekey is stuck") });
    expect(alice.sessionGeneration("bob")).toBe(1); // no rekey has actually landed

    // Before the retry window elapses, checkRekey must not pile on a second attempt.
    clock.advance(499);
    expect(alice.checkRekey(clock.now())).toEqual([]);

    // Once it elapses, the stale attempt is abandoned and the peer is due again.
    clock.advance(1);
    expect(alice.checkRekey(clock.now())).toEqual([{ peerName: "bob", reason: "TIME" }]);

    const retryMsg = alice.initiateHandshake("bob"); // this time it actually arrives
    const resultInit = bob.receiveHandshakeInit(retryMsg);
    expect(resultInit.ok).toBe(true);
    if (!resultInit.ok) return;
    const resultResp = alice.receiveHandshakeResponse(resultInit.response);
    expect(resultResp.ok).toBe(true);

    expect(alice.sessionGeneration("bob")).toBe(2);
    expect(bob.sessionGeneration("alice")).toBe(2);
  });

  it("a second rekey landing before the first's grace period elapses immediately retires the earlier retiring session", () => {
    const clock = new ManualClock(0);
    const { a: alice, b: bob } = trustedPeerPair("alice", "bob", { clock, rekeyGraceMs: 10_000 });
    handshake(alice, bob);
    const gen1Wire = alice.encryptPacket("bob", Buffer.from("generation 1"));

    handshake(alice, bob); // -> generation 2; generation 1 becomes retiring (grace deadline far in the future)
    expect(bob.decryptPacket(gen1Wire)).toEqual({ ok: true, peerName: "alice", payload: Buffer.from("generation 1") });

    const gen2Wire = alice.encryptPacket("bob", Buffer.from("generation 2"));
    handshake(alice, bob); // -> generation 3; generation 2 becomes retiring, generation 1 (still "retiring") is dropped now

    expect(bob.sessionGeneration("alice")).toBe(3);
    // Generation 1's receiverId is gone immediately, well before its own 10s grace period would have elapsed.
    expect(bob.decryptPacket(gen1Wire)).toEqual({ ok: false, reason: "UNKNOWN_SESSION" });
    // Generation 2 is still the (newly) retiring session and still works.
    expect(bob.decryptPacket(gen2Wire)).toEqual({ ok: true, peerName: "alice", payload: Buffer.from("generation 2") });
  });

  it("a Peer built with no rekey options never rekeys, matching stage 1 behavior exactly", () => {
    const { a: alice } = trustedPeerPair("alice", "bob");
    expect(alice.checkRekey()).toEqual([]);
  });

  it("checkRekey does not abandon a pending FIRST handshake with no established session yet", () => {
    const clock = new ManualClock(0);
    const { a: alice } = trustedPeerPair("alice", "bob", { clock, rekeyRetryMs: 100 });
    alice.initiateHandshake("bob"); // first-ever handshake with bob -- no session exists yet

    clock.advance(200); // well past rekeyRetryMs
    alice.checkRekey(clock.now()); // the stale-rekey-attempt sweep must NOT touch this: it is not a rekey
    expect(() => alice.initiateHandshake("bob")).toThrow(VpnError); // still HANDSHAKE_IN_PROGRESS -- never abandoned
  });

  it("the original RESPONDER manually re-handshaking does not make it eligible for automatic rekeying", () => {
    const clock = new ManualClock(0);
    const { a: alice, b: bob } = trustedPeerPair("alice", "bob", { clock, rekeyAfterMs: 100 });
    handshake(alice, bob); // alice = initiator, bob = responder, for this peer pair

    // bob manually re-handshakes with alice -- Peer-level APIs allow calling initiateHandshake for anyone
    // already trusted, regardless of which side originally dialed. This is not the normal rekey flow.
    const msg1 = bob.initiateHandshake("alice");
    const resultInit = alice.receiveHandshakeInit(msg1);
    expect(resultInit.ok).toBe(true);
    if (!resultInit.ok) return;
    const resultResp = bob.receiveHandshakeResponse(resultInit.response);
    expect(resultResp.ok).toBe(true);

    clock.advance(100);
    // bob's role is still the ORIGINAL "responder" -- acting as initiator once does not flip it, so bob
    // never becomes eligible for automatic rekeying just because it manually re-handshaked.
    expect(bob.checkRekey(clock.now())).toEqual([]);
  });

  it("decryptPacket automatically prunes an expired retiring session, with no explicit pruneRetiredSessions() call", () => {
    const clock = new ManualClock(0);
    const { a: alice, b: bob } = trustedPeerPair("alice", "bob", { clock, rekeyGraceMs: 100 });
    handshake(alice, bob);
    const oldWire = alice.encryptPacket("bob", Buffer.from("old"));

    handshake(alice, bob); // rekey -- bob's old session for "alice" starts retiring, retireAt = 0 + 100
    clock.advance(100); // exactly at the grace deadline

    // No explicit pruneRetiredSessions() call here -- decryptPacket's own internal housekeeping must catch it.
    expect(bob.decryptPacket(oldWire)).toEqual({ ok: false, reason: "UNKNOWN_SESSION" });
  });
});

describe("session rekeying over real UDP loopback", () => {
  const openNodes: VpnNode[] = [];
  afterEach(async () => {
    await Promise.all(openNodes.map((n) => n.close()));
    openNodes.length = 0;
  });

  it("packets sent across two rekey boundaries all arrive exactly once, with no corruption", async () => {
    const clock = new ManualClock(0);
    const peerA = new Peer("alice", { clock, rekeyAfterMs: 50 });
    const peerB = new Peer("bob", { clock, rekeyAfterMs: 50 }); // bob never initiates (responder role); harmless to configure
    peerA.trustPeer("bob", peerB.staticPublicKey);
    peerB.trustPeer("alice", peerA.staticPublicKey);

    const a = new VpnNode(peerA);
    const b = new VpnNode(peerB);
    openNodes.push(a, b);
    const portB = await b.bind(0, "127.0.0.1");
    await a.bind(0, "127.0.0.1");
    await a.connect("bob", "127.0.0.1", portB);
    expect(peerA.sessionGeneration("bob")).toBe(1);

    const receivedAtB: Buffer[] = [];
    b.tun.onReceive((p) => receivedAtB.push(p));

    const sentTexts: string[] = [];
    function sendBatch(label: string, count: number): void {
      for (let i = 0; i < count; i++) {
        const text = `${label}-${i}`;
        sentTexts.push(text);
        a.tun.send(Buffer.from(text));
      }
    }

    sendBatch("before-any-rekey", 5);
    await waitFor(() => receivedAtB.length === sentTexts.length);

    // First rekey boundary: advance past the threshold, kick off the real handshake over UDP, and send more
    // packets WHILE it is in flight -- some land on generation 1 (sent before alice's local session flips),
    // some may land on generation 2, depending on exactly when bob's response arrives. Either way, nothing
    // should be lost or corrupted.
    clock.advance(60);
    a.checkRekey();
    sendBatch("straddling-rekey-1", 5);
    await waitFor(() => peerA.sessionGeneration("bob") === 2);
    sendBatch("after-rekey-1", 5);
    await waitFor(() => receivedAtB.length === sentTexts.length);

    // Second rekey boundary, same shape.
    clock.advance(60);
    a.checkRekey();
    sendBatch("straddling-rekey-2", 5);
    await waitFor(() => peerA.sessionGeneration("bob") === 3);
    sendBatch("after-rekey-2", 5);
    await waitFor(() => receivedAtB.length === sentTexts.length);

    expect(receivedAtB.map((p) => p.toString("utf8")).sort()).toEqual(sentTexts.slice().sort());
    expect(peerB.sessionGeneration("alice")).toBe(3);
  });

  it("stopRekeyTimer actually stops the periodic rekey check from firing again", async () => {
    const clock = new ManualClock(0);
    const peerA = new Peer("alice", { clock, rekeyAfterMs: 1 });
    const peerB = new Peer("bob", { clock, rekeyAfterMs: 1 });
    peerA.trustPeer("bob", peerB.staticPublicKey);
    peerB.trustPeer("alice", peerA.staticPublicKey);
    const a = new VpnNode(peerA);
    const b = new VpnNode(peerB);
    openNodes.push(a, b);
    const portB = await b.bind(0, "127.0.0.1");
    await a.bind(0, "127.0.0.1");
    await a.connect("bob", "127.0.0.1", portB);
    expect(peerA.sessionGeneration("bob")).toBe(1);

    a.startRekeyTimer(5);
    a.stopRekeyTimer();
    clock.advance(1000); // well past the threshold -- but the timer that would have noticed is stopped
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(peerA.sessionGeneration("bob")).toBe(1); // no rekey happened
  });

  it("close() stops any running rekey timer so it never fires into an already-closed socket", async () => {
    const clock = new ManualClock(0);
    const peerA = new Peer("alice", { clock, rekeyAfterMs: 1 });
    const peerB = new Peer("bob", { clock, rekeyAfterMs: 1 });
    peerA.trustPeer("bob", peerB.staticPublicKey);
    peerB.trustPeer("alice", peerA.staticPublicKey);
    const a = new VpnNode(peerA);
    const b = new VpnNode(peerB);
    openNodes.push(b); // close `a` manually below -- closing it twice via afterEach would throw
    const portB = await b.bind(0, "127.0.0.1");
    await a.bind(0, "127.0.0.1");
    await a.connect("bob", "127.0.0.1", portB);

    a.startRekeyTimer(5);
    clock.advance(1000);
    await a.close(); // must stop the timer as a side effect, before any pending tick can fire
    await new Promise((resolve) => setTimeout(resolve, 50)); // if the timer survived close(), it would fire here
    expect(peerA.sessionGeneration("bob")).toBe(1); // no rekey happened after close()
  });
});
