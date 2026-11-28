// The HTTP API against a real Express server on a random port, called with Node's fetch -- same pattern as
// 23-password-manager's and 21-notification's http.test.ts.
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, type AppOptions } from "../src/http/app.js";
import { Messenger } from "../src/messenger.js";
import { InMemoryUsers } from "../src/users.js";
import { FakeConversationStore, flush } from "./helpers.js";

const KEY = "test-api-key-0123456789abcdef";
const servers: Server[] = [];

async function listen(app: express.Express): Promise<string> {
  const s = await new Promise<Server>((resolve) => {
    const srv = app.listen(0, "127.0.0.1", () => resolve(srv));
  });
  servers.push(s);
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
});

function defaultMessenger(userIds: string[] = ["u1", "u2", "u3", "u4"]) {
  const users = new InMemoryUsers();
  for (const userId of userIds) users.upsert({ userId, displayName: `User ${userId}` });
  return new Messenger({ users });
}

function start(overrides: Partial<AppOptions> = {}) {
  const messenger = overrides.messenger ?? defaultMessenger();
  const logged: unknown[] = [];
  return listen(createApp({ messenger, apiKey: KEY, log: (_m, e) => logged.push(e), ...overrides })).then((base) => ({
    base,
    messenger,
    logged,
  }));
}

function authed(extra: HeadersInit = {}): HeadersInit {
  return { authorization: `Bearer ${KEY}`, "content-type": "application/json", ...extra };
}

type ErrorBody = { error: { code: string; message: string } };

describe("auth", () => {
  it("rejects a request with no API key, or the wrong one, before the body is even looked at", async () => {
    const { base } = await start();
    const noKey = await fetch(`${base}/conversations/direct`, { method: "POST", headers: { "content-type": "application/json" }, body: "not even valid json" });
    expect(noKey.status).toBe(401);
    expect((await noKey.json()) as ErrorBody).toMatchObject({ error: { code: "UNAUTHORIZED" } });

    const wrongKey = await fetch(`${base}/conversations/direct`, { method: "POST", headers: authed({ authorization: "Bearer wrong-key-entirely" }) });
    expect(wrongKey.status).toBe(401);
  });

  it("createApp refuses to start with too short an API key", () => {
    expect(() => createApp({ messenger: defaultMessenger(), apiKey: "short" })).toThrow(RangeError);
  });
});

