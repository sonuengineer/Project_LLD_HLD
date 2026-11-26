import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor } from "../src/index.js";
import { errorCode, setup } from "./helpers.js";

const ids = (items: { id: string }[]) => items.map((i) => i.id);

describe("getMessages: paging", () => {
  it("newest first, pages of `limit`, the last page says so; every message exactly once", () => {
    const { messenger } = setup();
    const conv = messenger.createDirectConversation("u1", "u2");
    for (let i = 1; i <= 45; i++) messenger.sendMessage(conv.id, "u1", `msg ${i}`, `c${i}`);
    const p1 = messenger.getMessages(conv.id, "u2", { limit: 20 });
    const p2 = messenger.getMessages(conv.id, "u2", { limit: 20, cursor: p1.nextCursor! });
    const p3 = messenger.getMessages(conv.id, "u2", { limit: 20, cursor: p2.nextCursor! });
    expect(p1.items.map((m) => m.body).slice(0, 2)).toEqual(["msg 45", "msg 44"]);
    expect([p1.items.length, p2.items.length, p3.items.length]).toEqual([20, 20, 5]);
    expect(p3.nextCursor).toBeNull();
    const seqs = [...p1.items, ...p2.items, ...p3.items].map((m) => m.seq);
    expect(seqs).toEqual(Array.from({ length: 45 }, (_, i) => 45 - i));
    expect(messenger.getMessages(conv.id, "u2", { limit: 45 }).nextCursor).toBeNull(); // exact fit: no empty extra page
  });

  it("new messages arriving between two page loads do not shift the next page", () => {
    const { messenger } = setup();
    const conv = messenger.createDirectConversation("u1", "u2");
    for (let i = 1; i <= 10; i++) messenger.sendMessage(conv.id, "u1", `msg ${i}`, `c${i}`);
    const p1 = messenger.getMessages(conv.id, "u2", { limit: 4 }); // 10..7
    for (let i = 11; i <= 13; i++) messenger.sendMessage(conv.id, "u1", `new ${i}`, `c${i}`);
    const p2 = messenger.getMessages(conv.id, "u2", { limit: 4, cursor: p1.nextCursor! });
    expect(p2.items.map((m) => m.body)).toEqual(["msg 6", "msg 5", "msg 4", "msg 3"]);
    expect(messenger.getMessages(conv.id, "u2", { limit: 3 }).items.map((m) => m.body)).toEqual(["new 13", "new 12", "new 11"]);
  });

  it("a member sees nothing from before they joined the group; a direct conversation's founders see everything", () => {
    const { messenger } = setup();
    const group = messenger.createGroupConversation("u1", ["u2"], "team");
    messenger.sendMessage(group.id, "u1", "before", "c1");
    const after = messenger.addMember(group.id, "u1", "u3");
    messenger.sendMessage(group.id, "u1", "after", "c2");
    expect(messenger.getMessages(group.id, "u3").items.map((m) => m.body)).toEqual(["after"]);
    expect(messenger.getMessages(group.id, "u2").items.map((m) => m.body)).toEqual(["after", "before"]);
    void after;
  });

  it("the join-time cut also applies when paging: the oldest visible page says nextCursor null even if older, invisible messages exist", () => {
    const { messenger } = setup();
    const group = messenger.createGroupConversation("u1", ["u2"], "team");
    for (let i = 1; i <= 5; i++) messenger.sendMessage(group.id, "u1", `old ${i}`, `c${i}`);
    messenger.addMember(group.id, "u1", "u3");
    for (let i = 1; i <= 3; i++) messenger.sendMessage(group.id, "u1", `new ${i}`, `n${i}`);
    const page = messenger.getMessages(group.id, "u3", { limit: 2 });
    expect(page.items.map((m) => m.body)).toEqual(["new 3", "new 2"]);
    const page2 = messenger.getMessages(group.id, "u3", { limit: 2, cursor: page.nextCursor! });
    expect(page2.items.map((m) => m.body)).toEqual(["new 1"]);
    expect(page2.nextCursor).toBeNull(); // "old 1".."old 5" exist but are invisible to u3
  });

  it("limit must be 1..200; an unknown conversation or non-member throws; empty conversation returns an empty page", () => {
    const { messenger } = setup();
    const conv = messenger.createDirectConversation("u1", "u2");
    expect(() => messenger.getMessages(conv.id, "u1", { limit: 1 })).not.toThrow();
    expect(() => messenger.getMessages(conv.id, "u1", { limit: 200 })).not.toThrow();
    for (const limit of [0, 201, 1.5, Number.NaN]) {
      expect(errorCode(() => messenger.getMessages(conv.id, "u1", { limit }))).toBe("INVALID_REQUEST");
    }
    expect(errorCode(() => messenger.getMessages("ghost", "u1"))).toBe("UNKNOWN_CONVERSATION");
    expect(errorCode(() => messenger.getMessages(conv.id, "ghost-user"))).toBe("NOT_A_MEMBER");
    expect(messenger.getMessages(conv.id, "u1")).toEqual({ items: [], nextCursor: null });
  });

  it("cursors are opaque and checked: anything this API did not return is INVALID_CURSOR", () => {
    const { messenger } = setup();
    const conv = messenger.createDirectConversation("u1", "u2");
    messenger.sendMessage(conv.id, "u1", "hi", "c1");
    for (const bad of ["garbage", "", Buffer.from("v1.x").toString("base64url"), Buffer.from("v1.05").toString("base64url"), `${encodeCursor(1)}=`]) {
      expect(errorCode(() => messenger.getMessages(conv.id, "u1", { cursor: bad }))).toBe("INVALID_CURSOR");
    }
    expect(decodeCursor(encodeCursor(7))).toBe(7);
  });
});
