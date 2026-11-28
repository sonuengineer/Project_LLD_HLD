import { Peer } from "../src/peer.js";
import { VpnNode } from "../src/transport.js";

// A pair of Peers that already trust each other's REAL static public key -- the common starting point for
// most tests. Tests that want to exercise the "wrong public key" failure build their own pair instead.
export function trustedPeerPair(nameA = "alice", nameB = "bob"): { a: Peer; b: Peer } {
  const a = new Peer(nameA);
  const b = new Peer(nameB);
  a.trustPeer(nameB, b.staticPublicKey);
  b.trustPeer(nameA, a.staticPublicKey);
  return { a, b };
}

// A pair of connected VpnNodes on real UDP loopback sockets, handshake already completed. Callers must
// close() both when done (see afterEach in the test files that use this).
export async function connectedNodePair(nameA = "alice", nameB = "bob"): Promise<{ a: VpnNode; b: VpnNode; peerA: Peer; peerB: Peer }> {
  const { a: peerA, b: peerB } = trustedPeerPair(nameA, nameB);
  const a = new VpnNode(peerA);
  const b = new VpnNode(peerB);
  const portA = await a.bind(0, "127.0.0.1");
  const portB = await b.bind(0, "127.0.0.1");
  await a.connect(nameB, "127.0.0.1", portB);
  return { a, b, peerA, peerB };
}

export function waitFor(predicate: () => boolean, timeoutMs = 2000, intervalMs = 5): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`waitFor() timed out after ${timeoutMs}ms`));
        return;
      }
      setTimeout(check, intervalMs);
    };
    check();
  });
}
