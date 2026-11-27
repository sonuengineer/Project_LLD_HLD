// Sender-only message edit and delete-for-everyone. Receipts are untouched by either -- see PLAN.md.
import { describe, expect, it } from "vitest";
import { asyncErrorCode, setup } from "./helpers.js";

describe("editMessage", () => {
  it("the sender can change the body; edited and editedAt are set", async () => {
    const { messenger, clock } = setup();
    const conv = messenger.createDirectConversation("u1", "u2");
    const m = await messenger.sendMessage(conv.id, "u1", "see you at 4pm", "c1");
    clock.advance(1000);
    const edited = await messenger.editMessage(conv.id, "u1", m.id, "see you at 5pm");
    expect(edited.body).toBe("see you at 5pm");
    expect(edited.edited).toBe(true);
    expect(edited.editedAt).toBe(messenger.getMessage(conv.id, m.id)!.editedAt);
    expect(edited.editedAt).not.toBeNull();
    expect(messenger.getMessage(conv.id, m.id)!.body).toBe("see you at 5pm");
  });

  it("rejects an empty or oversized new body; the original is untouched", async () => {
    const { messenger } = setup();
    const conv = messenger.createDirectConversation("u1", "u2");
    const m = await messenger.sendMessage(conv.id, "u1", "hi", "c1");
    expect(await asyncErrorCode(() => messenger.editMessage(conv.id, "u1", m.id, ""))).toBe("INVALID_REQUEST");
    expect(await asyncErrorCode(() => messenger.editMessage(conv.id, "u1", m.id, "x".repeat(4097)))).toBe("INVALID_REQUEST");
    expect(messenger.getMessage(conv.id, m.id)!.body).toBe("hi");
  });

  it("only the original sender may edit; not the recipient, not anyone else", async () => {
    const { messenger } = setup();
    const conv = messenger.createDirectConversation("u1", "u2");
    const m = await messenger.sendMessage(conv.id, "u1", "hi", "c1");
    expect(await asyncErrorCode(() => messenger.editMessage(conv.id, "u2", m.id, "edited by u2"))).toBe("SENDER_REQUIRED");
    expect(messenger.getMessage(conv.id, m.id)!.body).toBe("hi");
  });

  it("an unknown conversation or message throws", async () => {
    const { messenger } = setup();
    const conv = messenger.createDirectConversation("u1", "u2");
    expect(await asyncErrorCode(() => messenger.editMessage("ghost", "u1", "ghost-msg", "x"))).toBe("UNKNOWN_CONVERSATION");
    expect(await asyncErrorCode(() => messenger.editMessage(conv.id, "u1", "ghost-msg", "x"))).toBe("UNKNOWN_MESSAGE");
  });

  it("a deleted message cannot be edited", async () => {
    const { messenger } = setup();
    const conv = messenger.createDirectConversation("u1", "u2");
    const m = await messenger.sendMessage(conv.id, "u1", "hi", "c1");
    await messenger.deleteMessage(conv.id, "u1", m.id);
    expect(await asyncErrorCode(() => messenger.editMessage(conv.id, "u1", m.id, "resurrected"))).toBe("MESSAGE_DELETED");
  });

  it("editing does not touch receipts", async () => {
    const { messenger } = setup();
    const conv = messenger.createDirectConversation("u1", "u2");
    const m = await messenger.sendMessage(conv.id, "u1", "hi", "c1");
    await messenger.markDelivered(conv.id, "u2", m.id);
    const edited = await messenger.editMessage(conv.id, "u1", m.id, "hi!");
    expect(edited.receipts["u2"]).toMatchObject({ status: "delivered" });
  });

  it("editMessage returns a copy: mutating the result does not change the stored message", async () => {
    const { messenger } = setup();
    const conv = messenger.createDirectConversation("u1", "u2");
    const m = await messenger.sendMessage(conv.id, "u1", "hi", "c1");
    const edited = await messenger.editMessage(conv.id, "u1", m.id, "hi!");
    edited.body = "tampered";
    expect(messenger.getMessage(conv.id, m.id)!.body).toBe("hi!");
  });
});

describe("deleteMessage", () => {
  it("clears the body and sets deletedAt; the old content is not retrievable", async () => {
    const { messenger } = setup();
    const conv = messenger.createDirectConversation("u1", "u2");
    const m = await messenger.sendMessage(conv.id, "u1", "wrong chat, ignore this", "c1");
    const deleted = await messenger.deleteMessage(conv.id, "u1", m.id);
    expect(deleted.body).toBe("");
    expect(deleted.deletedAt).not.toBeNull();
    expect(messenger.getMessage(conv.id, m.id)!.body).toBe("");
  });

  it("is idempotent: deleting an already-deleted message succeeds and keeps the original deletedAt", async () => {
    const { messenger, clock } = setup();
    const conv = messenger.createDirectConversation("u1", "u2");
    const m = await messenger.sendMessage(conv.id, "u1", "hi", "c1");
    const first = await messenger.deleteMessage(conv.id, "u1", m.id);
    clock.advance(5000);
    const second = await messenger.deleteMessage(conv.id, "u1", m.id);
    expect(second.deletedAt).toBe(first.deletedAt); // not re-stamped
  });

  it("only the original sender may delete", async () => {
    const { messenger } = setup();
    const conv = messenger.createDirectConversation("u1", "u2");
    const m = await messenger.sendMessage(conv.id, "u1", "hi", "c1");
    expect(await asyncErrorCode(() => messenger.deleteMessage(conv.id, "u2", m.id))).toBe("SENDER_REQUIRED");
    expect(messenger.getMessage(conv.id, m.id)!.body).toBe("hi");
  });

  it("an unknown conversation or message throws", async () => {
    const { messenger } = setup();
    const conv = messenger.createDirectConversation("u1", "u2");
    expect(await asyncErrorCode(() => messenger.deleteMessage("ghost", "u1", "ghost-msg"))).toBe("UNKNOWN_CONVERSATION");
    expect(await asyncErrorCode(() => messenger.deleteMessage(conv.id, "u1", "ghost-msg"))).toBe("UNKNOWN_MESSAGE");
  });

  it("deleting does not touch receipts: the deleted message's status is still computed normally", async () => {
    const { messenger } = setup();
    const conv = messenger.createDirectConversation("u1", "u2");
    const m = await messenger.sendMessage(conv.id, "u1", "hi", "c1");
    await messenger.markDelivered(conv.id, "u2", m.id);
    const deleted = await messenger.deleteMessage(conv.id, "u1", m.id);
    expect(deleted.receipts["u2"]).toMatchObject({ status: "delivered" });
  });

  it("a messageId from a DIFFERENT conversation is not found here either", async () => {
    const { messenger } = setup();
    const a = messenger.createDirectConversation("u1", "u2");
    const b = messenger.createDirectConversation("u1", "u3");
    const m = await messenger.sendMessage(a.id, "u1", "hi", "c1");
    expect(await asyncErrorCode(() => messenger.deleteMessage(b.id, "u1", m.id))).toBe("UNKNOWN_MESSAGE");
  });
});
