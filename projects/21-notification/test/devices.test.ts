// Several push devices per user: the directory's token rules, fan-out in both notifiers, dead tokens removed, and
// the device-registration endpoints.
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { notificationStatus } from "../src/record.js";
import { InMemoryUsers, MAX_PUSH_TOKENS } from "../src/users.js";
import { errorCode, FULL_USER, gate, setup } from "./helpers.js";
import { failed, orderReq, otpReq, setupQueued } from "./queued-helpers.js";

const THREE = { ...FULL_USER, pushTokens: ["tok-a", "tok-b", "tok-c"] };
const dead = { status: "failed" as const, retryable: false, reason: "unregistered", invalidAddress: true };

describe("InMemoryUsers: push tokens", () => {
  it("add moves a known token to the newest place; over the cap the oldest is dropped; unknown user -> false", () => {
    const users = new InMemoryUsers();
    users.upsert({ userId: "u1", pushTokens: ["t1", "t2"] });
    expect(users.addPushToken("u1", "t1")).toBe(true);
    expect(users.get("u1")!.pushTokens).toEqual(["t2", "t1"]);
    for (let i = 3; i <= MAX_PUSH_TOKENS + 2; i++) users.addPushToken("u1", `t${i}`);
    const tokens = users.get("u1")!.pushTokens!;
    expect(tokens).toHaveLength(MAX_PUSH_TOKENS);
    expect(tokens).not.toContain("t2"); // the oldest two went
    expect(tokens).not.toContain("t1");
    expect(tokens.at(-1)).toBe(`t${MAX_PUSH_TOKENS + 2}`);
    expect(users.addPushToken("ghost", "t")).toBe(false);
  });

  it("remove; bad tokens and lists are refused; the stored list cannot be changed through a returned copy", () => {
    const users = new InMemoryUsers();
    users.upsert({ userId: "u1", pushTokens: ["t1", "t2"] });
    expect(users.removePushToken("u1", "t1")).toBe(true);
    expect(users.removePushToken("u1", "t1")).toBe(false);
    expect(users.removePushToken("ghost", "t2")).toBe(false);
    for (const bad of ["", "has space", "x".repeat(4097), 7]) expect(errorCode(() => users.addPushToken("u1", bad as string))).toBe("INVALID_REQUEST");
    expect(errorCode(() => users.upsert({ userId: "u2", pushTokens: "t" as never }))).toBe("INVALID_REQUEST");
    expect(errorCode(() => users.upsert({ userId: "u2", pushTokens: ["ok", ""] }))).toBe("INVALID_REQUEST");
    const many = Array.from({ length: MAX_PUSH_TOKENS + 1 }, (_, i) => `t${i}`);
    expect(errorCode(() => users.upsert({ userId: "u2", pushTokens: many }))).toBe("INVALID_REQUEST");
    users.get("u1")!.pushTokens!.push("sneaky");
    expect(users.get("u1")!.pushTokens).toEqual(["t2"]);
  });
});

