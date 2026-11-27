// Presence (who is online, on how many devices) and the two features it drives: a recipient already online
// gets auto-delivered at send time, and an offline recipient catches up on reconnect. See store.ts for why
// presence itself is never written through the ConversationStore.
import { describe, expect, it } from "vitest";
import { overallStatus } from "../src/index.js";
import { asyncErrorCode, errorCode, setup } from "./helpers.js";

describe("connectDevice / disconnectDevice / isOnline", () => {
  it("a user is offline until their first device connects", async () => {
    const { messenger } = setup();
    expect(messenger.isOnline("u1")).toBe(false);
    await messenger.connectDevice("u1", "phone");
    expect(messenger.isOnline("u1")).toBe(true);
  });

  it("several devices at once: still online until the LAST one disconnects", async () => {
    const { messenger } = setup();
    await messenger.connectDevice("u1", "phone");
    await messenger.connectDevice("u1", "laptop");
    expect(messenger.isOnline("u1")).toBe(true);
    messenger.disconnectDevice("u1", "phone");
    expect(messenger.isOnline("u1")).toBe(true); // laptop is still connected
    messenger.disconnectDevice("u1", "laptop");
    expect(messenger.isOnline("u1")).toBe(false);
  });

  it("connecting the same deviceId twice is harmless (a Set, not a counter)", async () => {
    const { messenger } = setup();
    await messenger.connectDevice("u1", "phone");
    await messenger.connectDevice("u1", "phone");
    messenger.disconnectDevice("u1", "phone");
    expect(messenger.isOnline("u1")).toBe(false); // one disconnect is enough, it was never double-counted
  });

  it("connectDevice rejects an unknown user; disconnectDevice rejects a device that is not connected", async () => {
    const { messenger } = setup();
    expect(await asyncErrorCode(() => messenger.connectDevice("ghost", "phone"))).toBe("UNKNOWN_USER");
    expect(errorCode(() => messenger.disconnectDevice("u1", "phone"))).toBe("UNKNOWN_DEVICE"); // never connected
    await messenger.connectDevice("u1", "phone");
    messenger.disconnectDevice("u1", "phone");
    expect(errorCode(() => messenger.disconnectDevice("u1", "phone"))).toBe("UNKNOWN_DEVICE"); // already gone
  });

  it("connectDevice without a deviceId generates one and returns it", async () => {
    const { messenger } = setup();
    const id = await messenger.connectDevice("u1");
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
    messenger.disconnectDevice("u1", id); // the returned id is the real one, usable to disconnect
    expect(messenger.isOnline("u1")).toBe(false);
  });
});

describe("auto-delivery to an already-online recipient", () => {
  it("a message sent to a recipient who is already online is 'delivered', not 'sent'", async () => {
    const { messenger } = setup();
    const conv = messenger.createDirectConversation("u1", "u2");
    await messenger.connectDevice("u2", "phone");
    const m = await messenger.sendMessage(conv.id, "u1", "hi", "c1");
    expect(m.receipts["u2"]).toMatchObject({ status: "delivered" });
  });

  it("a message sent to an offline recipient stays 'sent'", async () => {
    const { messenger } = setup();
    const conv = messenger.createDirectConversation("u1", "u2");
    const m = await messenger.sendMessage(conv.id, "u1", "hi", "c1");
    expect(m.receipts["u2"]).toMatchObject({ status: "sent" });
  });

  it("in a group, each recipient's receipt reflects THEIR OWN presence independently", async () => {
    const { messenger } = setup();
    const group = messenger.createGroupConversation("u1", ["u2", "u3"], "team");
    await messenger.connectDevice("u3", "phone"); // only u3 is online
    const m = await messenger.sendMessage(group.id, "u1", "hi all", "c1");
    expect(m.receipts["u2"]).toMatchObject({ status: "sent" });
    expect(m.receipts["u3"]).toMatchObject({ status: "delivered" });
  });
});

