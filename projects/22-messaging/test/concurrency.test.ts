// The whole point of stage 2: every mutation now means a real async round trip to a ConversationStore, and two
// operations can be mid-round-trip on the SAME conversation at once. Every test here uses a
// FakeConversationStore whose persist() never resolves on its own, so the test controls exactly how two
// operations interleave -- mirrors 23-password-manager's test/concurrency.test.ts (itself mirroring
// 17-parking-lot's FakeDevice).
import { describe, expect, it } from "vitest";
import { overallStatus } from "../src/index.js";
import { FakeConversationStore, flush, setup } from "./helpers.js";

// Awaits the synchronous part of `promise` having run (so its commit is already queued), resolves the OLDEST
// pending commit, then returns the settled value. For straightforward setup steps where interleaving does not
// matter -- the actual races below choreograph resolveNext()/resolveAt() by hand instead.
async function settle<T>(store: FakeConversationStore, promise: Promise<T>): Promise<T> {
  await flush();
  store.resolveNext();
  return promise;
}

describe("two sends on the same conversation at the same time", () => {
  it("sequence numbers never collide or skip, regardless of which commit resolves first", async () => {
    const store = new FakeConversationStore();
    const { messenger } = setup(["u1", "u2"], { store });
    const conv = messenger.createDirectConversation("u1", "u2");

    const sendA = messenger.sendMessage(conv.id, "u1", "from u1", "ca");
    const sendB = messenger.sendMessage(conv.id, "u2", "from u2", "cb");
    await flush();
    expect(store.pending).toHaveLength(2);

    // Resolve in the OPPOSITE order from how the calls were made -- the outcome must not depend on this.
    store.resolveAt(1);
    store.resolveAt(0);
    const [a, b] = await Promise.all([sendA, sendB]);

    expect(new Set([a.seq, b.seq]).size).toBe(2);
    expect(messenger.get(conv.id)!.nextSeq).toBe(3);
  });
});

describe("the lost-update bug `revising` exists to prevent", () => {
  it("illustration: two concurrent whole-array removes based on the same stale snapshot silently undo each other", async () => {
    // No Messenger involved -- this is the shape of the bug, demonstrated directly. `removeMember` replaces
    // the whole `members` array (not a keyed map), so without a guard, two concurrent removals computed from
    // the SAME pre-await snapshot can only ever survive the LAST one to apply; the other's removal is lost.
    let members = ["u1", "u2", "u3"];
    async function naiveRemove(target: string): Promise<void> {
      const snapshot = members; // read BEFORE any await, exactly like the real removeMember used to
      await Promise.resolve(); // stands in for the commit round trip
      members = snapshot.filter((m) => m !== target); // whole-array replace, not a merge
    }
    await Promise.all([naiveRemove("u2"), naiveRemove("u3")]);
    // If both removals had survived, members would be ["u1"]. One of them was silently lost instead.
    expect(members).toHaveLength(2);
  });
});

describe("removeMember racing another removeMember", () => {
  it("the second one is rejected with CONVERSATION_BUSY -- it never silently loses the first removal", async () => {
    const store = new FakeConversationStore();
    const { messenger } = setup(["u1", "u2", "u3"], { store });
    const group = messenger.createGroupConversation("u1", ["u2", "u3"], "team");

    // removeMember runs synchronously up to its own await -- by the time this line returns, `revising` is
    // already true, before the second removeMember ever gets a chance to run.
    const removeU2 = messenger.removeMember(group.id, "u1", "u2");
    const removeU3 = messenger.removeMember(group.id, "u1", "u3");

    await expect(removeU3).rejects.toMatchObject({ code: "CONVERSATION_BUSY" });
    expect(store.pending).toHaveLength(1); // only removeU2's commit was ever attempted
    store.resolveNext();
    await removeU2;
    expect(messenger.get(group.id)!.members.map((m) => m.userId)).toEqual(["u1", "u3"]);

    // u3 is NOT lost: a later, un-raced removal still works.
    const retry = messenger.removeMember(group.id, "u1", "u3");
    store.resolveNext();
    await retry;
    expect(messenger.get(group.id)!.members.map((m) => m.userId)).toEqual(["u1"]);
  });
});