describe("conversations", () => {
  it("POST /conversations/direct creates a conversation; calling it again for the same pair returns the SAME one", async () => {
    const { base } = await start();
    const created = await fetch(`${base}/conversations/direct`, { method: "POST", headers: authed(), body: JSON.stringify({ userIdA: "u1", userIdB: "u2" }) });
    expect(created.status).toBe(200);
    const conv = (await created.json()) as { id: string; kind: string; members: { userId: string }[] };
    expect(conv.kind).toBe("direct");
    expect(conv.members.map((m) => m.userId).sort()).toEqual(["u1", "u2"]);

    const again = await fetch(`${base}/conversations/direct`, { method: "POST", headers: authed(), body: JSON.stringify({ userIdA: "u2", userIdB: "u1" }) });
    expect((await again.json())).toMatchObject({ id: conv.id });
  });

  it("an unknown user on either side of a direct conversation is a 404 UNKNOWN_USER", async () => {
    const { base } = await start();
    const res = await fetch(`${base}/conversations/direct`, { method: "POST", headers: authed(), body: JSON.stringify({ userIdA: "u1", userIdB: "ghost" }) });
    expect(res.status).toBe(404);
    expect((await res.json()) as ErrorBody).toMatchObject({ error: { code: "UNKNOWN_USER" } });
  });

  it("POST /conversations/group creates a group with Location header; GET /conversations/:id reads it back", async () => {
    const { base } = await start();
    const created = await fetch(`${base}/conversations/group`, { method: "POST", headers: authed(), body: JSON.stringify({ ownerId: "u1", memberIds: ["u2", "u3"], name: "team" }) });
    expect(created.status).toBe(201);
    const conv = (await created.json()) as { id: string; name: string; members: { userId: string; role: string }[] };
    expect(created.headers.get("location")).toBe(`/conversations/${conv.id}`);
    expect(conv.name).toBe("team");
    expect(conv.members.find((m) => m.userId === "u1")!.role).toBe("owner");

    const read = await fetch(`${base}/conversations/${conv.id}`, { headers: authed() });
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ id: conv.id, name: "team" });
  });

  it("an empty group name is a 400 INVALID_REQUEST from the library's own validation", async () => {
    const { base } = await start();
    const res = await fetch(`${base}/conversations/group`, { method: "POST", headers: authed(), body: JSON.stringify({ ownerId: "u1", memberIds: ["u2"], name: "" }) });
    expect(res.status).toBe(400);
    expect((await res.json()) as ErrorBody).toMatchObject({ error: { code: "INVALID_REQUEST" } });
  });

  it("an unknown conversation id is a 404 NOT_FOUND", async () => {
    const { base } = await start();
    const res = await fetch(`${base}/conversations/ghost`, { headers: authed() });
    expect(res.status).toBe(404);
    expect((await res.json()) as ErrorBody).toMatchObject({ error: { code: "NOT_FOUND" } });
  });

  it("members: add is a 200 with the updated member list; a non-owner caller is 403 OWNER_REQUIRED; a repeat add is 409 ALREADY_MEMBER", async () => {
    const { base } = await start();
    const created = await fetch(`${base}/conversations/group`, { method: "POST", headers: authed(), body: JSON.stringify({ ownerId: "u1", memberIds: ["u2"], name: "team" }) });
    const conv = (await created.json()) as { id: string };

    const add = await fetch(`${base}/conversations/${conv.id}/members`, { method: "POST", headers: authed(), body: JSON.stringify({ actingUserId: "u1", newUserId: "u3" }) });
    expect(add.status).toBe(200);
    expect((await add.json() as { members: { userId: string }[] }).members.map((m) => m.userId).sort()).toEqual(["u1", "u2", "u3"]);

    const notOwner = await fetch(`${base}/conversations/${conv.id}/members`, { method: "POST", headers: authed(), body: JSON.stringify({ actingUserId: "u2", newUserId: "u4" }) });
    expect(notOwner.status).toBe(403);
    expect((await notOwner.json()) as ErrorBody).toMatchObject({ error: { code: "OWNER_REQUIRED" } });

    const dup = await fetch(`${base}/conversations/${conv.id}/members`, { method: "POST", headers: authed(), body: JSON.stringify({ actingUserId: "u1", newUserId: "u2" }) });
    expect(dup.status).toBe(409);
    expect((await dup.json()) as ErrorBody).toMatchObject({ error: { code: "ALREADY_MEMBER" } });
  });

  it("members: remove is a 200; removing the owner is 409 CANNOT_REMOVE_OWNER; removing a non-member is 403 NOT_A_MEMBER", async () => {
    const { base } = await start();
    const created = await fetch(`${base}/conversations/group`, { method: "POST", headers: authed(), body: JSON.stringify({ ownerId: "u1", memberIds: ["u2"], name: "team" }) });
    const conv = (await created.json()) as { id: string };

    const removeOwner = await fetch(`${base}/conversations/${conv.id}/members/u1`, { method: "DELETE", headers: authed(), body: JSON.stringify({ actingUserId: "u1" }) });
    expect(removeOwner.status).toBe(409);
    expect((await removeOwner.json()) as ErrorBody).toMatchObject({ error: { code: "CANNOT_REMOVE_OWNER" } });

    const removeGhost = await fetch(`${base}/conversations/${conv.id}/members/ghost`, { method: "DELETE", headers: authed(), body: JSON.stringify({ actingUserId: "u1" }) });
    expect(removeGhost.status).toBe(403);
    expect((await removeGhost.json()) as ErrorBody).toMatchObject({ error: { code: "NOT_A_MEMBER" } });

    const remove = await fetch(`${base}/conversations/${conv.id}/members/u2`, { method: "DELETE", headers: authed(), body: JSON.stringify({ actingUserId: "u1" }) });
    expect(remove.status).toBe(200);
    expect((await remove.json() as { members: { userId: string }[] }).members.map((m) => m.userId)).toEqual(["u1"]);
  });
});

