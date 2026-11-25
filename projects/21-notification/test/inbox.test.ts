// The in-app inbox: cursor paging, the unread counter, mark read / mark all read, retention, the in_app channel
// end to end, and the HTTP endpoints.
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { NotificationCatalog } from "../src/catalog.js";
import { ManualClock } from "../src/clock.js";
import { createApp } from "../src/http/app.js";
import { encodeCursor, InboxSender, InMemoryInbox } from "../src/inbox.js";
import { PreferenceStore } from "../src/preferences.js";
import { InMemoryJobQueue } from "../src/queue.js";
import { QueuedNotifier } from "../src/queued-notifier.js";
import { FakeSender } from "../src/senders.js";
import { InMemoryUsers } from "../src/users.js";
import { Worker } from "../src/worker.js";
import { errorCode, FULL_USER, T0 } from "./helpers.js";

function inboxWith(n: number, userId = "u1", options: { maxPerUser?: number } = {}) {
  const clock = new ManualClock(T0);
  let id = 0;
  const inbox = new InMemoryInbox({ clock, newId: () => `i${++id}`, ...options });
  for (let i = 1; i <= n; i++) inbox.add(userId, { key: `k${i}`, notificationId: `n${i}`, body: `msg ${i}` });
  return { inbox, clock };
}
const ids = (items: { id: string }[]) => items.map((i) => i.id);

describe("InMemoryInbox: paging", () => {
  it("newest first, pages of `limit`, the last page says so; every item exactly once", () => {
    const { inbox } = inboxWith(45);
    const p1 = inbox.page("u1", { limit: 20 });
    const p2 = inbox.page("u1", { limit: 20, cursor: p1.nextCursor! });
    const p3 = inbox.page("u1", { limit: 20, cursor: p2.nextCursor! });
    expect(ids(p1.items).slice(0, 2)).toEqual(["i45", "i44"]);
    expect([p1.items.length, p2.items.length, p3.items.length]).toEqual([20, 20, 5]);
    expect(p3.nextCursor).toBeNull();
    expect(ids([...p1.items, ...p2.items, ...p3.items])).toEqual(Array.from({ length: 45 }, (_, i) => `i${45 - i}`));
    expect(inbox.page("u1", { limit: 45 }).nextCursor).toBeNull(); // exactly fits: no empty extra page
    expect(inbox.page("nobody")).toEqual({ items: [], nextCursor: null, unread: 0 });
  });

  it("items arriving between two pages do not shift the next page (what ?page=2 would get wrong)", () => {
    const { inbox } = inboxWith(10);
    const p1 = inbox.page("u1", { limit: 4 }); // i10..i7
    for (let i = 11; i <= 13; i++) inbox.add("u1", { key: `k${i}`, notificationId: `n${i}`, body: "new" });
    const p2 = inbox.page("u1", { limit: 4, cursor: p1.nextCursor! });
    expect(ids(p2.items)).toEqual(["i6", "i5", "i4", "i3"]);
    expect(ids(inbox.page("u1", { limit: 3 }).items)).toEqual(["i13", "i12", "i11"]); // the new ones are on top
  });

  it("cursors are opaque and checked; limit must be 1..100", () => {
    const { inbox } = inboxWith(3);
    for (const bad of ["garbage", "", Buffer.from("v1.x").toString("base64url"), Buffer.from("v1.05").toString("base64url"), `${encodeCursor(2)}=`]) {
      expect(errorCode(() => inbox.page("u1", { cursor: bad }))).toBe("INVALID_CURSOR");
    }
    expect(ids(inbox.page("u1", { cursor: encodeCursor(2) }).items)).toEqual(["i1"]);
    for (const limit of [0, 101, 1.5, Number.NaN]) expect(errorCode(() => inbox.page("u1", { limit }))).toBe("INVALID_REQUEST");
    expect(inbox.page("u1", { limit: 100 }).items).toHaveLength(3);
  });
});

