// Two peers, Alice and Bob, handshake and exchange a few packets over real UDP loopback sockets. Then one
// deliberately duplicated (replayed) packet and one deliberately tampered packet are injected at the wire
// level to show both get rejected -- never delivered, never a crash.
import { Peer } from "./peer.js";
import { VpnNode } from "./transport.js";

async function main(): Promise<void> {
  const alicePeer = new Peer("alice");
  const bobPeer = new Peer("bob");
  alicePeer.trustPeer("bob", bobPeer.staticPublicKey);
  bobPeer.trustPeer("alice", alicePeer.staticPublicKey);

  const alice = new VpnNode(alicePeer);
  const bob = new VpnNode(bobPeer);
  const alicePort = await alice.bind(0, "127.0.0.1");
  const bobPort = await bob.bind(0, "127.0.0.1");
  console.log(`alice bound to 127.0.0.1:${alicePort}, bob bound to 127.0.0.1:${bobPort}`);

  alice.tun.onReceive((packet) => console.log(`alice received: "${packet.toString("utf8")}"`));
  bob.tun.onReceive((packet) => console.log(`bob received: "${packet.toString("utf8")}"`));
  bob.onDropped((reason) => console.log(`bob dropped a packet -- ${reason}`));

  console.log("\n--- handshake ---");
  await alice.connect("bob", "127.0.0.1", bobPort);
  console.log(`handshake complete: alice.hasSession("bob")=${alicePeer.hasSession("bob")}, bob.hasSession("alice")=${bobPeer.hasSession("alice")}`);

  console.log("\n--- normal transport traffic ---");
  alice.tun.send(Buffer.from("hello from alice, packet 1"));
  bob.tun.send(Buffer.from("hi alice, this is bob"));
  alice.tun.send(Buffer.from("hello from alice, packet 2"));
  await sleep(50); // let the UDP datagrams above actually arrive before moving on

  console.log("\n--- deliberate replay ---");
  const legit = alicePeer.encryptPacket("bob", Buffer.from("please deliver me exactly once"));
  alice.sendRawTo("bob", legit); // first delivery: accepted
  alice.sendRawTo("bob", legit); // exact replay of the same ciphertext+counter: must be rejected
  await sleep(50);

  console.log("\n--- deliberate tamper ---");
  const tampered = Buffer.from(alicePeer.encryptPacket("bob", Buffer.from("this payload will be corrupted")));
  tampered[tampered.length - 1] = (tampered[tampered.length - 1]! ^ 0xff) & 0xff; // flip a byte in the auth tag
  alice.sendRawTo("bob", tampered);
  await sleep(50);

  await alice.close();
  await bob.close();
  console.log("\ndone.");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
