// The HTTP API against a real Express server on a random port, called with Node's fetch -- same pattern as
// 21-notification's http.test.ts.
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, type AppOptions } from "../src/http/app.js";
import { BreachChecker, FakeBreachProvider, ManualClock, PasswordManager } from "../src/index.js";

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

function start(overrides: Partial<AppOptions> = {}) {
  const manager = overrides.manager ?? new PasswordManager();
  const logged: unknown[] = [];
  return listen(createApp({ manager, apiKey: KEY, log: (_m, e) => logged.push(e), ...overrides })).then((base) => ({
    base,
    manager,
    logged,
  }));
}

function authed(extra: HeadersInit = {}): HeadersInit {
  return { authorization: `Bearer ${KEY}`, "content-type": "application/json", ...extra };
}

async function createAndUnlock(base: string, ownerId: string, password: string): Promise<string> {
  await fetch(`${base}/vaults`, { method: "POST", headers: authed(), body: JSON.stringify({ ownerId, masterPassword: password }) });
  const res = await fetch(`${base}/vaults/${ownerId}/unlock`, { method: "POST", headers: authed(), body: JSON.stringify({ masterPassword: password }) });
  return ((await res.json()) as { sessionId: string }).sessionId;
}

describe("auth", () => {
  it("rejects a request with no API key, or the wrong one, before the body is even looked at", async () => {
    const { base } = await start();
    const noKey = await fetch(`${base}/vaults`, { method: "POST", headers: { "content-type": "application/json" }, body: "not even valid json" });
    expect(noKey.status).toBe(401);
    expect((await noKey.json()) as { error: { code: string } }).toMatchObject({ error: { code: "UNAUTHORIZED" } });

    const wrongKey = await fetch(`${base}/vaults`, { method: "POST", headers: authed({ authorization: "Bearer wrong-key-entirely" }) });
    expect(wrongKey.status).toBe(401);
  });

  it("createApp refuses to start with too short an API key", () => {
    expect(() => createApp({ manager: new PasswordManager(), apiKey: "short" })).toThrow(RangeError);
  });
});