describe("fan-out to every device (QueuedNotifier)", () => {
  it("one push delivery, one round, a call per device with its own provider key; all logged", async () => {
    const { notifier, worker, push } = setupQueued({ users: [THREE] });
    const r = notifier.notify(orderReq());
    await worker.drain();
    expect(push.attempts.map((m) => [m.to, m.idempotencyKey])).toEqual([
      ["tok-a", `${r.id}:push:tok-a`],
      ["tok-b", `${r.id}:push:tok-b`],
      ["tok-c", `${r.id}:push:tok-c`],
    ]);
    const d = notifier.get(r.id)!.deliveries[0]!;
    expect(d).toMatchObject({ status: "sent", attempts: 1 });
    expect(d.devices!.map((x) => x.status)).toEqual(["sent", "sent", "sent"]);
  });

  it("one device accepted, one dead: sent; the dead token is removed and the next push skips it", async () => {
    const { notifier, worker, push, users } = setupQueued({ users: [{ ...FULL_USER, pushTokens: ["tok-a", "tok-b"] }] });
    push.willAnswer(dead); // tok-a
    const r = notifier.notify(orderReq());
    await worker.drain();
    const d = notifier.get(r.id)!.deliveries[0]!;
    expect(d.status).toBe("sent");
    expect(d.devices).toEqual([
      { token: "tok-a", status: "failed", error: "unregistered", retryable: false, removed: true },
      { token: "tok-b", status: "sent", providerId: "push-1" },
    ]);
    expect(users.get("u1")!.pushTokens).toEqual(["tok-b"]);
    expect(notifier.stats.sent).toBe(2); // the push delivery and the email delivery
    notifier.notify(orderReq("o2"));
    await worker.drain();
    expect(push.attempts.slice(2).map((m) => m.to)).toEqual(["tok-b"]);
  });

  it("nobody accepted, one retryable: retried later, and only to the device that did not fail for good", async () => {
    const { notifier, worker, push, clock } = setupQueued({ users: [{ ...FULL_USER, pushTokens: ["tok-a", "tok-b"] }] });
    push.willAnswer(failed(false, "bad token"), failed(true, "503"));
    const r = notifier.notify(orderReq());
    await worker.drain();
    expect(notifier.get(r.id)!.deliveries[0]).toMatchObject({ status: "pending", attempts: 1 });
    clock.advance(1_000);
    await worker.drain();
    expect(push.attempts.map((m) => m.to)).toEqual(["tok-a", "tok-b", "tok-b"]);
    const d = notifier.get(r.id)!.deliveries[0]!;
    expect(d).toMatchObject({ status: "sent", attempts: 2 });
    expect(d.devices!.map((x) => `${x.token}:${x.status}`)).toEqual(["tok-a:failed", "tok-b:sent"]);
  });

  it("every device failed for good: a permanent failure, and \"first\" moves to the next channel", async () => {
    const { notifier, worker, push, sms } = setupQueued({ users: [{ ...FULL_USER, pushTokens: ["tok-a", "tok-b"] }] });
    push.willAnswer(failed(false, "x"), failed(false, "y"));
    const r = notifier.notify(otpReq());
    await worker.drain();
    const [p, s] = notifier.get(r.id)!.deliveries;
    expect(p).toMatchObject({ status: "failed", retryable: false, attempts: 1 });
    expect(p!.error).toBe("no device accepted (tok-a: x; tok-b: y)");
    expect(s!.status).toBe("sent");
    expect(sms.sent).toHaveLength(1);
    expect(push.attempts).toHaveLength(2);
  });

  it("every token dead: all removed; the next notification skips push (no_address) and goes by SMS", async () => {
    const { notifier, worker, push, users } = setupQueued({ users: [{ ...FULL_USER, pushTokens: ["tok-a", "tok-b"] }] });
    push.willAnswer(dead, dead);
    notifier.notify(otpReq());
    await worker.drain();
    expect(users.get("u1")!.pushTokens).toEqual([]);
    const next = notifier.notify(otpReq("k2"));
    await worker.drain();
    expect(notifier.get(next.id)!.deliveries.map((d) => `${d.channel}:${d.status}${d.skipReason ? `(${d.skipReason})` : ""}`)).toEqual([
      "push:skipped(no_address)",
      "sms:sent",
      "email:skipped(not_needed)",
    ]);
  });

  it("attempts count rounds, not calls: 2 devices x 3 rounds = 6 calls, 3 attempts, then failed", async () => {
    const { notifier, worker, push, clock } = setupQueued({ users: [{ ...FULL_USER, pushTokens: ["tok-a", "tok-b"] }] });
    push.willAnswer(...Array.from({ length: 6 }, () => failed(true, "503")));
    const r = notifier.notify(orderReq());
    for (let i = 0; i < 4; i++) {
      await worker.drain();
      clock.advance(10_000);
    }
    expect(push.attempts).toHaveLength(6);
    expect(notifier.get(r.id)!.deliveries[0]).toMatchObject({ status: "failed", retryable: true, attempts: 3 });
  });

  it("a device registered between two attempts gets the retry (the targets are read at send time)", async () => {
    const { notifier, worker, push, users, clock } = setupQueued();
    push.willAnswer(failed(true, "503"));
    const r = notifier.notify(orderReq());
    await worker.drain();
    users.addPushToken("u1", "tok-new");
    clock.advance(1_000);
    await worker.drain();
    expect(push.attempts.map((m) => m.to)).toEqual(["tok-1", "tok-1", "tok-new"]);
    expect(notifier.get(r.id)!.deliveries[0]!.status).toBe("sent");
  });

  it("a worker that lost its lease does not write its device log over the new owner's", async () => {
    const { notifier, worker, push, clock } = setupQueued({ users: [{ ...FULL_USER, pushTokens: ["tok-a", "tok-b"] }] });
    const slow = gate<{ status: "failed"; retryable: true; reason: string }>();
    push.willAnswer(() => slow.promise, () => slow.promise);
    const r = notifier.notify(orderReq());
    const jobs = notifier.claim(4);
    const stalled = Promise.all(jobs.map((j) => notifier.process(j)));
    clock.advance(30_000); // the leases run out while the first worker waits on the provider
    await worker.drain(); // another worker sends to both devices
    slow.resolve({ status: "failed", retryable: true, reason: "late" });
    await stalled;
    const d = notifier.get(r.id)!.deliveries[0]!;
    expect(d.status).toBe("sent");
    expect(d.devices!.map((x) => x.status)).toEqual(["sent", "sent"]);
    expect(notifier.stats.leaseLost).toBeGreaterThanOrEqual(1);
  });

  it("invalidAddress on a RETRYABLE failure is ignored: the token stays (a 503 says nothing about the device)", async () => {
    const { notifier, worker, push, users } = setupQueued({ users: [{ ...FULL_USER, pushTokens: ["tok-a", "tok-b"] }] });
    push.willAnswer({ status: "failed", retryable: true, reason: "503", invalidAddress: true });
    notifier.notify(orderReq());
    await worker.drain();
    expect(users.get("u1")!.pushTokens).toEqual(["tok-a", "tok-b"]);
  });

  it("every device's call refused by an open circuit: \"first\" fails over to SMS at once, no attempt used", async () => {
    const breaker = { windowSize: 4, minimumCalls: 2, failureRateThreshold: 0.5, openMs: 30_000 };
    const { notifier, worker, push, sms } = setupQueued({ users: [{ ...FULL_USER, pushTokens: ["tok-a", "tok-b"] }], breaker, retry: { maxAttempts: 1 } });
    push.willAnswer(failed(true, "503"), failed(true, "503"));
    notifier.notify(orderReq()); // two failing calls open the push breaker
    await worker.drain();
    expect(notifier.breakerState("push")).toBe("open");
    const r = notifier.notify(otpReq());
    await worker.drain();
    const [p, s] = notifier.get(r.id)!.deliveries;
    expect(p).toMatchObject({ status: "failed", error: "circuit open", attempts: 0 });
    expect(s!.status).toBe("sent");
    expect(sms.sent).toHaveLength(1);
    expect(push.attempts).toHaveLength(2); // no call reached the provider for the OTP
  });

  it("a receipt for any device's provider id belongs to the delivery", async () => {
    const { notifier, worker } = setupQueued({ users: [{ ...FULL_USER, pushTokens: ["tok-a", "tok-b"] }] });
    const r = notifier.notify(orderReq());
    await worker.drain();
    const second = notifier.get(r.id)!.deliveries[0]!.devices![1]!.providerId!;
    expect(notifier.applyReceipt("push", second, { event: "delivered", at: 1 })).toBe("applied");
    expect(notifier.get(r.id)!.deliveries[0]!.receipt).toEqual({ event: "delivered", at: 1 });
  });
});

