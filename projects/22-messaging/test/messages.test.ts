import { describe, expect, it } from "vitest";
import { errorCode, setup } from "./helpers.js";

describe("sendMessage: ordering and validation", () => {
  it("sequence numbers start at 1 and increase by 1 per message, independent per conversation", () => {
    const { messenger } = setup();
    const a = messenger.createDirectConversation("u1", "u2");
    const b = messenger.createDirectConversation("u1", "u3");
    const m1 = messenger.sendMessage(a.id, "u1", "one", "a1");
    const m2 = messenger.sendMessage(a.id, "u2", "two", "a2");
    const n1 = messenger.sendMessage(b.id, "u1", "one", "b1");
    expect([m1.seq, m2.seq, n1.seq]).toEqual([1, 2, 1]);
  });

  it("rejects an empty or oversized body, and an empty or oversized clientMessageId; nothing is stored", () => {
    const { messenger } = setup();
    const conv = messenger.createDirectConversation("u1", "u2");
    expect(errorCode(() => messenger.sendMessage(conv.id, "u1", "", "c1"))).toBe("INVALID_REQUEST");
    expect(errorCode(() => messenger.sendMessage(conv.id, "u1", "  ", "c1"))).toBe("INVALID_REQUEST");
    expect(errorCode(() => messenger.sendMessage(conv.id, "u1", "x".repeat(4097), "c1"))).toBe("INVALID_REQUEST");
    expect(errorCode(() => messenger.sendMessage(conv.id, "u1", "hi", ""))).toBe("INVALID_REQUEST");
    expect(errorCode(() => messenger.sendMessage(conv.id, "u1", "hi", "x".repeat(256)))).toBe("INVALID_REQUEST");
    expect(messenger.get(conv.id)!.nextSeq).toBe(1);
  });

  it("body and clientMessageId at exactly the max length succeed; one character over fails", () => {
    const { messenger } = setup();
    const conv = messenger.createDirectConversation("u1", "u2");
    expect(() => messenger.sendMessage(conv.id, "u1", "x".repeat(4096), "c1")).not.toThrow();
    expect(errorCode(() => messenger.sendMessage(conv.id, "u1", "x".repeat(4097), "c2"))).toBe("INVALID_REQUEST");
    expect(() => messenger.sendMessage(conv.id, "u1", "hi", "y".repeat(255))).not.toThrow();
    expect(errorCode(() => messenger.sendMessage(conv.id, "u1", "hi", "y".repeat(256)))).toBe("INVALID_REQUEST");
  });

  it("an unknown conversation or a non-member sender throws; nothing is stored", () => {
    const { messenger } = setup();
    expect(errorCode(() => messenger.sendMessage("ghost", "u1", "hi", "c1"))).toBe("UNKNOWN_CONVERSATION");
    const conv = messenger.createDirectConversation("u1", "u2");
    expect(errorCode(() => messenger.sendMessage(conv.id, "u3", "hi", "c1"))).toBe("NOT_A_MEMBER");
    expect(messenger.get(conv.id)!.nextSeq).toBe(1);
  });

  it("sendMessage and getMessage return copies: mutating the result does not change the stored message", () => {
    const { messenger } = setup();
    const conv = messenger.createDirectConversation("u1", "u2");
    const sent = messenger.sendMessage(conv.id, "u1", "hi", "c1");
    sent.body = "tampered";
    sent.receipts["intruder"] = { status: "read", at: 0 };
    const fetched = messenger.getMessage(conv.id, sent.id)!;
    expect(fetched.body).toBe("hi");
    expect(fetched.receipts).not.toHaveProperty("intruder");
    fetched.body = "also tampered";
    expect(messenger.getMessage(conv.id, sent.id)!.body).toBe("hi");
  });

  it("every other CURRENT member gets a 'sent' receipt; the sender gets none", () => {
    const { messenger } = setup();
    const group = messenger.createGroupConversation("u1", ["u2", "u3"], "team");
    const m = messenger.sendMessage(group.id, "u1", "hi all", "c1");
    expect(Object.keys(m.receipts).sort()).toEqual(["u2", "u3"]);
    expect(m.receipts["u2"]).toEqual({ status: "sent", at: expect.any(Number) });
  });
});

describe("sendMessage: idempotency", () => {
  it("the same clientMessageId and body again returns the SAME message, no new sequence number consumed", () => {
    const { messenger } = setup();
    const conv = messenger.createDirectConversation("u1", "u2");
    const first = messenger.sendMessage(conv.id, "u1", "hi", "c1");
    const second = messenger.sendMessage(conv.id, "u1", "hi", "c1");
    expect(second).toEqual(first);
    const next = messenger.sendMessage(conv.id, "u1", "next", "c2");
    expect(next.seq).toBe(2); // not 3: the retry never consumed a sequence number
  });

  it("the same clientMessageId with a DIFFERENT body is a conflict; the original is untouched", () => {
    const { messenger } = setup();
    const conv = messenger.createDirectConversation("u1", "u2");
    const first = messenger.sendMessage(conv.id, "u1", "hi", "c1");
    expect(errorCode(() => messenger.sendMessage(conv.id, "u1", "bye", "c1"))).toBe("IDEMPOTENCY_CONFLICT");
    expect(messenger.getMessage(conv.id, first.id)!.body).toBe("hi");
  });

  it("the key is scoped to (conversation, sender): the same clientMessageId from another sender or conversation is a different message", () => {
    const { messenger } = setup();
    const a = messenger.createDirectConversation("u1", "u2");
    const b = messenger.createDirectConversation("u1", "u3");
    const m1 = messenger.sendMessage(a.id, "u1", "hi", "c1");
    const m2 = messenger.sendMessage(a.id, "u2", "hi", "c1"); // same conv, different sender
    const m3 = messenger.sendMessage(b.id, "u1", "hi", "c1"); // same sender, different conv
    expect(new Set([m1.id, m2.id, m3.id]).size).toBe(3);
  });

  it("a replayed send succeeds even after the sender has left the group (replay reads a result, it does not re-authorize)", () => {
    const { messenger } = setup();
    const group = messenger.createGroupConversation("u1", ["u2", "u3"], "team");
    const first = messenger.sendMessage(group.id, "u2", "hi", "c1");
    messenger.removeMember(group.id, "u1", "u2");
    const replay = messenger.sendMessage(group.id, "u2", "hi", "c1");
    expect(replay).toEqual(first);
  });

  it("20 'concurrent' identical sends (synchronous calls) produce exactly one message", () => {
    const { messenger } = setup();
    const conv = messenger.createDirectConversation("u1", "u2");
    const results = Array.from({ length: 20 }, () => messenger.sendMessage(conv.id, "u1", "hi", "c1"));
    expect(new Set(results.map((m) => m.id)).size).toBe(1);
    expect(messenger.get(conv.id)!.nextSeq).toBe(2);
  });
});