describe("vaults", () => {
  it("POST /vaults creates a vault; GET /vaults/:ownerId reads its summary", async () => {
    const { base } = await start();
    const created = await fetch(`${base}/vaults`, { method: "POST", headers: authed(), body: JSON.stringify({ ownerId: "alice", masterPassword: "correct-horse-battery" }) });
    expect(created.status).toBe(201);
    expect(created.headers.get("location")).toBe("/vaults/alice");
    expect(await created.json()).toMatchObject({ ownerId: "alice", activeSessions: 0, entryCount: 0 });

    const read = await fetch(`${base}/vaults/alice`, { headers: authed() });
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ ownerId: "alice", entryCount: 0 });
  });

  it("a second create for the same ownerId is a 409; a missing field is a 400 from the library's own validation", async () => {
    const { base } = await start();
    await fetch(`${base}/vaults`, { method: "POST", headers: authed(), body: JSON.stringify({ ownerId: "alice", masterPassword: "correct-horse-battery" }) });

    const dup = await fetch(`${base}/vaults`, { method: "POST", headers: authed(), body: JSON.stringify({ ownerId: "alice", masterPassword: "correct-horse-battery" }) });
    expect(dup.status).toBe(409);
    expect((await dup.json()) as { error: { code: string } }).toMatchObject({ error: { code: "VAULT_ALREADY_EXISTS" } });

    const missing = await fetch(`${base}/vaults`, { method: "POST", headers: authed(), body: JSON.stringify({ ownerId: "bob" }) });
    expect(missing.status).toBe(400);
    expect((await missing.json()) as { error: { code: string } }).toMatchObject({ error: { code: "INVALID_REQUEST" } });
  });

  it("an unknown ownerId is a 404", async () => {
    const { base } = await start();
    const res = await fetch(`${base}/vaults/ghost`, { headers: authed() });
    expect(res.status).toBe(404);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({ error: { code: "UNKNOWN_OWNER" } });
  });

  it("unlock: correct password returns a sessionId; wrong password is 401; 5 wrong attempts lock out (423)", async () => {
    const { base } = await start();
    await fetch(`${base}/vaults`, { method: "POST", headers: authed(), body: JSON.stringify({ ownerId: "alice", masterPassword: "correct-horse-battery" }) });

    const ok = await fetch(`${base}/vaults/alice/unlock`, { method: "POST", headers: authed(), body: JSON.stringify({ masterPassword: "correct-horse-battery" }) });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ activeSessions: 1 });

    for (let i = 0; i < 4; i++) {
      await fetch(`${base}/vaults/alice/unlock`, { method: "POST", headers: authed(), body: JSON.stringify({ masterPassword: "totally-wrong-password" }) });
    }
    const fifthWrong = await fetch(`${base}/vaults/alice/unlock`, { method: "POST", headers: authed(), body: JSON.stringify({ masterPassword: "totally-wrong-password" }) });
    expect(fifthWrong.status).toBe(401);
    const lockedOut = await fetch(`${base}/vaults/alice/unlock`, { method: "POST", headers: authed(), body: JSON.stringify({ masterPassword: "correct-horse-battery" }) });
    expect(lockedOut.status).toBe(423);
    expect((await lockedOut.json()) as { error: { code: string } }).toMatchObject({ error: { code: "LOCKED_OUT" } });
  });

  it("rotate (changeMasterPassword) and export both work over HTTP, and export never leaks plaintext", async () => {
    const { base } = await start();
    const sessionId = await createAndUnlock(base, "alice", "correct-horse-battery");
    await fetch(`${base}/sessions/${sessionId}/entries`, { method: "POST", headers: authed(), body: JSON.stringify({ title: "x", username: "a", password: "s3cret" }) });

    const rotate = await fetch(`${base}/vaults/alice/rotate`, { method: "POST", headers: authed(), body: JSON.stringify({ oldPassword: "correct-horse-battery", newPassword: "a-new-master-password" }) });
    expect(rotate.status).toBe(204);

    const oldStillWorks = await fetch(`${base}/vaults/alice/unlock`, { method: "POST", headers: authed(), body: JSON.stringify({ masterPassword: "correct-horse-battery" }) });
    expect(oldStillWorks.status).toBe(401);

    const exported = await fetch(`${base}/vaults/alice/export`, { headers: authed() });
    expect(exported.status).toBe(200);
    const dump = JSON.stringify(await exported.json());
    expect(dump).not.toContain("s3cret");
  });
});