describe("fan-out in the stage 1 Notifier", () => {
  it("sends to every device and logs them; a dead token is removed", async () => {
    const s = setup({ users: [{ ...FULL_USER, pushTokens: ["tok-a", "tok-b"] }] });
    s.push.willAnswer(dead);
    const r = await s.notifier.notify(orderReq());
    expect(s.push.attempts.map((m) => m.to)).toEqual(["tok-a", "tok-b"]);
    expect(r.deliveries[0]!.devices!.map((x) => `${x.token}:${x.status}`)).toEqual(["tok-a:failed", "tok-b:sent"]);
    expect(notificationStatus(r)).toBe("delivered");
    expect(s.users.get("u1")!.pushTokens).toEqual(["tok-b"]);
  });
});

describe("HTTP: device registration", () => {
  const KEY = "test-key-0123456789abcdef";
  const servers: Server[] = [];
  afterEach(async () => {
    for (const s of servers.splice(0)) {
      s.closeAllConnections();
      await new Promise<void>((r) => s.close(() => r()));
    }
  });
  async function start(withRegistry = true) {
    const s = setupQueued();
    const app = createApp({ notifier: s.notifier, users: s.users, preferences: s.preferences, apiKey: KEY, ...(withRegistry ? { pushTokens: s.users } : {}) });
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
    return { ...s, call };
  }

  it("register (twice is fine), unregister, unregister again -> 404; the token list is not echoed", async () => {
    const { call, users } = await start();
    const add = await call("POST", "/users/u1/push-tokens", { token: "tok-new:abc_123" });
    expect([add.status, await add.text()]).toEqual([204, ""]);
    expect((await call("POST", "/users/u1/push-tokens", { token: "tok-new:abc_123" })).status).toBe(204);
    expect(users.get("u1")!.pushTokens).toEqual(["tok-1", "tok-new:abc_123"]);
    expect((await call("DELETE", `/users/u1/push-tokens/${encodeURIComponent("tok-new:abc_123")}`)).status).toBe(204);
    expect(users.get("u1")!.pushTokens).toEqual(["tok-1"]);
    const again = await call("DELETE", "/users/u1/push-tokens/tok-new%3Aabc_123");
    expect([again.status, (await again.json()).error.code]).toEqual([404, "NOT_FOUND"]);
  });

  it("bad token -> 400; unknown user -> 404; no registry configured -> 404", async () => {
    const { call } = await start();
    for (const body of [{ token: "" }, { token: "has space" }, { token: 7 }, {}, []]) {
      const res = await call("POST", "/users/u1/push-tokens", body);
      expect([res.status, (await res.json()).error.code]).toEqual([400, "INVALID_REQUEST"]);
    }
    expect((await call("POST", "/users/ghost/push-tokens", { token: "t" })).status).toBe(404);
    expect((await call("DELETE", "/users/ghost/push-tokens/t")).status).toBe(404);
    const without = await start(false);
    expect((await without.call("POST", "/users/u1/push-tokens", { token: "t" })).status).toBe(404);
  });
});
