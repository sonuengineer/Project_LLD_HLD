import { describe, expect, it } from "vitest";
import { asyncErrorCode, errorCode, setup } from "./helpers.js";

describe("direct conversations", () => {
  it("creating one for the same pair again returns the SAME conversation, in either order", () => {
    const { messenger } = setup();
    const a = messenger.createDirectConversation("u1", "u2");
    const b = messenger.createDirectConversation("u2", "u1");
    expect(b.id).toBe(a.id);
    expect(a.members.map((m) => m.userId).sort()).toEqual(["u1", "u2"]);
    expect(a.members.every((m) => m.role === "member")).toBe(true);
  });

  it("rejects the same user twice, and an unknown user", () => {
    const { messenger } = setup();
    expect(errorCode(() => messenger.createDirectConversation("u1", "u1"))).toBe("INVALID_REQUEST");
    expect(errorCode(() => messenger.createDirectConversation("u1", "ghost"))).toBe("UNKNOWN_USER");
  });

  it("direct conversations cannot have members added or removed", async () => {
    const { messenger } = setup();
    const conv = messenger.createDirectConversation("u1", "u2");
    expect(await asyncErrorCode(() => messenger.addMember(conv.id, "u1", "u3"))).toBe("INVALID_REQUEST");
    expect(await asyncErrorCode(() => messenger.removeMember(conv.id, "u1", "u2"))).toBe("INVALID_REQUEST");
  });
});

describe("group conversations", () => {
  it("the creator is the owner; members are 'member'", () => {
    const { messenger } = setup();
    const group = messenger.createGroupConversation("u1", ["u2", "u3"], "team");
    expect(group.members).toEqual([
      { userId: "u1", role: "owner", joinedAtSeq: 0 },
      { userId: "u2", role: "member", joinedAtSeq: 0 },
      { userId: "u3", role: "member", joinedAtSeq: 0 },
    ]);
  });

  it("rejects an empty member list, a blank name, the owner repeated, and duplicate members", () => {
    const { messenger } = setup();
    expect(errorCode(() => messenger.createGroupConversation("u1", [], "x"))).toBe("INVALID_REQUEST");
    expect(errorCode(() => messenger.createGroupConversation("u1", ["u2"], ""))).toBe("INVALID_REQUEST");
    expect(errorCode(() => messenger.createGroupConversation("u1", ["u1", "u2"], "x"))).toBe("INVALID_REQUEST");
    expect(errorCode(() => messenger.createGroupConversation("u1", ["u2", "u2"], "x"))).toBe("INVALID_REQUEST");
    expect(errorCode(() => messenger.createGroupConversation("u1", ["ghost"], "x"))).toBe("UNKNOWN_USER");
  });

  it("a name at exactly the max length succeeds; one character over fails", () => {
    const { messenger } = setup();
    expect(() => messenger.createGroupConversation("u1", ["u2"], "x".repeat(200))).not.toThrow();
    expect(errorCode(() => messenger.createGroupConversation("u1", ["u2"], "x".repeat(201)))).toBe("INVALID_REQUEST");
  });

  it("only the owner adds members; a non-member or non-owner cannot; a current member is rejected", async () => {
    const { messenger } = setup();
    const group = messenger.createGroupConversation("u1", ["u2"], "team");
    expect(await asyncErrorCode(() => messenger.addMember(group.id, "u2", "u3"))).toBe("OWNER_REQUIRED");
    expect(await asyncErrorCode(() => messenger.addMember(group.id, "ghost-member", "u3"))).toBe("NOT_A_MEMBER");
    expect(await asyncErrorCode(() => messenger.addMember(group.id, "u1", "u2"))).toBe("ALREADY_MEMBER");
    const after = await messenger.addMember(group.id, "u1", "u3");
    expect(after.members.map((m) => m.userId)).toEqual(["u1", "u2", "u3"]);
  });

  it("a new member's joinedAtSeq is the message count at the moment they join", async () => {
    const { messenger } = setup();
    const group = messenger.createGroupConversation("u1", ["u2"], "team");
    await messenger.sendMessage(group.id, "u1", "one", "c1");
    await messenger.sendMessage(group.id, "u1", "two", "c2");
    const after = await messenger.addMember(group.id, "u1", "u3");
    expect(after.members.find((m) => m.userId === "u3")!.joinedAtSeq).toBe(2);
  });

  it("only the owner removes members; the owner cannot be removed; a non-member is rejected", async () => {
    const { messenger } = setup();
    const group = messenger.createGroupConversation("u1", ["u2", "u3"], "team");
    expect(await asyncErrorCode(() => messenger.removeMember(group.id, "u2", "u3"))).toBe("OWNER_REQUIRED");
    expect(await asyncErrorCode(() => messenger.removeMember(group.id, "u1", "u1"))).toBe("CANNOT_REMOVE_OWNER");
    expect(await asyncErrorCode(() => messenger.removeMember(group.id, "u1", "ghost"))).toBe("NOT_A_MEMBER");
    const after = await messenger.removeMember(group.id, "u1", "u2");
    expect(after.members.map((m) => m.userId)).toEqual(["u1", "u3"]);
  });

  it("unknown conversation id -> UNKNOWN_CONVERSATION; get() of a missing one is undefined", async () => {
    const { messenger } = setup();
    expect(await asyncErrorCode(() => messenger.addMember("ghost-conv", "u1", "u2"))).toBe("UNKNOWN_CONVERSATION");
    expect(messenger.get("ghost-conv")).toBeUndefined();
  });

  it("get() returns a copy: mutating it does not change the stored conversation", () => {
    const { messenger } = setup();
    const group = messenger.createGroupConversation("u1", ["u2"], "team");
    const copy = messenger.get(group.id)!;
    copy.members.push({ userId: "intruder", role: "member", joinedAtSeq: 0 });
    expect(messenger.get(group.id)!.members).toHaveLength(2);
  });
});