describe("messages", () => {
  async function createDirect(base: string): Promise<string> {
    const res = await fetch(`${base}/conversations/direct`, { method: "POST", headers: authed(), body: JSON.stringify({ userIdA: "u1", userIdB: "u2" }) });
    return ((await res.json()) as { id: string }).id;
  }

  it("send is a 201 with a Location header and a computed status; GET reads it back", async () => {
    const { base } = await start();
    const convId = await createDirect(base);
    const sent = await fetch(`${base}/conversations/${convId}/messages`, { method: "POST", headers: authed(), body: JSON.stringify({ senderId: "u1", body: "hi", clientMessageId: "c1" }) });
    expect(sent.status).toBe(201);
    const message = (await sent.json()) as { id: string; seq: number; status: string };
    expect(sent.headers.get("location")).toBe(`/conversations/${convId}/messages/${message.id}`);
    expect(message.seq).toBe(1);
    expect(message.status).toBe("sent"); // u2 is offline

    const got = await fetch(`${base}/conversations/${convId}/messages/${message.id}`, { headers: authed() });
    expect(got.status).toBe(200);
    expect(await got.json()).toMatchObject({ id: message.id, body: "hi" });
  });

  it("an idempotent replay (same clientMessageId, same body) returns the same message; a different body is 409 IDEMPOTENCY_CONFLICT", async () => {
    const { base } = await start();
    const convId = await createDirect(base);
    const first = await fetch(`${base}/conversations/${convId}/messages`, { method: "POST", headers: authed(), body: JSON.stringify({ senderId: "u1", body: "hi", clientMessageId: "c1" }) });
    const firstBody = (await first.json()) as { id: string };

    const replay = await fetch(`${base}/conversations/${convId}/messages`, { method: "POST", headers: authed(), body: JSON.stringify({ senderId: "u1", body: "hi", clientMessageId: "c1" }) });
    expect(replay.status).toBe(201);
    expect((await replay.json()) as { id: string }).toMatchObject({ id: firstBody.id });

    const conflict = await fetch(`${base}/conversations/${convId}/messages`, { method: "POST", headers: authed(), body: JSON.stringify({ senderId: "u1", body: "bye", clientMessageId: "c1" }) });
    expect(conflict.status).toBe(409);
    expect((await conflict.json()) as ErrorBody).toMatchObject({ error: { code: "IDEMPOTENCY_CONFLICT" } });
  });

  it("two concurrent sends with the same clientMessageId: the second is 409 SEND_IN_FLIGHT while the first is still committing", async () => {
    const users = new InMemoryUsers();
    for (const userId of ["u1", "u2"]) users.upsert({ userId, displayName: `User ${userId}` });
    // A store that never resolves on its own (see test/concurrency.test.ts): the first send's commit stays
    // pending long enough to deterministically prove the SECOND concurrent send sees the synchronous claim --
    // over a real socket, two plain fetch() calls settle too far apart in time to race reliably.
    const store = new FakeConversationStore();
    const messenger = new Messenger({ users, store });
    const { base } = await start({ messenger });
    const conv = messenger.createDirectConversation("u1", "u2");

    const firstPromise = fetch(`${base}/conversations/${conv.id}/messages`, { method: "POST", headers: authed(), body: JSON.stringify({ senderId: "u1", body: "hi", clientMessageId: "c-race" }) });
    while (store.pending.length === 0) await flush();
    const second = await fetch(`${base}/conversations/${conv.id}/messages`, { method: "POST", headers: authed(), body: JSON.stringify({ senderId: "u1", body: "hi", clientMessageId: "c-race" }) });
    expect(second.status).toBe(409);
    expect((await second.json()) as ErrorBody).toMatchObject({ error: { code: "SEND_IN_FLIGHT" } });

    store.resolveNext();
    const first = await firstPromise;
    expect(first.status).toBe(201);
  });

  it("a non-member sender is 403 NOT_A_MEMBER; an unknown conversation is 404 UNKNOWN_CONVERSATION", async () => {
    const { base } = await start();
    const convId = await createDirect(base);
    const nonMember = await fetch(`${base}/conversations/${convId}/messages`, { method: "POST", headers: authed(), body: JSON.stringify({ senderId: "u3", body: "hi", clientMessageId: "c1" }) });
    expect(nonMember.status).toBe(403);
    expect((await nonMember.json()) as ErrorBody).toMatchObject({ error: { code: "NOT_A_MEMBER" } });

    const unknownConv = await fetch(`${base}/conversations/ghost/messages`, { method: "POST", headers: authed(), body: JSON.stringify({ senderId: "u1", body: "hi", clientMessageId: "c1" }) });
    expect(unknownConv.status).toBe(404);
    expect((await unknownConv.json()) as ErrorBody).toMatchObject({ error: { code: "UNKNOWN_CONVERSATION" } });
  });

  it("an unknown messageId is a 404 NOT_FOUND on GET and 404 UNKNOWN_MESSAGE on an action", async () => {
    const { base } = await start();
    const convId = await createDirect(base);
    const getRes = await fetch(`${base}/conversations/${convId}/messages/ghost`, { headers: authed() });
    expect(getRes.status).toBe(404);
    expect((await getRes.json()) as ErrorBody).toMatchObject({ error: { code: "NOT_FOUND" } });

    const deliverRes = await fetch(`${base}/conversations/${convId}/messages/ghost/delivered`, { method: "POST", headers: authed(), body: JSON.stringify({ recipientId: "u2" }) });
    expect(deliverRes.status).toBe(404);
    expect((await deliverRes.json()) as ErrorBody).toMatchObject({ error: { code: "UNKNOWN_MESSAGE" } });
  });

  it("pagination via HTTP: limit and cursor as query params page newest-first; a bad limit is 400", async () => {
    const { base } = await start();
    const convId = await createDirect(base);
    for (let i = 1; i <= 25; i++) {
      await fetch(`${base}/conversations/${convId}/messages`, { method: "POST", headers: authed(), body: JSON.stringify({ senderId: "u1", body: `msg ${i}`, clientMessageId: `c${i}` }) });
    }
    const p1 = await fetch(`${base}/conversations/${convId}/messages?memberId=u2&limit=20`, { headers: authed() });
    const page1 = (await p1.json()) as { items: { body: string; status: string }[]; nextCursor: string };
    expect(page1.items).toHaveLength(20);
    expect(page1.items[0]).toMatchObject({ body: "msg 25", status: "sent" });
    expect(page1.nextCursor).toBeTypeOf("string");

    const p2 = await fetch(`${base}/conversations/${convId}/messages?memberId=u2&limit=20&cursor=${encodeURIComponent(page1.nextCursor)}`, { headers: authed() });
    const page2 = (await p2.json()) as { items: { body: string }[]; nextCursor: string | null };
    expect(page2.items).toHaveLength(5);
    expect(page2.nextCursor).toBeNull();

    const badLimit = await fetch(`${base}/conversations/${convId}/messages?memberId=u2&limit=not-a-number`, { headers: authed() });
    expect(badLimit.status).toBe(400);
    expect((await badLimit.json()) as ErrorBody).toMatchObject({ error: { code: "INVALID_REQUEST" } });

    const badCursor = await fetch(`${base}/conversations/${convId}/messages?memberId=u2&cursor=garbage`, { headers: authed() });
    expect(badCursor.status).toBe(400);
    expect((await badCursor.json()) as ErrorBody).toMatchObject({ error: { code: "INVALID_CURSOR" } });

    // A bracketed query key (?cursor[x]=1) parses as an object, not a string. decodeCursor() would otherwise
    // crash with a raw TypeError (Buffer.from on a plain object) that is not a MessagingError -- this must come
    // back as a clean 400, never a leaked 500.
    const objectCursor = await fetch(`${base}/conversations/${convId}/messages?memberId=u2&cursor[x]=1`, { headers: authed() });
    expect(objectCursor.status).toBe(400);
    expect((await objectCursor.json()) as ErrorBody).toMatchObject({ error: { code: "INVALID_CURSOR" } });
  });

  it("edit and delete over HTTP: edit updates the body, delete clears it; editing a deleted message is 409 MESSAGE_DELETED", async () => {
    const { base } = await start();
    const convId = await createDirect(base);
    const sent = await fetch(`${base}/conversations/${convId}/messages`, { method: "POST", headers: authed(), body: JSON.stringify({ senderId: "u1", body: "hi", clientMessageId: "c1" }) });
    const message = (await sent.json()) as { id: string };

    const edited = await fetch(`${base}/conversations/${convId}/messages/${message.id}`, { method: "PATCH", headers: authed(), body: JSON.stringify({ senderId: "u1", body: "hi there" }) });
    expect(edited.status).toBe(200);
    expect(await edited.json()).toMatchObject({ body: "hi there", edited: true });

    const notSender = await fetch(`${base}/conversations/${convId}/messages/${message.id}`, { method: "PATCH", headers: authed(), body: JSON.stringify({ senderId: "u2", body: "nope" }) });
    expect(notSender.status).toBe(403);
    expect((await notSender.json()) as ErrorBody).toMatchObject({ error: { code: "SENDER_REQUIRED" } });

    const deleted = await fetch(`${base}/conversations/${convId}/messages/${message.id}`, { method: "DELETE", headers: authed(), body: JSON.stringify({ senderId: "u1" }) });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toMatchObject({ body: "", deletedAt: expect.any(Number) });

    const editDeleted = await fetch(`${base}/conversations/${convId}/messages/${message.id}`, { method: "PATCH", headers: authed(), body: JSON.stringify({ senderId: "u1", body: "resurrect?" }) });
    expect(editDeleted.status).toBe(409);
    expect((await editDeleted.json()) as ErrorBody).toMatchObject({ error: { code: "MESSAGE_DELETED" } });
  });

  it("markDelivered and markReadUpTo over HTTP follow the tick rule; a negative uptoSeq is 400", async () => {
    const { base } = await start();
    const convId = await createDirect(base);
    const sent = await fetch(`${base}/conversations/${convId}/messages`, { method: "POST", headers: authed(), body: JSON.stringify({ senderId: "u1", body: "hi", clientMessageId: "c1" }) });
    const message = (await sent.json()) as { id: string; seq: number };

    const delivered = await fetch(`${base}/conversations/${convId}/messages/${message.id}/delivered`, { method: "POST", headers: authed(), body: JSON.stringify({ recipientId: "u2" }) });
    expect(delivered.status).toBe(200);
    expect(await delivered.json()).toMatchObject({ status: "delivered" });

    const read = await fetch(`${base}/conversations/${convId}/read`, { method: "POST", headers: authed(), body: JSON.stringify({ recipientId: "u2", uptoSeq: message.seq }) });
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({ marked: 1 });

    const after = await fetch(`${base}/conversations/${convId}/messages/${message.id}`, { headers: authed() });
    expect((await after.json() as { status: string }).status).toBe("read");

    const badSeq = await fetch(`${base}/conversations/${convId}/read`, { method: "POST", headers: authed(), body: JSON.stringify({ recipientId: "u2", uptoSeq: -1 }) });
    expect(badSeq.status).toBe(400);
    expect((await badSeq.json()) as ErrorBody).toMatchObject({ error: { code: "INVALID_REQUEST" } });
  });

  it("a conversation that is mid-revision (addMember in flight) rejects a concurrent message op with 409 CONVERSATION_BUSY", async () => {
    const users = new InMemoryUsers();
    for (const userId of ["u1", "u2", "u3"]) users.upsert({ userId, displayName: `User ${userId}` });
    // A store that never resolves on its own, same technique as test/concurrency.test.ts, so addMember's commit
    // stays in flight long enough for a genuinely concurrent message op to observe `revising` still set.
    const store = new FakeConversationStore();
    const messenger = new Messenger({ users, store });
    const { base } = await start({ messenger });
    const conv = messenger.createGroupConversation("u1", ["u2"], "team");

    const addPromise = fetch(`${base}/conversations/${conv.id}/members`, { method: "POST", headers: authed(), body: JSON.stringify({ actingUserId: "u1", newUserId: "u3" }) });
    while (store.pending.length === 0) await flush(); // wait for addMember's synchronous claim + commit() call to land

    const busy = await fetch(`${base}/conversations/${conv.id}/messages`, { method: "POST", headers: authed(), body: JSON.stringify({ senderId: "u1", body: "hi", clientMessageId: "c1" }) });
    expect(busy.status).toBe(409);
    expect((await busy.json()) as ErrorBody).toMatchObject({ error: { code: "CONVERSATION_BUSY" } });

    store.resolveNext();
    await addPromise;
  });
});

