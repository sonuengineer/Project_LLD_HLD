// VpnNode over REAL UDP loopback sockets -- the end-to-end path the project brief asks for: app writes to its
// TunDevice -> encrypt -> real UDP send -> the other peer's real UDP socket receives -> decrypt -> delivered
// to ITS TunDevice. Everything here is event-driven (awaiting the actual connect()/onReceive()/onDropped()
// callbacks), never a blind sleep -- the one exception is a short, generous drain wait after a batch of
// fire-and-forget UDP sends, which is waiting for real async I/O to finish, not papering over a race in the
// protocol logic itself (see helpers.ts's waitFor, which polls a real condition rather than sleeping blindly).
import { afterEach, describe, expect, it } from "vitest";
import { Peer } from "../src/peer.js";
import { VpnNode } from "../src/transport.js";
import { connectedNodePair, trustedPeerPair, waitFor } from "./helpers.js";

describe("VpnNode over real UDP loopback", () => {
  const openNodes: VpnNode[] = [];
  afterEach(async () => {
    await Promise.all(openNodes.map((n) => n.close()));
    openNodes.length = 0;
  });

  async function pair() {
    const { a, b, peerA, peerB } = await connectedNodePair();
    openNodes.push(a, b);
    return { a, b, peerA, peerB };
  }

  it("handshakes over real sockets and both sides end up with a working session", async () => {
    const { peerA, peerB } = await pair();
    expect(peerA.hasSession("bob")).toBe(true);
    expect(peerB.hasSession("alice")).toBe(true);
  });

  it("a packet written to alice's TunDevice arrives at bob's TunDevice, byte for byte", async () => {
    const { a, b } = await pair();
    const received: Buffer[] = [];
    b.tun.onReceive((p) => received.push(p));

    a.tun.send(Buffer.from("hello over real udp"));
    await waitFor(() => received.length === 1);
    expect(received[0]!.toString("utf8")).toBe("hello over real udp");
  });

  it("works in both directions: bob learns alice's address from the handshake and can send back", async () => {
    const { a, b } = await pair();
    const atAlice: Buffer[] = [];
    const atBob: Buffer[] = [];
    a.tun.onReceive((p) => atAlice.push(p));
    b.tun.onReceive((p) => atBob.push(p));

    a.tun.send(Buffer.from("from alice"));
    b.tun.send(Buffer.from("from bob"));
    await waitFor(() => atAlice.length === 1 && atBob.length === 1);
    expect(atBob[0]!.toString("utf8")).toBe("from alice");
    expect(atAlice[0]!.toString("utf8")).toBe("from bob");
  });

  it("several packets in a row all arrive, in order, over the real socket", async () => {
    const { a, b } = await pair();
    const received: Buffer[] = [];
    b.tun.onReceive((p) => received.push(p));

    for (let i = 0; i < 10; i++) a.tun.send(Buffer.from(`packet-${i}`));
    await waitFor(() => received.length === 10);
    expect(received.map((p) => p.toString("utf8"))).toEqual(Array.from({ length: 10 }, (_, i) => `packet-${i}`));
  });

  it("a wire-level replay (the exact same encrypted bytes sent twice) is dropped the second time, not delivered twice", async () => {
    const { a, b, peerA } = await pair();
    const received: Buffer[] = [];
    const dropped: string[] = [];
    b.tun.onReceive((p) => received.push(p));
    b.onDropped((reason) => dropped.push(reason));

    const wire = peerA.encryptPacket("bob", Buffer.from("deliver me once"));
    a.sendRawTo("bob", wire);
    a.sendRawTo("bob", wire); // exact replay
    await waitFor(() => received.length === 1 && dropped.length === 1);
    expect(received[0]!.toString("utf8")).toBe("deliver me once");
    expect(dropped[0]).toMatch(/REPLAY/);
  });

  it("a wire-level tampered packet is dropped and never delivered", async () => {
    const { a, b, peerA } = await pair();
    const received: Buffer[] = [];
    const dropped: string[] = [];
    b.tun.onReceive((p) => received.push(p));
    b.onDropped((reason) => dropped.push(reason));

    const wire = Buffer.from(peerA.encryptPacket("bob", Buffer.from("do not corrupt")));
    wire[wire.length - 1] = (wire[wire.length - 1]! ^ 0xff) & 0xff;
    a.sendRawTo("bob", wire);
    await waitFor(() => dropped.length === 1);
    expect(received).toHaveLength(0);
    expect(dropped[0]).toMatch(/AUTH_FAILED/);
  });

  it("connect() rejects when the initiator has the wrong static public key for the responder", async () => {
    const alice = new Peer("alice");
    const bob = new Peer("bob");
    const impostor = new Peer("impostor");
    alice.trustPeer("bob", impostor.staticPublicKey);
    bob.trustPeer("alice", alice.staticPublicKey);

    const aNode = new VpnNode(alice);
    const bNode = new VpnNode(bob);
    openNodes.push(aNode, bNode);
    const bPort = await bNode.bind(0, "127.0.0.1");

    await expect(aNode.connect("bob", "127.0.0.1", bPort, 300)).rejects.toThrow(/timed out/);
    expect(alice.hasSession("bob")).toBe(false);
    expect(bob.hasSession("alice")).toBe(false);
  });

  it("sendRawTo throws for a peer whose address is not known yet", async () => {
    const { a: alicePeer } = trustedPeerPair("alice", "bob");
    const node = new VpnNode(alicePeer);
    openNodes.push(node);
    await node.bind(0, "127.0.0.1");
    expect(() => node.sendRawTo("bob", Buffer.from([1]))).toThrow();
  });
});