describe("a message op racing a membership change", () => {
  it("sendMessage started WHILE a membership change is in flight is rejected with CONVERSATION_BUSY", async () => {
    const store = new FakeConversationStore();
    const { messenger } = setup(["u1", "u2", "u3"], { store });
    const group = messenger.createGroupConversation("u1", ["u2", "u3"], "team");

    const removal = messenger.removeMember(group.id, "u1", "u2");
    const send = messenger.sendMessage(group.id, "u1", "hi", "c1");

    await expect(send).rejects.toMatchObject({ code: "CONVERSATION_BUSY" });
    expect(store.pending).toHaveLength(1); // only the removal's commit was ever attempted
    store.resolveNext();
    await removal;
  });

  it("a membership change started WHILE a message op is in flight is rejected with CONVERSATION_BUSY", async () => {
    const store = new FakeConversationStore();
    const { messenger } = setup(["u1", "u2", "u3"], { store });
    const group = messenger.createGroupConversation("u1", ["u2", "u3"], "team");

    const send = messenger.sendMessage(group.id, "u1", "hi", "c1");
    const removal = messenger.removeMember(group.id, "u1", "u2");

    await expect(removal).rejects.toMatchObject({ code: "CONVERSATION_BUSY" });
    expect(store.pending).toHaveLength(1); // only the send's commit was ever attempted
    store.resolveNext();
    await send;

    // the send is NOT lost: a later, un-raced removal still works.
    const retry = messenger.removeMember(group.id, "u1", "u2");
    store.resolveNext();
    const after = await retry;
    expect(after.members.map((m) => m.userId)).toEqual(["u1", "u3"]);
  });
});

describe("concurrent read receipts never regress", () => {
  it("a slower call that started first cannot overwrite a faster call's later read with a stale timestamp", async () => {
    const store = new FakeConversationStore();
    const { messenger, clock } = setup(["u1", "u2"], { store });
    const conv = messenger.createDirectConversation("u1", "u2");
    const m1 = await settle(store, messenger.sendMessage(conv.id, "u1", "one", "c1"));
    await settle(store, messenger.sendMessage(conv.id, "u1", "two", "c2"));
    const m2seq = 2;

    const slow = messenger.markReadUpTo(conv.id, "u2", m1.seq); // starts first, claims pendingOps first
    clock.advance(1000);
    const fast = messenger.markReadUpTo(conv.id, "u2", m2seq); // starts second
    await flush();
    expect(store.pending).toHaveLength(2);

    // Resolve the SECOND call (fast, marks both as read at T0+1000) before the FIRST (slow, m1 only, at T0).
    store.resolveAt(1);
    await fast;
    store.resolveAt(0);
    const slowResult = await slow;

    expect(slowResult.marked).toBe(0); // m1 was already read by the time slow got to apply -- nothing left to do
    const final = messenger.getMessage(conv.id, m1.id)!;
    expect(final.receipts["u2"]!.status).toBe("read");
    expect(final.receipts["u2"]!.at).toBeGreaterThan(final.createdAt); // the LATER timestamp survived, not a stale one
  });

  it("markDelivered resolving AFTER a markReadUpTo for the same message does not downgrade it back to delivered", async () => {
    const store = new FakeConversationStore();
    const { messenger } = setup(["u1", "u2"], { store });
    const conv = messenger.createDirectConversation("u1", "u2");
    const m = await settle(store, messenger.sendMessage(conv.id, "u1", "hi", "c1"));

    const read = messenger.markReadUpTo(conv.id, "u2", m.seq);
    const delivered = messenger.markDelivered(conv.id, "u2", m.id);
    await flush();
    expect(store.pending).toHaveLength(2);

    store.resolveAt(0); // read's commit resolves first
    await read;
    store.resolveAt(0); // delivered's commit resolves second, applying AFTER read already landed
    await delivered;

    expect(messenger.getMessage(conv.id, m.id)!.receipts["u2"]!.status).toBe("read"); // never downgraded
  });
});