describe("devices / presence", () => {
  it("connect (with and without a deviceId), online status, and disconnect round-trip over HTTP", async () => {
    const { base } = await start();
    const offline = await fetch(`${base}/users/u1/online`, { headers: authed() });
    expect(await offline.json()).toEqual({ online: false });

    const connected = await fetch(`${base}/users/u1/devices`, { method: "POST", headers: authed(), body: JSON.stringify({ deviceId: "phone" }) });
    expect(connected.status).toBe(200);
    expect(await connected.json()).toEqual({ deviceId: "phone" });

    const generated = await fetch(`${base}/users/u1/devices`, { method: "POST", headers: authed() });
    expect(generated.status).toBe(200);
    const { deviceId } = (await generated.json()) as { deviceId: string };
    expect(typeof deviceId).toBe("string");

    const online = await fetch(`${base}/users/u1/online`, { headers: authed() });
    expect(await online.json()).toEqual({ online: true });

    await fetch(`${base}/users/u1/devices/phone`, { method: "DELETE", headers: authed() });
    const stillOnline = await fetch(`${base}/users/u1/online`, { headers: authed() }); // the generated device is still connected
    expect(await stillOnline.json()).toEqual({ online: true });

    const disconnectUnknown = await fetch(`${base}/users/u1/devices/never-connected`, { method: "DELETE", headers: authed() });
    expect(disconnectUnknown.status).toBe(404);
    expect((await disconnectUnknown.json()) as ErrorBody).toMatchObject({ error: { code: "UNKNOWN_DEVICE" } });
  });

  it("connecting an unknown user is a 404 UNKNOWN_USER", async () => {
    const { base } = await start();
    const res = await fetch(`${base}/users/ghost/devices`, { method: "POST", headers: authed(), body: JSON.stringify({ deviceId: "phone" }) });
    expect(res.status).toBe(404);
    expect((await res.json()) as ErrorBody).toMatchObject({ error: { code: "UNKNOWN_USER" } });
  });

  it("a message sent to a recipient who connected a device beforehand is auto-delivered, over HTTP end to end", async () => {
    const { base } = await start();
    await fetch(`${base}/users/u2/devices`, { method: "POST", headers: authed(), body: JSON.stringify({ deviceId: "phone" }) });
    const convRes = await fetch(`${base}/conversations/direct`, { method: "POST", headers: authed(), body: JSON.stringify({ userIdA: "u1", userIdB: "u2" }) });
    const convId = ((await convRes.json()) as { id: string }).id;
    const sent = await fetch(`${base}/conversations/${convId}/messages`, { method: "POST", headers: authed(), body: JSON.stringify({ senderId: "u1", body: "hi", clientMessageId: "c1" }) });
    expect((await sent.json()) as { status: string }).toMatchObject({ status: "delivered" });
  });
});

