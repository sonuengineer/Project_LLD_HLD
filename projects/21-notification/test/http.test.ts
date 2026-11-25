// The HTTP API against a real Express server on a random port, called with Node's fetch.
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, type AppOptions } from "../src/http/app.js";
import { signWebhook } from "../src/receipts.js";
import { InMemoryJobQueue } from "../src/queue.js";
import { QueuedNotifier } from "../src/queued-notifier.js";
import { orderReq, setupQueued } from "./queued-helpers.js";

const KEY = "test-key-0123456789abcdef";
const PUSH_SECRET = "whsec-push-0123456789";
const EMAIL_SECRET = "whsec-email-0123456789";
const servers: Server[] = [];

async function listen(app: express.Express): Promise<string> {
  const s = await new Promise<Server>((r) => {
    const srv = app.listen(0, "127.0.0.1", () => r(srv));
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

async function start(overrides: Partial<AppOptions> = {}) {
  const s = setupQueued();
  const logged: unknown[] = [];
  const base = await listen(
    createApp({
      notifier: s.notifier,
      users: s.users,
      preferences: s.preferences,
      apiKey: KEY,
      log: (_m, e) => logged.push(e),
      clock: s.clock,
      webhookSecrets: { push: PUSH_SECRET, email: EMAIL_SECRET },
      ...overrides,
    }),
  );
  const call = (method: string, path: string, init: { body?: unknown; raw?: string; headers?: Record<string, string> } = {}) =>
    fetch(base + path, {
      method,
      headers: {
        authorization: `Bearer ${KEY}`,
        ...(init.body !== undefined || init.raw !== undefined ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
      ...(init.raw !== undefined ? { body: init.raw } : init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
  // key null = no Idempotency-Key header (undefined would fall back to the default).
  const post = (body: unknown, key: string | null = "k1", headers: Record<string, string> = {}) =>
    call("POST", "/notifications", { body, headers: { ...(key !== null ? { "idempotency-key": key } : {}), ...headers } });
  return { ...s, base, call, post, logged };
}

const otp = { typeId: "otp", userId: "u1", data: { code: "123456" } };

describe("HTTP API: auth", () => {
  it("no key, a wrong key, or the key without 'Bearer ' -> 401, and nothing is queued", async () => {
    const { base, queue } = await start();
    const send = (authorization?: string) =>
      fetch(`${base}/notifications`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "k1", ...(authorization ? { authorization } : {}) },
        body: JSON.stringify(otp),
      });
    for (const auth of [undefined, `Bearer ${KEY}x`, KEY, `bearer ${KEY}`, "Bearer "]) {
      const res = await send(auth);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: { code: "UNAUTHORIZED", message: "missing or wrong API key" } });
    }
    expect(queue.size).toBe(0);
  });

  it("401 comes before the body is parsed: broken JSON without a key is 401, not 400", async () => {
    const { base } = await start();
    const res = await fetch(`${base}/notifications`, { method: "POST", headers: { "content-type": "application/json" }, body: "{" });
    expect(res.status).toBe(401);
  });

  it("refuses to start without a real key", () => {
    const s = setupQueued();
    for (const apiKey of ["", "short", undefined as unknown as string]) {
      expect(() => createApp({ notifier: s.notifier, users: s.users, preferences: s.preferences, apiKey })).toThrow(RangeError);
    }
    expect(() => createApp({ notifier: s.notifier, users: s.users, preferences: s.preferences, apiKey: "x".repeat(16) })).not.toThrow();
  });
});

describe("HTTP API: POST /notifications", () => {
  it("new request -> 202 with Location; queued, not sent; a worker sends; GET shows delivered", async () => {
    const { post, call, worker, push } = await start();
    const res = await post(otp);
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(res.headers.get("location")).toBe(`/notifications/${body.id}`);
    expect(body).toMatchObject({ typeId: "otp", userId: "u1", idempotencyKey: "k1", status: "in_progress" });
    expect(push.attempts).toHaveLength(0);
    await worker.drain();
    const after = await call("GET", `/notifications/${body.id}`);
    expect(after.status).toBe(200);
    expect(await after.json()).toMatchObject({ id: body.id, status: "delivered" });
    expect(push.sent).toHaveLength(1);
  });

  it("the same key and body again -> 200, Idempotent-Replayed, the same record, nothing queued", async () => {
    const { post, queue } = await start();
    const first = await (await post(otp)).json();
    const res = await post({ ...otp, data: { code: "123456" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("idempotent-replayed")).toBe("true");
    expect((await res.json()).id).toBe(first.id);
    expect(queue.size).toBe(1);
  });

  it("the same key with a different body -> 409; the first record is untouched", async () => {
    const { post, call } = await start();
    const first = await (await post(otp)).json();
    const res = await post({ ...otp, data: { code: "999999" } });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("IDEMPOTENCY_CONFLICT");
    expect((await (await call("GET", `/notifications/${first.id}`)).json()).deliveries[0].body).toBe("Code 123456");
  });

  it("malformed requests -> 400 with a code; an error stores nothing (the key is still free)", async () => {
    const { post, call, queue } = await start();
    const cases: [Promise<Response>, string][] = [
      [post(otp, null), "INVALID_REQUEST"], // no Idempotency-Key
      [post(otp, ""), "INVALID_REQUEST"], // empty key
      [post(otp, "x".repeat(256)), "INVALID_REQUEST"], // key too long
      [post([otp]), "INVALID_REQUEST"], // body not an object
      [post({ ...otp, typeId: 7 }), "INVALID_REQUEST"],
      [post({ ...otp, userId: null }), "INVALID_REQUEST"],
      [post({ typeId: "otp", userId: "u1" }), "INVALID_REQUEST"], // no data
      [post({ ...otp, data: [1] }), "INVALID_REQUEST"],
      [call("POST", "/notifications", { raw: '{"typeId":', headers: { "idempotency-key": "k1" } }), "INVALID_JSON"],
    ];
    for (const [i, [pending, code]] of cases.entries()) {
      const res = await pending;
      expect([i, res.status]).toEqual([i, 400]);
      expect((await res.json()).error.code).toBe(code);
    }
    expect(queue.size).toBe(0);
    expect((await (await post(otp, null)).json()).error.message).toBe("Idempotency-Key header is required");
    expect((await post(otp)).status).toBe(202); // "k1" was never taken by the failed requests
  });

  it("well-formed but impossible -> 422; nothing stored", async () => {
    const { post, queue } = await start();
    const cases: [unknown, string][] = [
      [{ ...otp, typeId: "nope" }, "UNKNOWN_TYPE"],
      [{ ...otp, userId: "ghost" }, "UNKNOWN_USER"],
      [{ ...otp, data: {} }, "TEMPLATE_VARIABLE_MISSING"],
    ];
    for (const [body, code] of cases) {
      const res = await post(body);
      expect(res.status).toBe(422);
      expect((await res.json()).error.code).toBe(code);
    }
    expect(queue.size).toBe(0);
  });

  it("not JSON -> 415; over the body limit -> 413", async () => {
    const { base, post } = await start({ bodyLimit: "1kb" });
    const text = await fetch(`${base}/notifications`, {
      method: "POST",
      headers: { authorization: `Bearer ${KEY}`, "idempotency-key": "k1", "content-type": "text/plain" },
      body: JSON.stringify(otp),
    });
    expect(text.status).toBe(415);
    expect((await text.json()).error.code).toBe("UNSUPPORTED_MEDIA_TYPE");
    const big = await post({ ...otp, data: { code: "1", pad: "x".repeat(2_000) } });
    expect(big.status).toBe(413);
    expect((await big.json()).error.code).toBe("BODY_TOO_LARGE");
  });
});

describe("HTTP API: errors that are ours", () => {
  it("a channel with no sender is a 500 with the message hidden, and it is logged", async () => {
    const s = setupQueued();
    const notifier = new QueuedNotifier({
      catalog: s.catalog,
      users: s.users,
      preferences: s.preferences,
      senders: [s.push], // otp also needs sms and email
      queue: new InMemoryJobQueue(),
    });
    const logged: unknown[] = [];
    const base = await listen(createApp({ notifier, users: s.users, preferences: s.preferences, apiKey: KEY, log: (_m, e) => logged.push(e) }));
    const res = await fetch(`${base}/notifications`, {
      method: "POST",
      headers: { authorization: `Bearer ${KEY}`, "idempotency-key": "k1", "content-type": "application/json" },
      body: JSON.stringify(otp),
    });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: { code: "INTERNAL", message: "internal error" } });
    expect((logged[0] as { code?: string }).code).toBe("NO_SENDER");
  });

  it("an unexpected throw is a 500 with the message hidden, and it is logged", async () => {
    const s = setupQueued();
    const broken = { getByKey: () => { throw new Error("secret detail"); } } as unknown as QueuedNotifier;
    const logged: unknown[] = [];
    const base = await listen(createApp({ notifier: broken, users: s.users, preferences: s.preferences, apiKey: KEY, log: (_m, e) => logged.push(e) }));
    const res = await fetch(`${base}/notifications`, {
      method: "POST",
      headers: { authorization: `Bearer ${KEY}`, "idempotency-key": "k1", "content-type": "application/json" },
      body: JSON.stringify(otp),
    });
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("secret");
    expect((logged[0] as Error).message).toBe("secret detail");
  });
});

describe("HTTP API: reads and preferences", () => {
  it("unknown notification, unknown user, unknown route -> 404 JSON", async () => {
    const { call } = await start();
    for (const path of ["/notifications/nope", "/users/ghost/preferences", "/nothing-here"]) {
      const res = await call("GET", path);
      expect(res.status).toBe(404);
      expect((await res.json()).error.code).toBe("NOT_FOUND");
    }
  });

  it("PUT preferences for an unknown user -> 404 and nothing stored (a typo'd id would never apply)", async () => {
    const { call, preferences } = await start();
    const res = await call("PUT", "/users/ghost/preferences", { body: { mutedMarketing: ["sms"] } });
    expect(res.status).toBe(404);
    expect(preferences.get("ghost")).toEqual({ mutedMarketing: [] });
  });

  it("GET defaults; PUT replaces; the next notification follows the new preferences", async () => {
    const { call, post, worker } = await start();
    expect(await (await call("GET", "/users/u1/preferences")).json()).toEqual({ mutedMarketing: [] });
    const put = await call("PUT", "/users/u1/preferences", { body: { mutedMarketing: ["push", "sms", "email"] } });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ mutedMarketing: ["push", "sms", "email"] });
    const sale = await (await post({ typeId: "sale", userId: "u1", data: { pct: 20 } }, "s1")).json();
    expect(sale.status).toBe("suppressed");
    await worker.drain();
    expect((await (await call("GET", `/notifications/${sale.id}`)).json()).deliveries.map((d: { skipReason: string }) => d.skipReason)).toEqual([
      "opted_out",
      "opted_out",
      "opted_out",
    ]);
  });

  it("invalid preferences -> 422 and the stored ones are kept; not JSON -> 415", async () => {
    const { call } = await start();
    await call("PUT", "/users/u1/preferences", { body: { mutedMarketing: ["sms"] } });
    for (const body of [[], { mutedMarketing: ["fax"] }, { mutedMarketing: [], quietHours: null }, { mutedMarketing: [], quietHours: { start: "25:00", end: "07:00" } }]) {
      const res = await call("PUT", "/users/u1/preferences", { body });
      expect(res.status).toBe(422);
      expect((await res.json()).error.code).toBe("INVALID_PREFERENCES");
    }
    const nullBody = await call("PUT", "/users/u1/preferences", { raw: "null" }); // strict JSON: objects and arrays only
    expect([nullBody.status, (await nullBody.json()).error.code]).toEqual([400, "INVALID_JSON"]);
    const text = await call("PUT", "/users/u1/preferences", { raw: "x", headers: { "content-type": "text/plain" } });
    expect(text.status).toBe(415);
    expect(await (await call("GET", "/users/u1/preferences")).json()).toEqual({ mutedMarketing: ["sms"] });
  });
});

describe("HTTP API: POST /webhooks/:channel (delivery receipts)", () => {
  async function withSentOrder() {
    const t = await start();
    const r = t.notifier.notify(orderReq());
    await t.worker.drain();
    const [push, email] = t.notifier.get(r.id)!.deliveries;
    const hook = (channel: string, raw: string, signature?: string, contentType = "application/json") =>
      fetch(`${t.base}/webhooks/${channel}`, {
        method: "POST",
        headers: { "content-type": contentType, ...(signature !== undefined ? { "notify-signature": signature } : {}) },
        body: raw,
      });
    const signed = (channel: string, secret: string, raw: string) => hook(channel, raw, signWebhook(secret, raw, t.clock.now()));
    return { ...t, id: r.id, pushId: push!.providerId!, emailId: email!.providerId!, hook, signed };
  }
  const receipt = (providerId: string, event: string, occurredAt = 1) => JSON.stringify({ providerId, event, occurredAt });

  it("a signed receipt is applied without the API key; the record shows it; the same again is unchanged", async () => {
    const { signed, call, id, pushId } = await withSentOrder();
    const res = await signed("push", PUSH_SECRET, receipt(pushId, "delivered", 7));
    expect([res.status, await res.json()]).toEqual([200, { result: "applied" }]);
    expect((await (await call("GET", `/notifications/${id}`)).json()).deliveries[0].receipt).toEqual({ event: "delivered", at: 7 });
    const again = await signed("push", PUSH_SECRET, receipt(pushId, "delivered", 7));
    expect([again.status, await again.json()]).toEqual([200, { result: "unchanged" }]);
  });

  it("the signature is over the raw bytes: spacing and key order the provider chose are fine", async () => {
    const { signed, pushId } = await withSentOrder();
    const raw = `{ "occurredAt": 3,
  "event": "bounced", "providerId": "${pushId}" }`;
    const res = await signed("push", PUSH_SECRET, raw);
    expect([res.status, await res.json()]).toEqual([200, { result: "applied" }]);
  });

  it("no signature, a wrong one, another channel's secret, an expired one or the API key -> 401, nothing applied", async () => {
    const { hook, signed, notifier, id, pushId, clock, base } = await withSentOrder();
    const raw = receipt(pushId, "bounced");
    const old = signWebhook(PUSH_SECRET, raw, clock.now());
    clock.advance(5 * 60_000 + 1_000);
    const attempts = [
      hook("push", raw),
      hook("push", raw, signWebhook("whsec-wrong-0123456789", raw, clock.now())),
      signed("push", EMAIL_SECRET, raw),
      hook("push", raw, old), // a captured request replayed after 5 minutes
      fetch(`${base}/webhooks/push`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` }, body: raw }),
    ];
    for (const pending of attempts) {
      const res = await pending;
      expect([res.status, (await res.json()).error.code]).toEqual([401, "INVALID_SIGNATURE"]);
    }
    expect(notifier.get(id)!.deliveries[0]).not.toHaveProperty("receipt");
  });

  it("a channel without a secret, or not a channel -> 404; not JSON -> 415", async () => {
    const { hook, signed } = await withSentOrder();
    expect((await signed("sms", PUSH_SECRET, receipt("x", "delivered"))).status).toBe(404);
    expect((await signed("fax", PUSH_SECRET, receipt("x", "delivered"))).status).toBe(404);
    expect((await hook("push", "x", "t=1,v1=00", "text/plain")).status).toBe(415);
  });

  it("signed but malformed -> 400 (the signature is checked BEFORE the body is parsed)", async () => {
    const { signed, hook } = await withSentOrder();
    const cases: [string, string][] = [
      ["{", "INVALID_JSON"],
      ["[]", "INVALID_RECEIPT"],
      [receipt("", "delivered"), "INVALID_RECEIPT"],
      [receipt("p".repeat(256), "delivered"), "INVALID_RECEIPT"],
      [receipt("p1", "opened"), "INVALID_RECEIPT"],
      [JSON.stringify({ providerId: "p1", event: "delivered", occurredAt: "yesterday" }), "INVALID_RECEIPT"],
    ];
    for (const [raw, code] of cases) {
      const res = await signed("push", PUSH_SECRET, raw);
      expect([res.status, (await res.json()).error.code]).toEqual([400, code]);
    }
    expect((await hook("push", "{")).status).toBe(401); // unsigned garbage is never parsed
  });

  it("a receipt for a send not recorded yet -> 202 parked", async () => {
    const { signed } = await withSentOrder();
    const res = await signed("email", EMAIL_SECRET, receipt("not-yet", "delivered"));
    expect([res.status, await res.json()]).toEqual([202, { result: "parked" }]);
  });

  it("refuses weak or misnamed webhook secrets at startup", () => {
    const s = setupQueued();
    const base = { notifier: s.notifier, users: s.users, preferences: s.preferences, apiKey: KEY };
    expect(() => createApp({ ...base, webhookSecrets: { push: "short" } })).toThrow(RangeError);
    expect(() => createApp({ ...base, webhookSecrets: { fax: PUSH_SECRET } as never })).toThrow(RangeError);
    expect(() => createApp({ ...base, webhookSecrets: { push: "x".repeat(16) } })).not.toThrow();
  });
});
