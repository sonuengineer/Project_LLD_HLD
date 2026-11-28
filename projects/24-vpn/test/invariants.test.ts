// Randomized, real-UDP-socket invariant test. For each seed: two VpnNodes handshake over real loopback UDP,
// then a schedule of packets in both directions is built (each payload unique), deliberately shuffled within
// small local windows to simulate reordering, with ~10% of entries additionally sent a second time to
// simulate duplication, and a few deliberately tampered entries thrown in. The schedule is dispatched onto
// the REAL sockets in that shuffled order via VpnNode.sendRawTo (bypassing the TunDevice auto-pipeline only so
// this test controls ORDER and repetition explicitly -- loopback UDP on one machine will not reorder or drop
// packets on its own, so "simulated" here means the test chooses the order/repeats, while every encrypt,
// decrypt, AEAD check and anti-replay check is the real thing, over a real socket).
//
// Invariant checked at the end, independent of the step-by-step sends: every originally-sent, non-tampered
// payload is delivered to the recipient's InMemoryTunDevice EXACTLY once, with no corruption, regardless of
// delivery order; every duplicate and every tampered packet is dropped and never delivered.
import { afterEach, describe, expect, it } from "vitest";
import { VpnNode } from "../src/transport.js";
import { connectedNodePair, waitFor } from "./helpers.js";

function prng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface ScheduleEntry {
  id: string;
  direction: "aToB" | "bToA";
  wire: Buffer;
  expectedPayload: Buffer;
  tampered: boolean;
  duplicateOf?: string; // set on the synthetic duplicate entry, pointing at the original's id
}

describe("randomized invariants over real UDP", () => {
  const openNodes: VpnNode[] = [];
  afterEach(async () => {
    await Promise.all(openNodes.map((n) => n.close()));
    openNodes.length = 0;
  });

  for (const seed of [1, 2, 3, 4, 5]) {
    it(`seed ${seed}: every unique payload delivered exactly once, replays and tampers never delivered`, async () => {
      const rand = prng(seed);
      const { a, b, peerA, peerB } = await connectedNodePair();
      openNodes.push(a, b);

      const receivedAtA: Buffer[] = [];
      const receivedAtB: Buffer[] = [];
      const droppedAtA: string[] = [];
      const droppedAtB: string[] = [];
      a.tun.onReceive((p) => receivedAtA.push(p));
      b.tun.onReceive((p) => receivedAtB.push(p));
      a.onDropped((reason) => droppedAtA.push(reason));
      b.onDropped((reason) => droppedAtB.push(reason));

      const PACKET_COUNT = 300;
      const originals: ScheduleEntry[] = [];
      for (let i = 0; i < PACKET_COUNT; i++) {
        const direction: "aToB" | "bToA" = rand() < 0.5 ? "aToB" : "bToA";
        const payload = Buffer.from(`seed${seed}-pkt${i}-${direction}`);
        const wire = direction === "aToB" ? peerA.encryptPacket("bob", payload) : peerB.encryptPacket("alice", payload);
        originals.push({ id: `p${i}`, direction, wire, expectedPayload: payload, tampered: false });
      }

      // Build the final dispatch schedule: shuffle originals within small local windows (keeps every packet
      // well inside the 2048-counter anti-replay window regardless of shuffle), then splice in duplicates and
      // a handful of tampered copies.
      const schedule: ScheduleEntry[] = [];
      const CHUNK = 20;
      for (let start = 0; start < originals.length; start += CHUNK) {
        const chunk = originals.slice(start, start + CHUNK);
        for (let i = chunk.length - 1; i > 0; i--) {
          const j = Math.floor(rand() * (i + 1));
          [chunk[i], chunk[j]] = [chunk[j]!, chunk[i]!];
        }
        schedule.push(...chunk);
      }

      let tamperedCount = 0;
      let duplicateCount = 0;
      const finalSchedule: ScheduleEntry[] = [];
      for (const entry of schedule) {
        finalSchedule.push(entry);
        if (rand() < 0.1) {
          duplicateCount++;
          finalSchedule.push({ ...entry, id: `${entry.id}-dup`, duplicateOf: entry.id });
        }
        if (rand() < 0.03) {
          tamperedCount++;
          const corrupted = Buffer.from(entry.wire);
          corrupted[corrupted.length - 1] = (corrupted[corrupted.length - 1]! ^ 0xff) & 0xff;
          finalSchedule.push({ ...entry, id: `${entry.id}-tamper`, wire: corrupted, tampered: true });
        }
      }

      for (const entry of finalSchedule) {
        const node = entry.direction === "aToB" ? a : b;
        const peerName = entry.direction === "aToB" ? "bob" : "alice";
        node.sendRawTo(peerName, entry.wire);
      }

      const expectedDeliveries = originals.length;
      const expectedDrops = duplicateCount + tamperedCount;
      await waitFor(() => receivedAtA.length + receivedAtB.length >= expectedDeliveries && droppedAtA.length + droppedAtB.length >= expectedDrops, 5000);

      // Exactly once, no corruption: every original payload appears exactly once across both inboxes.
      const deliveredTexts = [...receivedAtA, ...receivedAtB].map((p) => p.toString("utf8")).sort();
      const expectedTexts = originals.map((o) => o.expectedPayload.toString("utf8")).sort();
      expect(deliveredTexts).toEqual(expectedTexts);

      // Every dropped reason is a replay or an auth failure -- nothing crashed, nothing was silently ignored
      // for an unexplained reason.
      for (const reason of [...droppedAtA, ...droppedAtB]) {
        expect(reason).toMatch(/REPLAY|AUTH_FAILED/);
      }
      expect(droppedAtA.length + droppedAtB.length).toBe(expectedDrops);
    });
  }
});