describe("offline catch-up on reconnect", () => {
  it("every pending 'sent' receipt for that user is bumped to 'delivered' the moment they reconnect", async () => {
    const { messenger } = setup();
    const conv = messenger.createDirectConversation("u1", "u2");
    const m1 = await messenger.sendMessage(conv.id, "u1", "one", "c1");
    const m2 = await messenger.sendMessage(conv.id, "u1", "two", "c2");
    expect(overallStatus(messenger.getMessage(conv.id, m1.id)!)).toBe("sent");
    expect(overallStatus(messenger.getMessage(conv.id, m2.id)!)).toBe("sent");

    await messenger.connectDevice("u2", "phone");

    expect(overallStatus(messenger.getMessage(conv.id, m1.id)!)).toBe("delivered");
    expect(overallStatus(messenger.getMessage(conv.id, m2.id)!)).toBe("delivered");
  });

  it("catch-up spans every conversation the reconnecting user belongs to, not just one", async () => {
    const { messenger } = setup();
    const a = messenger.createDirectConversation("u1", "u3");
    const b = messenger.createGroupConversation("u2", ["u3"], "team");
    const ma = await messenger.sendMessage(a.id, "u1", "from a", "c1");
    const mb = await messenger.sendMessage(b.id, "u2", "from b", "c2");

    await messenger.connectDevice("u3", "phone");

    expect(overallStatus(messenger.getMessage(a.id, ma.id)!)).toBe("delivered");
    expect(overallStatus(messenger.getMessage(b.id, mb.id)!)).toBe("delivered");
  });

  it("already-delivered or already-read receipts are untouched by catch-up, never downgraded or re-stamped", async () => {
    const { messenger } = setup();
    const conv = messenger.createDirectConversation("u1", "u2");
    const m1 = await messenger.sendMessage(conv.id, "u1", "one", "c1");
    await messenger.markDelivered(conv.id, "u2", m1.id);
    await messenger.markReadUpTo(conv.id, "u2", m1.seq);
    const before = messenger.getMessage(conv.id, m1.id)!.receipts["u2"];

    await messenger.connectDevice("u2", "phone"); // u2 was never online before; this is their first connect

    expect(messenger.getMessage(conv.id, m1.id)!.receipts["u2"]).toEqual(before); // same status AND same timestamp
  });

  it("catch-up only fires on the offline -> online transition: a second device connecting does nothing extra", async () => {
    const { messenger } = setup();
    const conv = messenger.createDirectConversation("u1", "u2");
    await messenger.connectDevice("u2", "phone"); // u2 online from the start
    const m = await messenger.sendMessage(conv.id, "u1", "hi", "c1"); // auto-delivered at send time
    await messenger.connectDevice("u2", "laptop"); // a SECOND device; u2 was already online
    expect(overallStatus(messenger.getMessage(conv.id, m.id)!)).toBe("delivered"); // unchanged, not re-applied
  });

  it("a member added via addMember is also registered for future catch-up", async () => {
    const { messenger } = setup();
    const group = messenger.createGroupConversation("u1", ["u2"], "team");
    await messenger.addMember(group.id, "u1", "u3");
    const m = await messenger.sendMessage(group.id, "u1", "welcome", "c1"); // u3 is offline, receipt stays "sent"
    await messenger.connectDevice("u3", "phone");
    // u2 (also in the group) never connects, so overallStatus stays "sent" -- check u3's OWN receipt directly.
    expect(messenger.getMessage(group.id, m.id)!.receipts["u3"]).toMatchObject({ status: "delivered" });
  });

  it("a removed member's old pending receipt is untouched by catch-up once they're gone (removeMember cleans up conversationsByUser)", async () => {
    const { messenger } = setup();
    const group = messenger.createGroupConversation("u1", ["u2"], "team");
    const m = await messenger.sendMessage(group.id, "u1", "while u2 was still here", "c1"); // u2 offline
    await messenger.removeMember(group.id, "u1", "u2");
    await messenger.connectDevice("u2", "phone"); // u2 comes online, but is no longer a member of `group`
    expect(overallStatus(messenger.getMessage(group.id, m.id)!)).toBe("sent"); // untouched: group is no longer theirs to catch up
  });

  it("disconnecting and reconnecting catches up messages sent while offline again", async () => {
    const { messenger } = setup();
    const conv = messenger.createDirectConversation("u1", "u2");
    await messenger.connectDevice("u2", "phone");
    messenger.disconnectDevice("u2", "phone"); // back offline
    const m = await messenger.sendMessage(conv.id, "u1", "while you were out", "c1");
    expect(overallStatus(messenger.getMessage(conv.id, m.id)!)).toBe("sent");
    await messenger.connectDevice("u2", "phone"); // reconnect
    expect(overallStatus(messenger.getMessage(conv.id, m.id)!)).toBe("delivered");
  });
});

describe("multi-device read sync", () => {
  it("read receipts are keyed by user, not device: reading 'on one device' is already visible to all of them", async () => {
    const { messenger } = setup();
    const conv = messenger.createDirectConversation("u1", "u2");
    const m = await messenger.sendMessage(conv.id, "u1", "hi", "c1");
    await messenger.connectDevice("u2", "phone");
    await messenger.connectDevice("u2", "laptop");

    // There is no per-device read call to make: markReadUpTo takes a userId, not a deviceId, because there is
    // exactly one receipt for u2 regardless of how many devices they have connected.
    await messenger.markReadUpTo(conv.id, "u2", m.seq);

    expect(overallStatus(messenger.getMessage(conv.id, m.id)!)).toBe("read"); // true from "either device"'s view
  });
});