describe("an edit racing a delete for the SAME message", () => {
  it("a delete that resolves AFTER an edit still wins -- the message is never resurrected", async () => {
    const store = new FakeConversationStore();
    const { messenger } = setup(["u1", "u2"], { store });
    const conv = messenger.createDirectConversation("u1", "u2");
    const m = await settle(store, messenger.sendMessage(conv.id, "u1", "original", "c1"));

    const edit = messenger.editMessage(conv.id, "u1", m.id, "edited text");
    const del = messenger.deleteMessage(conv.id, "u1", m.id);
    await flush();
    expect(store.pending).toHaveLength(2);

    store.resolveAt(0); // edit's commit resolves first
    await edit;
    store.resolveAt(0); // delete's commit resolves second
    await del;

    const final = messenger.getMessage(conv.id, m.id)!;
    expect(final.deletedAt).not.toBeNull();
    expect(final.body).toBe(""); // not "edited text"
  });

  it("a delete that resolves BEFORE an edit's own apply step still wins -- the edit silently no-ops", async () => {
    const store = new FakeConversationStore();
    const { messenger } = setup(["u1", "u2"], { store });
    const conv = messenger.createDirectConversation("u1", "u2");
    const m = await settle(store, messenger.sendMessage(conv.id, "u1", "original", "c1"));

    const edit = messenger.editMessage(conv.id, "u1", m.id, "edited text"); // passes its precondition before delete claims
    const del = messenger.deleteMessage(conv.id, "u1", m.id);
    await flush();
    expect(store.pending).toHaveLength(2);

    store.resolveAt(1); // delete's commit resolves first
    await del;
    store.resolveAt(0); // edit's commit resolves second, applying AFTER the delete already landed
    const result = await edit;

    expect(result.deletedAt).not.toBeNull(); // the edit's own return value reflects the delete, not its text
    expect(result.body).toBe("");
  });
});

describe("idempotent calls never touch the store", () => {
  it("a repeated markDelivered on an already-delivered message commits nothing", async () => {
    const store = new FakeConversationStore();
    const { messenger } = setup(["u1", "u2"], { store });
    const conv = messenger.createDirectConversation("u1", "u2");
    const m = await settle(store, messenger.sendMessage(conv.id, "u1", "hi", "c1"));
    await settle(store, messenger.markDelivered(conv.id, "u2", m.id));

    const second = messenger.markDelivered(conv.id, "u2", m.id); // already delivered
    expect(store.pending).toHaveLength(0); // resolved without ever reaching the store, not just resolved fast
    await second;
  });

  it("connectDevice's catch-up commits nothing for a conversation where that user has no pending receipt", async () => {
    const store = new FakeConversationStore();
    const { messenger } = setup(["u1", "u2", "u3"], { store });
    const group = messenger.createGroupConversation("u1", ["u2", "u3"], "team");
    const m = await settle(store, messenger.sendMessage(group.id, "u1", "hi", "c1"));
    await settle(store, messenger.markDelivered(group.id, "u2", m.id)); // u2 has nothing pending now; u3 still does

    const connecting = messenger.connectDevice("u2", "phone");
    expect(store.pending).toHaveLength(0); // u2's only conversation had nothing left to catch up
    await connecting;
  });
});

describe("offline catch-up and a membership change in flight", () => {
  it("catch-up skips a conversation that is mid-revision instead of failing connectDevice entirely", async () => {
    const store = new FakeConversationStore();
    const { messenger } = setup(["u1", "u2", "u3", "u4"], { store });
    const busy = messenger.createGroupConversation("u1", ["u3"], "busy-team");
    const free = messenger.createDirectConversation("u2", "u3");
    const mBusy = await settle(store, messenger.sendMessage(busy.id, "u1", "pending in busy", "c1"));
    const mFree = await settle(store, messenger.sendMessage(free.id, "u2", "pending in free", "c2"));

    // u1 adding u4 to `busy` claims `revising` synchronously, before connectDevice ever runs.
    const revision = messenger.addMember(busy.id, "u1", "u4");
    const connecting = messenger.connectDevice("u3", "phone"); // u3 is a member of BOTH busy and free
    await flush();
    // catch-up attempted `busy` first (CONVERSATION_BUSY, caught internally, skipped) and `free` second
    // (succeeded, now pending) -- so only 2 commits are queued: the revision's, and free's catch-up.
    expect(store.pending).toHaveLength(2);

    store.resolveAt(1); // free's catch-up commit
    await connecting;
    expect(overallStatus(messenger.getMessage(free.id, mFree.id)!)).toBe("delivered");
    expect(overallStatus(messenger.getMessage(busy.id, mBusy.id)!)).toBe("sent"); // busy was skipped, not delivered

    store.resolveNext(); // the revision's own commit
    await revision;

    // busy's pending receipt was not lost -- an explicit ack (or the next full reconnect) still delivers it.
    await settle(store, messenger.markDelivered(busy.id, "u3", mBusy.id));
    expect(overallStatus(messenger.getMessage(busy.id, mBusy.id)!)).toBe("delivered");
  });
});
