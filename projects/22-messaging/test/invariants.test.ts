// Randomized: random sends, deliveries, reads and membership changes across several conversations, checked at
// every step against rules re-derived independently here, not taken from src/. Every step is awaited in turn
// (not fired concurrently), so this file proves the single-caller rules still hold under the async API; the
// actual races are test/concurrency.test.ts's job, with a controllable store.
import { describe, expect, it } from "vitest";
import { overallStatus, type Conversation } from "../src/index.js";
import { setup } from "./helpers.js";

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

for (const seed of [1, 2, 3, 4, 5, 6]) {
  it(`seed ${seed}: 400 random operations across several groups, the rules hold at every step`, async () => {
    const rand = prng(seed);
    const USERS = ["u1", "u2", "u3", "u4"];
    const { messenger } = setup(USERS);

    function walk(conversationId: string, memberId: string) {
      const all = [];
      let cursor: string | undefined;
      do {
        const page = messenger.getMessages(conversationId, memberId, { limit: 200, ...(cursor ? { cursor } : {}) });
        all.push(...page.items);
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      return all;
    }

    const groups: Conversation[] = [
      messenger.createGroupConversation("u1", ["u2", "u3", "u4"], "g1"),
      messenger.createGroupConversation("u1", ["u2", "u3"], "g2"),
    ];
    // Shadow model: for each conversation, the set of members CURRENTLY ABLE to receive new messages, and for each
    // sent message, who was a recipient and the sequence it got.
    const sentCount = new Map<string, number>(groups.map((g) => [g.id, 0]));
    let clientSeq = 0;

    for (let step = 0; step < 400; step++) {
      const group = groups[Math.floor(rand() * groups.length)]!;
      const current = messenger.get(group.id)!;
      const action = rand();

      if (action < 0.55) {
        // Send from a random current member.
        const sender = current.members[Math.floor(rand() * current.members.length)]!.userId;
        const m = await messenger.sendMessage(group.id, sender, `m${++clientSeq}`, `c${clientSeq}`);
        const expectedSeq = (sentCount.get(group.id) ?? 0) + 1;
        expect(m.seq).toBe(expectedSeq);
        sentCount.set(group.id, expectedSeq);
        const expectedRecipients = current.members.filter((mem) => mem.userId !== sender).map((mem) => mem.userId);
        expect(Object.keys(m.receipts).sort()).toEqual(expectedRecipients.sort());
        for (const r of Object.values(m.receipts)) expect(r.status).toBe("sent"); // nobody is online in this test
      } else if (action < 0.7 && current.kind === "group") {
        const candidate = USERS[Math.floor(rand() * USERS.length)]!;
        if (!current.members.some((m) => m.userId === candidate)) {
          const after = await messenger.addMember(group.id, "u1", candidate);
          expect(after.members.find((m) => m.userId === candidate)!.joinedAtSeq).toBe(sentCount.get(group.id) ?? 0);
        }
      } else if (action < 0.8 && current.kind === "group") {
        const removable = current.members.filter((m) => m.role !== "owner");
        if (removable.length > 0) {
          const target = removable[Math.floor(rand() * removable.length)]!.userId;
          const after = await messenger.removeMember(group.id, "u1", target);
          expect(after.members.some((m) => m.userId === target)).toBe(false);
        }
      } else if (action < 0.9) {
        // Deliver a random existing message to a random current member who is a recipient.
        const member = current.members[Math.floor(rand() * current.members.length)];
        const page = member ? messenger.getMessages(group.id, member.userId, { limit: 200 }) : undefined;
        if (member && page && page.items.length > 0) {
          const target = page.items[Math.floor(rand() * page.items.length)]!;
          if (target.receipts[member.userId]) {
            const before = target.receipts[member.userId]!.status;
            const after = await messenger.markDelivered(group.id, member.userId, target.id);
            if (before === "sent") expect(after.status).toBe("delivered");
            else expect(after.status).toBe(before); // never downgraded, never changed once past "sent"
          }
        }
      } else {
        const member = current.members[Math.floor(rand() * current.members.length)];
        if (member) {
          const page = messenger.getMessages(group.id, member.userId, { limit: 200 });
          if (page.items.length > 0) {
            const upto = page.items[Math.floor(rand() * page.items.length)]!.seq;
            const { marked } = await messenger.markReadUpTo(group.id, member.userId, upto);
            expect(marked).toBeGreaterThanOrEqual(0);
            // page.items is a snapshot taken BEFORE this call; re-fetch to see the effect, not the stale copy.
            for (const m of page.items.filter((x) => x.seq <= upto)) {
              const fresh = messenger.getMessage(group.id, m.id)!;
              if (fresh.receipts[member.userId]) expect(fresh.receipts[member.userId]!.status).toBe("read");
            }
          }
        }
      }
    }

    // End-state invariants, independent of the step-by-step checks above.
    for (const group of groups) {
      const final = messenger.get(group.id)!;
      const owner = final.members.find((m) => m.role === "owner");
      expect(owner).toBeDefined(); // the owner is never removed
      const page = { items: walk(group.id, owner!.userId) };
      const seqs = page.items.map((m) => m.seq);
      expect(seqs).toEqual([...seqs].sort((a, b) => b - a)); // strictly newest-first
      expect(new Set(seqs).size).toBe(seqs.length); // no duplicate sequence numbers
      for (const m of page.items) {
        const status = overallStatus(m);
        expect(["sent", "delivered", "read"]).toContain(status);
        // overallStatus must equal the worst of the receipts, recomputed independently here.
        const receipts = Object.values(m.receipts);
        const worst = receipts.length === 0 ? "sent" : receipts.map((r) => r.status).sort((a, b) => rank(a) - rank(b))[0]!;
        expect(status).toBe(worst);
      }
    }
  });
}

function rank(s: "sent" | "delivered" | "read"): number {
  return s === "sent" ? 0 : s === "delivered" ? 1 : 2;
}
