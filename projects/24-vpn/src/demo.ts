// Two peers, Alice and Bob, handshake and exchange a few packets over real UDP loopback sockets. Then one
// deliberately duplicated (replayed) packet and one deliberately tampered packet are injected at the wire
// level to show both get rejected -- never delivered, never a crash. Finally, a Stage 2 rekey: alice's
// session with bob is configured to age out almost immediately, so a real rekey happens transparently while
// traffic keeps flowing across the boundary -- no dropped packet, no interruption either peer notices.
import { Peer } from "./peer.js";
import { VpnNode } from "./transport.js";

async function main(): Promise<void> {
  // rekeyAfterMs is absurdly short on purpose, just so this demo actually shows a rekey happening within a
  // few real wall-clock sleeps below, instead of waiting on anything close to a production-sized threshold.
  const alicePeer = new Peer("alice", { rekeyAfterMs: 150 });
  const bobPeer = new Peer("bob", { rekeyAfterMs: 150 }); // bob never initiates (he's the responder); harmless either way
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

  console.log("\n--- session rekey (Stage 2) ---");
  console.log(`before rekey: alice's session generation with bob = ${alicePeer.sessionGeneration("bob")}`);
  await sleep(150); // let alice's session with bob age past the 150ms rekeyAfterMs threshold configured above

  // Nothing above required any special handling -- sending one more packet right now would already use the
  // OLD session, exactly as before. checkRekey() is what makes the rekey actually happen: it notices the
  // threshold was crossed and starts a brand new handshake over the wire, transparently to the app.
  alice.checkRekey();
  alice.tun.send(Buffer.from("sent right as the rekey handshake is in flight")); // still goes out on the OLD session
  await sleep(50); // let the real rekey handshake (HANDSHAKE_INIT -> HANDSHAKE_RESPONSE) complete over UDP
  console.log(`after rekey: alice's session generation with bob = ${alicePeer.sessionGeneration("bob")}, bob's = ${bobPeer.sessionGeneration("alice")}`);

  alice.tun.send(Buffer.from("sent after the rekey completed")); // now goes out on the NEW session
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