describe("InMemoryInbox: unread, mark read, retention", () => {
  it("add is idempotent on the key: the same message twice is one item", () => {
    const { inbox } = inboxWith(0);
    const a = inbox.add("u1", { key: "n1:in_app", notificationId: "n1", body: "x" });
    const b = inbox.add("u1", { key: "n1:in_app", notificationId: "n1", body: "x" });
    expect(b.id).toBe(a.id);
    expect(inbox.unreadCount("u1")).toBe(1);
  });

  it("markRead: once marked, again already_read (the count drops once); another user's item is not_found", () => {
    const { inbox, clock } = inboxWith(3);
    inbox.add("u2", { key: "x", notificationId: "nx", body: "theirs" }); // i4, u2's
    clock.advance(1_000);
    expect(inbox.markRead("u1", "i2")).toBe("marked");
    expect(inbox.markRead("u1", "i2")).toBe("already_read");
    expect(inbox.unreadCount("u1")).toBe(2);
    expect(inbox.markRead("u1", "i4")).toBe("not_found"); // guessing another user's id does nothing
    expect(inbox.unreadCount("u2")).toBe(1);
    expect(inbox.page("u1").items.find((i) => i.id === "i2")!.readAt).toBe(T0 + 1_000);
  });

  it("markAllRead up to the item the user saw: a newer arrival stays unread", () => {
    const { inbox } = inboxWith(3);
    inbox.markRead("u1", "i2");
    inbox.add("u1", { key: "k4", notificationId: "n4", body: "arrived while clicking" }); // i4
    expect(inbox.markAllRead("u1", "i3")).toBe(2); // i1 and i3; i2 was already read
    expect(inbox.unreadCount("u1")).toBe(1);
    expect(inbox.page("u1").items[0]).toMatchObject({ id: "i4" });
    expect(inbox.page("u1").items[0]).not.toHaveProperty("readAt");
    expect(inbox.markAllRead("u1", "nope")).toBeUndefined();
    expect(inbox.markAllRead("u2", "i3")).toBeUndefined(); // not u2's item
  });

  it("retention: over maxPerUser the oldest goes; an unread one dropped lowers the count, a read one does not", () => {
    const { inbox } = inboxWith(3, "u1", { maxPerUser: 3 });
    inbox.markRead("u1", "i2");
    inbox.add("u1", { key: "k4", notificationId: "n4", body: "4" }); // drops i1 (unread)
    expect([inbox.unreadCount("u1"), ids(inbox.page("u1").items)]).toEqual([2, ["i4", "i3", "i2"]]);
    inbox.add("u1", { key: "k5", notificationId: "n5", body: "5" }); // drops i2 (read)
    expect(inbox.unreadCount("u1")).toBe(3);
    expect(inbox.markRead("u1", "i1")).toBe("not_found");
    expect(() => new InMemoryInbox({ maxPerUser: 0 })).toThrow(RangeError);
  });

  it("randomized: after every operation the counter equals the unread items counted from scratch, and a full walk sees each item once", () => {
    let s = 7;
    const rand = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
    const { inbox } = inboxWith(0, "u1", { maxPerUser: 25 });
    const users = ["u1", "u2", "u3"];
    let n = 0;
    const walk = (u: string) => {
      const all = [];
      let cursor: string | undefined;
      do {
        const page = inbox.page(u, { limit: 1 + Math.floor(rand() * 7), ...(cursor ? { cursor } : {}) });
        all.push(...page.items);
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      return all;
    };
    for (let step = 0; step < 2_000; step++) {
      const u = users[Math.floor(rand() * 3)]!;
      const r = rand();
      if (r < 0.5) inbox.add(u, { key: `k${rand() < 0.1 ? Math.floor(rand() * n) : ++n}`, notificationId: "n", body: "b" });
      else if (r < 0.8) inbox.markRead(u, `i${1 + Math.floor(rand() * (n + 2))}`);
      else if (r < 0.9) inbox.markAllRead(u, `i${1 + Math.floor(rand() * (n + 2))}`);
      const items = walk(u);
      expect(new Set(ids(items)).size).toBe(items.length);
      expect(items.length).toBeLessThanOrEqual(25);
      expect(items.map((i) => Number(i.id.slice(1)))).toEqual([...items.map((i) => Number(i.id.slice(1)))].sort((a, b) => b - a));
      expect(inbox.unreadCount(u)).toBe(items.filter((i) => i.readAt === undefined).length);
    }
  });
});

describe("the in_app channel end to end", () => {
  function system() {
    const clock = new ManualClock(T0);
    const catalog = new NotificationCatalog();
    catalog.register({
      id: "promo",
      category: "marketing",
      mode: "all",
      channels: ["push", "in_app"],
      templates: { push: { body: "{{pct}}% off" }, in_app: { subject: "Sale <today>", body: "{{pct}}% off <b>now</b>" } },
    });
    const users = new InMemoryUsers();
    users.upsert({ ...FULL_USER, utcOffsetMinutes: 0 });
    const preferences = new PreferenceStore();
    let id = 0;
    const inbox = new InMemoryInbox({ clock, newId: () => `i${++id}` });
    const push = new FakeSender("push");
    const notifier = new QueuedNotifier({ catalog, users, preferences, senders: [push, new InboxSender(inbox)], queue: new InMemoryJobQueue(), clock });
    return { clock, catalog, preferences, inbox, push, notifier, worker: new Worker(notifier) };
  }
  const promo = (key = "p1") => ({ typeId: "promo", userId: "u1", data: { pct: 20 }, idempotencyKey: key });

  it("a notification lands in the inbox (title and body not HTML-escaped); the delivery's provider id is the item id", async () => {
    const { notifier, worker, inbox } = system();
    const r = notifier.notify(promo());
    await worker.drain();
    const [item] = inbox.page("u1").items;
    expect(item).toMatchObject({ notificationId: r.id, title: "Sale <today>", body: "20% off <b>now</b>" });
    expect(notifier.get(r.id)!.deliveries[1]).toMatchObject({ channel: "in_app", status: "sent", to: "u1", providerId: item!.id });
  });

  it("quiet hours defer the push but not the inbox (it wakes nobody); a muted inbox is opted_out", async () => {
    const { notifier, worker, inbox, preferences } = system();
    preferences.set("u1", { mutedMarketing: [], quietHours: { start: "11:00", end: "13:00" } }); // 12:00 UTC now
    const r = notifier.notify(promo());
    await worker.drain();
    expect(notifier.get(r.id)!.deliveries.map((d) => `${d.channel}:${d.status}`)).toEqual(["push:deferred", "in_app:sent"]);
    preferences.set("u1", { mutedMarketing: ["in_app"] });
    const muted = notifier.notify(promo("p2"));
    expect(notifier.get(muted.id)!.deliveries[1]).toMatchObject({ status: "skipped", skipReason: "opted_out" });
    expect(inbox.unreadCount("u1")).toBe(1);
  });

  it("the same message sent twice (a redelivered job) is one inbox item", async () => {
    const { inbox } = system();
    const sender = new InboxSender(inbox);
    const message = { notificationId: "n1", channel: "in_app" as const, to: "u1", idempotencyKey: "n1:in_app", body: "x" };
    const a = await sender.send(message);
    const b = await sender.send(message);
    expect(b).toEqual(a);
    expect(inbox.unreadCount("u1")).toBe(1);
  });

  it("catalog: in_app may have a subject (the title); sms and push may not", () => {
    const { catalog } = system();
    expect(errorCode(() => catalog.register({ id: "bad", category: "marketing", mode: "all", channels: ["push"], templates: { push: { subject: "x", body: "y" } } }))).toBe(
      "INVALID_TYPE",
    );
    expect(() => catalog.register({ id: "ok", category: "marketing", mode: "all", channels: ["in_app"], templates: { in_app: { body: "y" } } })).not.toThrow();
  });
});

describe("HTTP: the inbox", () => {
  const KEY = "test-key-0123456789abcdef";
  const servers: Server[] = [];
  afterEach(async () => {
    for (const s of servers.splice(0)) {
      s.closeAllConnections();
      await new Promise<void>((r) => s.close(() => r()));
    }
  });
  async function start(withInbox = true) {
    const { inbox } = inboxWith(5);
    inbox.add("u2", { key: "x", notificationId: "nx", body: "theirs" }); // i6
    const users = new InMemoryUsers();
    users.upsert(FULL_USER);
    users.upsert({ userId: "u2" });
    const notifier = new QueuedNotifier({ catalog: new NotificationCatalog(), users, preferences: new PreferenceStore(), senders: [], queue: new InMemoryJobQueue() });
    const app = createApp({ notifier, users, preferences: new PreferenceStore(), apiKey: KEY, ...(withInbox ? { inbox } : {}) });
    const server = await new Promise<Server>((r) => {
      const srv = app.listen(0, "127.0.0.1", () => r(srv));
    });
    servers.push(server);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const call = (method: string, path: string, body?: unknown) =>
      fetch(base + path, {
        method,
        headers: { authorization: `Bearer ${KEY}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    return { inbox, call };
  }

  it("pages with the cursor from the previous page; unread count; bad limit or cursor -> 400", async () => {
    const { call } = await start();
    const p1 = await (await call("GET", "/users/u1/inbox?limit=2")).json();
    expect([ids(p1.items), p1.unread]).toEqual([["i5", "i4"], 5]);
    const p2 = await (await call("GET", `/users/u1/inbox?limit=2&cursor=${p1.nextCursor}`)).json();
    expect(ids(p2.items)).toEqual(["i3", "i2"]);
    expect(await (await call("GET", "/users/u1/inbox/unread-count")).json()).toEqual({ unread: 5 });
    for (const [q, code] of [["limit=abc", "INVALID_REQUEST"], ["limit=1e1", "INVALID_REQUEST"], ["limit=%205", "INVALID_REQUEST"], ["limit=0", "INVALID_REQUEST"], ["limit=1000", "INVALID_REQUEST"], ["cursor=zzz", "INVALID_CURSOR"], ["cursor=a&cursor=b", "INVALID_CURSOR"]]) {
      const res = await call("GET", `/users/u1/inbox?${q}`);
      expect([res.status, (await res.json()).error.code]).toEqual([400, code]);
    }
  });

  it("read: 204, again 204, count dropped once; another user's item -> 404; read-all up to the item seen", async () => {
    const { call, inbox } = await start();
    expect((await call("POST", "/users/u1/inbox/i3/read")).status).toBe(204);
    expect((await call("POST", "/users/u1/inbox/i3/read")).status).toBe(204);
    expect(inbox.unreadCount("u1")).toBe(4);
    const theirs = await call("POST", "/users/u1/inbox/i6/read");
    expect([theirs.status, (await theirs.json()).error.code]).toEqual([404, "NOT_FOUND"]);
    expect(inbox.unreadCount("u2")).toBe(1);
    expect(await (await call("POST", "/users/u1/inbox/read-all", { upTo: "i4" })).json()).toEqual({ marked: 3, unread: 1 });
    expect((await call("POST", "/users/u1/inbox/read-all", { upTo: "i6" })).status).toBe(404);
    expect((await call("POST", "/users/u1/inbox/read-all", {})).status).toBe(400);
  });

  it("unknown user -> 404; no inbox configured -> 404", async () => {
    const { call } = await start();
    expect((await call("GET", "/users/ghost/inbox")).status).toBe(404);
    expect((await call("GET", "/users/ghost/inbox/unread-count")).status).toBe(404);
    const without = await start(false);
    expect((await without.call("GET", "/users/u1/inbox")).status).toBe(404);
  });
});