describe("sessions and entries", () => {
  it("full CRUD over HTTP: add, list, get, patch, delete", async () => {
    const { base } = await start();
    const sessionId = await createAndUnlock(base, "alice", "correct-horse-battery");

    const added = await fetch(`${base}/sessions/${sessionId}/entries`, { method: "POST", headers: authed(), body: JSON.stringify({ title: "GitHub", username: "alice", password: "pw1" }) });
    expect(added.status).toBe(201);
    const entry = (await added.json()) as { id: string };
    expect(added.headers.get("location")).toBe(`/sessions/${sessionId}/entries/${entry.id}`);

    const listed = await fetch(`${base}/sessions/${sessionId}/entries`, { headers: authed() });
    expect(await listed.json()).toHaveLength(1);

    const got = await fetch(`${base}/sessions/${sessionId}/entries/${entry.id}`, { headers: authed() });
    expect(await got.json()).toMatchObject({ password: "pw1" });

    const patched = await fetch(`${base}/sessions/${sessionId}/entries/${entry.id}`, { method: "PATCH", headers: authed(), body: JSON.stringify({ password: "pw2" }) });
    expect(patched.status).toBe(200);
    expect(await patched.json()).toMatchObject({ id: entry.id });
    const afterPatch = await fetch(`${base}/sessions/${sessionId}/entries/${entry.id}`, { headers: authed() });
    expect((await afterPatch.json() as { password: string }).password).toBe("pw2");

    const deleted = await fetch(`${base}/sessions/${sessionId}/entries/${entry.id}`, { method: "DELETE", headers: authed() });
    expect(deleted.status).toBe(204);
    const afterDelete = await fetch(`${base}/sessions/${sessionId}/entries/${entry.id}`, { headers: authed() });
    expect(afterDelete.status).toBe(404);
  });

  it("lock and session status round-trip over HTTP", async () => {
    const { base } = await start();
    const sessionId = await createAndUnlock(base, "alice", "correct-horse-battery");

    const active = await fetch(`${base}/sessions/${sessionId}`, { headers: authed() });
    expect(await active.json()).toEqual({ active: true });

    const locked = await fetch(`${base}/sessions/${sessionId}/lock`, { method: "POST", headers: authed() });
    expect(locked.status).toBe(204);

    const inactive = await fetch(`${base}/sessions/${sessionId}`, { headers: authed() });
    expect(await inactive.json()).toEqual({ active: false });

    const useAfterLock = await fetch(`${base}/sessions/${sessionId}/entries`, { headers: authed() });
    expect(useAfterLock.status).toBe(401);
  });
});

describe("sharing", () => {
  it("full share/redeem/revoke flow between two sessions over HTTP", async () => {
    const { base } = await start();
    const alice = await createAndUnlock(base, "alice", "alice-master-password");
    const bob = await createAndUnlock(base, "bob", "bob-master-password-123");

    const entryRes = await fetch(`${base}/sessions/${alice}/entries`, { method: "POST", headers: authed(), body: JSON.stringify({ title: "x", username: "a", password: "p" }) });
    const entry = (await entryRes.json()) as { id: string };

    const keyRes = await fetch(`${base}/sessions/${bob}/sharing-key`, { headers: authed() });
    expect(keyRes.status).toBe(200);
    const { publicKey } = (await keyRes.json()) as { publicKey: string };

    const shareRes = await fetch(`${base}/sessions/${alice}/entries/${entry.id}/share`, { method: "POST", headers: authed(), body: JSON.stringify({ recipientPublicKey: publicKey }) });
    expect(shareRes.status).toBe(201);
    const token = await shareRes.json();

    const redeemRes = await fetch(`${base}/sessions/${bob}/shares/redeem`, { method: "POST", headers: authed(), body: JSON.stringify(token) });
    expect(redeemRes.status).toBe(201);

    const redeemAgain = await fetch(`${base}/sessions/${bob}/shares/redeem`, { method: "POST", headers: authed(), body: JSON.stringify(token) });
    expect(redeemAgain.status).toBe(409);
    expect((await redeemAgain.json()) as { error: { code: string } }).toMatchObject({ error: { code: "SHARE_ALREADY_REDEEMED" } });

    // a second, fresh share -- revoked before bob redeems it
    const shareRes2 = await fetch(`${base}/sessions/${alice}/entries/${entry.id}/share`, { method: "POST", headers: authed(), body: JSON.stringify({ recipientPublicKey: publicKey }) });
    const token2 = (await shareRes2.json()) as { shareId: string };
    const revokeRes = await fetch(`${base}/sessions/${alice}/shares/${token2.shareId}/revoke`, { method: "POST", headers: authed() });
    expect(revokeRes.status).toBe(204);
    const redeemRevoked = await fetch(`${base}/sessions/${bob}/shares/redeem`, { method: "POST", headers: authed(), body: JSON.stringify(token2) });
    expect(redeemRevoked.status).toBe(410);
    expect((await redeemRevoked.json()) as { error: { code: string } }).toMatchObject({ error: { code: "SHARE_REVOKED" } });
  });

  it("a malformed redeem body (not a real share token) is a 400, not an unhandled crash", async () => {
    const { base } = await start();
    const bob = await createAndUnlock(base, "bob", "bob-master-password-123");
    await fetch(`${base}/sessions/${bob}/sharing-key`, { headers: authed() });
    const res = await fetch(`${base}/sessions/${bob}/shares/redeem`, { method: "POST", headers: authed(), body: JSON.stringify({ not: "a token" }) });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({ error: { code: "INVALID_REQUEST" } });
  });
});