describe("HTTP-layer error handling", () => {
  it("an unknown route is a 404 NOT_FOUND", async () => {
    const { base } = await start();
    const res = await fetch(`${base}/not-a-real-route`, { headers: authed() });
    expect(res.status).toBe(404);
    expect((await res.json()) as ErrorBody).toMatchObject({ error: { code: "NOT_FOUND" } });
  });

  it("a non-JSON Content-Type on a route that requires one is 415", async () => {
    const { base } = await start();
    const res = await fetch(`${base}/conversations/direct`, { method: "POST", headers: authed({ "content-type": "text/plain" }), body: "userIdA=u1" });
    expect(res.status).toBe(415);
  });

  it("malformed JSON is a 400 INVALID_JSON", async () => {
    const { base } = await start();
    const res = await fetch(`${base}/conversations/direct`, { method: "POST", headers: authed(), body: "{not valid json" });
    expect(res.status).toBe(400);
    expect((await res.json()) as ErrorBody).toMatchObject({ error: { code: "INVALID_JSON" } });
  });

  it("a body over the configured limit is a 413", async () => {
    const { base } = await start({ bodyLimit: "10b" });
    const res = await fetch(`${base}/conversations/direct`, { method: "POST", headers: authed(), body: JSON.stringify({ userIdA: "u1", userIdB: "u2" }) });
    expect(res.status).toBe(413);
  });

  it("an unexpected (non-library) error maps to 500 and is logged, not leaked to the caller", async () => {
    const messenger = defaultMessenger();
    // Force a genuine bug: monkey-patch a method to throw a plain Error, not a MessagingError.
    messenger.get = () => {
      throw new Error("boom: something truly unexpected");
    };
    const { base, logged } = await start({ messenger });
    const res = await fetch(`${base}/conversations/some-id`, { headers: authed() });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("INTERNAL");
    expect(body.error.message).not.toContain("boom"); // the real message is logged, not sent to the caller
    expect(logged).toHaveLength(1);
  });
});
