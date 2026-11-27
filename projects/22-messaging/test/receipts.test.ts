import { describe, expect, it } from "vitest";
import { overallStatus } from "../src/index.js";
import { asyncErrorCode, setup } from "./helpers.js";

describe("markDelivered", () => {
  it("sent -> delivered; calling again (or after read) is a no-op, never downgrades", async () => {
    const { messenger } = setup();
    const conv = messenger.createDirectConversation("u1", "u2");
    const m = await messenger.sendMessage(conv.id, "u1", "hi", "c1");
    expect(await messenger.markDelivered(conv.id, "u2", m.id)).toMatchObject({ status: "delivered" });
    expect(await messenger.markDelivered(conv.id, "u2", m.id)).toMatchObject({ status: "delivered" }); // idempotent
    await messenger.markReadUpTo(conv.id, "u2", m.seq);
    expect(await messenger.markDelivered(conv.id, "u2", m.id)).toMatchObject({ status: "read" }); // not downgraded
  });

  it("the sender, an unknown message, a non-member, or a recipient who joined after it was sent all throw", async () => {
    const { messenger } = setup();
    const group = messenger.createGroupConversation("u1", ["u2"], "team");
    const m = await messenger.sendMessage(group.id, "u1", "hi", "c1");
    await messenger.addMember(group.id, "u1", "u3"); // u3 joins after m was sent
    expect(await asyncErrorCode(() => messenger.markDelivered(group.id, "u1", m.id))).toBe("UNKNOWN_MESSAGE"); // sender
    expect(await asyncErrorCode(() => messenger.markDelivered(group.id, "u2", "ghost"))).toBe("UNKNOWN_MESSAGE");
    expect(await asyncErrorCode(() => messenger.markDelivered(group.id, "ghost-user", m.id))).toBe("NOT_A_MEMBER");
    expect(await asyncErrorCode(() => messenger.markDelivered(group.id, "u3", m.id))).toBe("UNKNOWN_MESSAGE"); // joined later
  });

  it("a messageId from a DIFFERENT conversation is not found here either", async () => {
    const { messenger } = setup();
    const a = messenger.createDirectConversation("u1", "u2");
    const b = messenger.createDirectConversation("u1", "u3");
    const m = await messenger.sendMessage(a.id, "u1", "hi", "c1");
    expect(await asyncErrorCode(() => messenger.markDelivered(b.id, "u3", m.id))).toBe("UNKNOWN_MESSAGE");
  });

  it("scoping holds even when the recipient is a genuine recipient of that message IN ITS REAL conversation: a "
    + "message cannot be acted on through a conversation it does not belong to", async () => {
    const { messenger } = setup();
    const a = messenger.createDirectConversation("u1", "u2"); // u2 is a real recipient here
    const b = messenger.createDirectConversation("u2", "u3"); // u2 is also a member here, of a DIFFERENT conversation
    const m = await messenger.sendMessage(a.id, "u1", "hi", "c1"); // m.receipts has a real entry for u2
    expect(await asyncErrorCode(() => messenger.markDelivered(b.id, "u2", m.id))).toBe("UNKNOWN_MESSAGE");
    expect(messenger.getMessage(a.id, m.id)!.receipts["u2"]).toEqual({ status: "sent", at: expect.any(Number) });
  });
});