describe("breach-check", () => {
  it("POST /breach-check reports known-breached vs clean passwords", async () => {
    const manager = new PasswordManager({ breachChecker: new BreachChecker({ provider: new FakeBreachProvider(["weak-password"]) }) });
    const { base } = await start({ manager });

    const weak = await fetch(`${base}/breach-check`, { method: "POST", headers: authed(), body: JSON.stringify({ password: "weak-password" }) });
    expect(await weak.json()).toEqual({ breached: true });

    const strong = await fetch(`${base}/breach-check`, { method: "POST", headers: authed(), body: JSON.stringify({ password: "a-totally-different-password" }) });
    expect(await strong.json()).toEqual({ breached: false });
  });
});

describe("idle timeout over HTTP", () => {
  it("an idle session reports inactive and then 401s on use", async () => {
    const clock = new ManualClock(Date.now());
    const manager = new PasswordManager({ clock, sessionIdleTimeoutMs: 1_000 });
    const { base } = await start({ manager });
    const sessionId = await createAndUnlock(base, "alice", "correct-horse-battery");

    clock.advance(1_001);
    const status = await fetch(`${base}/sessions/${sessionId}`, { headers: authed() });
    expect(await status.json()).toEqual({ active: false });

    const use = await fetch(`${base}/sessions/${sessionId}/entries`, { headers: authed() });
    expect(use.status).toBe(401);
    expect((await use.json()) as { error: { code: string } }).toMatchObject({ error: { code: "SESSION_IDLE_TIMEOUT" } });
  });
});

describe("HTTP-layer error handling", () => {
  it("an unknown route is a 404 NOT_FOUND", async () => {
    const { base } = await start();
    const res = await fetch(`${base}/not-a-real-route`, { headers: authed() });
    expect(res.status).toBe(404);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({ error: { code: "NOT_FOUND" } });
  });

  it("a non-JSON Content-Type on a route that requires one is 415", async () => {
    const { base } = await start();
    const res = await fetch(`${base}/vaults`, { method: "POST", headers: authed({ "content-type": "text/plain" }), body: "ownerId=alice" });
    expect(res.status).toBe(415);
  });

  it("malformed JSON is a 400 INVALID_JSON", async () => {
    const { base } = await start();
    const res = await fetch(`${base}/vaults`, { method: "POST", headers: authed(), body: "{not valid json" });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({ error: { code: "INVALID_JSON" } });
  });

  it("a body over the configured limit is a 413", async () => {
    const { base } = await start({ bodyLimit: "10b" });
    const res = await fetch(`${base}/vaults`, { method: "POST", headers: authed(), body: JSON.stringify({ ownerId: "alice", masterPassword: "correct-horse-battery" }) });
    expect(res.status).toBe(413);
  });

  it("an unexpected (non-library) error maps to 500 and is logged, not leaked to the caller", async () => {
    const manager = new PasswordManager();
    // Force a genuine bug: monkey-patch a method to throw a plain Error, not a PasswordManagerError.
    manager.getVault = () => {
      throw new Error("boom: something truly unexpected");
    };
    const { base, logged } = await start({ manager });
    const res = await fetch(`${base}/vaults/alice`, { headers: authed() });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("INTERNAL");
    expect(body.error.message).not.toContain("boom"); // the real message is logged, not sent to the caller
    expect(logged).toHaveLength(1);
  });
});