describe("markReadUpTo", () => {
  it("marks every message up to and including uptoSeq as read for that recipient; later messages are untouched", async () => {
    const { messenger } = setup();
    const conv = messenger.createDirectConversation("u1", "u2");
    const m1 = await messenger.sendMessage(conv.id, "u1", "one", "c1");
    const m2 = await messenger.sendMessage(conv.id, "u1", "two", "c2");
    await messenger.sendMessage(conv.id, "u1", "three", "c3");
    const { marked } = await messenger.markReadUpTo(conv.id, "u2", m2.seq);
    expect(marked).toBe(2);
    expect(overallStatus(messenger.getMessage(conv.id, m1.id)!)).toBe("read");
    expect(overallStatus(messenger.getMessage(conv.id, m2.id)!)).toBe("read");
    const newest = messenger.getMessages(conv.id, "u2").items[0]!;
    expect(newest.body).toBe("three");
    expect(overallStatus(newest)).toBe("sent");
  });

  it("is idempotent: marking the same range again marks 0 more", async () => {
    const { messenger } = setup();
    const conv = messenger.createDirectConversation("u1", "u2");
    const m = await messenger.sendMessage(conv.id, "u1", "hi", "c1");
    expect((await messenger.markReadUpTo(conv.id, "u2", m.seq)).marked).toBe(1);
    expect((await messenger.markReadUpTo(conv.id, "u2", m.seq)).marked).toBe(0);
  });

  it("does not count the recipient's own messages, or messages sent before they joined", async () => {
    const { messenger } = setup();
    const group = messenger.createGroupConversation("u1", ["u2"], "team");
    await messenger.sendMessage(group.id, "u1", "before", "c1");
    const mine = await messenger.sendMessage(group.id, "u2", "mine", "c2");
    const after = await messenger.addMember(group.id, "u1", "u3");
    const theirs = await messenger.sendMessage(group.id, "u1", "after u3 joined", "c3");
    const { marked } = await messenger.markReadUpTo(group.id, "u3", theirs.seq);
    expect(marked).toBe(1); // only "after u3 joined"; not "before" (pre-join) and not "mine" (u3 isn't its sender)
    void mine;
    void after;
  });

  it("a message that arrives after uptoSeq is NOT retroactively marked read by an earlier call", async () => {
    const { messenger } = setup();
    const conv = messenger.createDirectConversation("u1", "u2");
    const m1 = await messenger.sendMessage(conv.id, "u1", "one", "c1");
    await messenger.markReadUpTo(conv.id, "u2", m1.seq);
    const m2 = await messenger.sendMessage(conv.id, "u1", "two", "c2");
    expect(overallStatus(messenger.getMessage(conv.id, m2.id)!)).toBe("sent");
  });

  it("rejects a negative or non-integer uptoSeq; an unknown conversation or non-member recipient", async () => {
    const { messenger } = setup();
    const conv = messenger.createDirectConversation("u1", "u2");
    expect(await asyncErrorCode(() => messenger.markReadUpTo(conv.id, "u2", -1))).toBe("INVALID_REQUEST");
    expect(await asyncErrorCode(() => messenger.markReadUpTo(conv.id, "u2", 1.5))).toBe("INVALID_REQUEST");
    expect(await asyncErrorCode(() => messenger.markReadUpTo("ghost", "u2", 0))).toBe("UNKNOWN_CONVERSATION");
    expect(await asyncErrorCode(() => messenger.markReadUpTo(conv.id, "ghost-user", 0))).toBe("NOT_A_MEMBER");
  });
});

describe("overallStatus: the single/double/blue tick rule", () => {
  it("a group message is 'delivered' only once EVERY recipient has it, 'read' only once every recipient has read it", async () => {
    const { messenger } = setup();
    const group = messenger.createGroupConversation("u1", ["u2", "u3"], "team");
    const m = await messenger.sendMessage(group.id, "u1", "hi all", "c1");
    expect(overallStatus(m)).toBe("sent");
    await messenger.markDelivered(group.id, "u2", m.id);
    expect(overallStatus(messenger.getMessage(group.id, m.id)!)).toBe("sent"); // u3 has not received it yet
    await messenger.markDelivered(group.id, "u3", m.id);
    expect(overallStatus(messenger.getMessage(group.id, m.id)!)).toBe("delivered");
    await messenger.markReadUpTo(group.id, "u2", m.seq);
    expect(overallStatus(messenger.getMessage(group.id, m.id)!)).toBe("delivered"); // u3 has not read it yet
    await messenger.markReadUpTo(group.id, "u3", m.seq);
    expect(overallStatus(messenger.getMessage(group.id, m.id)!)).toBe("read");
  });

  it("no recipients at all (everyone else has left) is 'sent', not a false 'read'", async () => {
    const { messenger } = setup();
    const group = messenger.createGroupConversation("u1", ["u2"], "team");
    await messenger.removeMember(group.id, "u1", "u2");
    const m = await messenger.sendMessage(group.id, "u1", "talking to myself", "c1");
    expect(Object.keys(m.receipts)).toHaveLength(0);
    expect(overallStatus(m)).toBe("sent");
  });
});
