// Login sessions and OpenID Connect RP-Initiated Logout (/logout = end_session_endpoint).
import { afterEach, describe, expect, it } from "vitest";
import { generateSigningKey, signJwt } from "../src/jwt.js";
import { authorizeParams, closeAll, decodeJwt, getCode, openLogin, pkce, postLogin, redeem, refresh, SPA_LOGGED_OUT, SPA_REDIRECT, startServer, userinfo } from "./helpers.js";
import type { TestServer } from "./helpers.js";

afterEach(closeAll);

interface Login {
  rt: string;
  at: string;
  id: string;
  sessionCookie: string;
}

async function login(s: TestServer): Promise<Login> {
  const { code, verifier, sessionCookie } = await getCode(s.base);
  const tok = await redeem(s.base, code, verifier);
  expect(tok.status).toBe(200);
  return { rt: tok.body.refresh_token as string, at: tok.body.access_token as string, id: tok.body.id_token as string, sessionCookie };
}

function logout(s: TestServer, params: Record<string, string>, cookie = ""): Promise<Response> {
  return fetch(`${s.base}/logout?${new URLSearchParams(params).toString()}`, { redirect: "manual", headers: cookie ? { cookie } : {} });
}

/** The session is over: refresh token and access token both refused. */
async function expectLoggedOut(s: TestServer, l: Login): Promise<void> {
  expect((await refresh(s.base, l.rt)).body.error).toBe("invalid_grant");
  expect((await userinfo(s.base, l.at)).status).toBe(401);
}

async function expectStillValid(s: TestServer, l: Login): Promise<void> {
  expect((await userinfo(s.base, l.at)).status).toBe(200);
}

describe("login session", () => {
  it("a successful login sets an HttpOnly SameSite=Lax session cookie; the id_token carries the session's sid", async () => {
    const s = await startServer();
    const page = await openLogin(s.base, authorizeParams(pkce().challenge));
    const r = await postLogin(s.base, page.cookie, { csrf_token: page.csrf, username: "alice", password: "alice-test-password" });
    const cookie = r.headers.getSetCookie().find((c) => c.startsWith("auth_session=")) ?? "";
    expect(cookie).toMatch(/^auth_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=43200$/);
    const l = await login(s);
    const sid = decodeJwt(l.id).payload.sid;
    expect(typeof sid).toBe("string");
    // The cookie value is a separate secret, not the (public) sid.
    expect(l.sessionCookie).not.toContain(String(sid));
  });

  it("each login gets its own sid", async () => {
    const s = await startServer();
    const a = await login(s);
    const b = await login(s);
    expect(decodeJwt(a.id).payload.sid).not.toBe(decodeJwt(b.id).payload.sid);
  });
});

describe("RP-initiated logout", () => {
  it("id_token_hint + registered post_logout_redirect_uri: redirect with state, cookie cleared, tokens of the session revoked", async () => {
    const s = await startServer();
    const l = await login(s);
    const r = await logout(s, { id_token_hint: l.id, post_logout_redirect_uri: SPA_LOGGED_OUT, state: "logout-state-1" }, l.sessionCookie);
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe(`${SPA_LOGGED_OUT}?state=logout-state-1`);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("set-cookie")).toMatch(/^auth_session=; Path=\/; HttpOnly; SameSite=Lax; Max-Age=0/);
    await expectLoggedOut(s, l);
  });

  it("without post_logout_redirect_uri: 200 'signed out' page, no redirect, same revocation", async () => {
    const s = await startServer();
    const l = await login(s);
    const r = await logout(s, { id_token_hint: l.id });
    expect(r.status).toBe(200);
    expect(r.headers.get("location")).toBeNull();
    expect(await r.text()).toContain("Signed out");
    expect(r.headers.get("set-cookie")).toContain("Max-Age=0");
    await expectLoggedOut(s, l);
  });

  it("no state parameter -> redirect without state", async () => {
    const s = await startServer();
    const l = await login(s);
    const r = await logout(s, { id_token_hint: l.id, post_logout_redirect_uri: SPA_LOGGED_OUT });
    expect(r.headers.get("location")).toBe(SPA_LOGGED_OUT);
  });

  it.each([
    ["prefix", "http://127.0.0.1:5173/logged-out/evil"],
    ["trailing slash", SPA_LOGGED_OUT + "/"],
    ["extra query", SPA_LOGGED_OUT + "?x=1"],
    ["the LOGIN redirect_uri (registered for login, not for logout)", SPA_REDIRECT],
    ["another host", "https://attacker.example.test/logged-out"],
  ])("post_logout_redirect_uri %s -> 400 page, no redirect, nothing revoked", async (_label, uri) => {
    const s = await startServer();
    const l = await login(s);
    const r = await logout(s, { id_token_hint: l.id, post_logout_redirect_uri: uri, state: "x" });
    expect(r.status).toBe(400);
    expect(r.headers.get("location")).toBeNull();
    expect(r.headers.get("set-cookie")).toBeNull();
    await expectStillValid(s, l);
  });

  it("missing id_token_hint -> 400 (no confirmation page, so a plain link cannot log the user out)", async () => {
    const s = await startServer();
    const l = await login(s);
    const r = await logout(s, { post_logout_redirect_uri: SPA_LOGGED_OUT }, l.sessionCookie);
    expect(r.status).toBe(400);
    expect(r.headers.get("location")).toBeNull();
    await expectStillValid(s, l);
  });

  it("an id_token_hint with a tampered signature -> 400, nothing revoked", async () => {
    const s = await startServer();
    const l = await login(s);
    const parts = l.id.split(".");
    const payload = { ...decodeJwt(l.id).payload, sub: "user-0002" };
    const forged = `${parts[0]}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${parts[2]}`;
    const r = await logout(s, { id_token_hint: forged });
    expect(r.status).toBe(400);
    expect(await r.text()).toContain("bad signature");
    await expectStillValid(s, l);
  });

  it("an id_token_hint signed by a key this server does not publish -> 400", async () => {
    const s = await startServer();
    const l = await login(s);
    const other = generateSigningKey();
    const fake = signJwt({ ...other, kid: s.keys[0]?.kid ?? "" }, "JWT", decodeJwt(l.id).payload);
    expect((await logout(s, { id_token_hint: fake })).status).toBe(400);
    await expectStillValid(s, l);
  });

  it("an access token is not an id_token_hint (typ at+jwt, aud is not a client) -> 400", async () => {
    const s = await startServer();
    const l = await login(s);
    expect((await logout(s, { id_token_hint: l.at })).status).toBe(400);
    await expectStillValid(s, l);
  });

  it("an EXPIRED id_token is still accepted as a hint (signature, iss, aud still checked)", async () => {
    const s = await startServer();
    const l = await login(s);
    s.clock.t += 3600 * 1000; // id_token (300 s) long expired; refresh token (14 days) still valid
    const r = await logout(s, { id_token_hint: l.id, post_logout_redirect_uri: SPA_LOGGED_OUT });
    expect(r.status).toBe(302);
    expect((await refresh(s.base, l.rt)).body.error).toBe("invalid_grant");
  });

  it("client_id that differs from the id_token's aud -> 400", async () => {
    const s = await startServer();
    const l = await login(s);
    expect((await logout(s, { id_token_hint: l.id, client_id: "other-spa" })).status).toBe(400);
    expect((await logout(s, { id_token_hint: l.id, client_id: "spa" })).status).toBe(200);
  });

  it("only the families of THAT session are revoked; another login of the same user is untouched", async () => {
    const s = await startServer();
    const a = await login(s);
    const b = await login(s);
    expect((await logout(s, { id_token_hint: a.id })).status).toBe(200);
    await expectLoggedOut(s, a);
    await expectStillValid(s, b);
    expect((await refresh(s.base, b.rt)).status).toBe(200);
  });

  it("the browser's session cookie is ended too when it belongs to the same user", async () => {
    const s = await startServer();
    const a = await login(s);
    const b = await login(s); // the browser now holds b's cookie
    expect((await logout(s, { id_token_hint: a.id }, b.sessionCookie)).status).toBe(200);
    await expectLoggedOut(s, a);
    await expectLoggedOut(s, b);
  });

  it("a session cookie of ANOTHER user is not ended by this user's id_token", async () => {
    const s = await startServer();
    const a = await login(s);
    // bob logs in in "this browser"
    const { verifier, challenge } = pkce();
    const page = await openLogin(s.base, authorizeParams(challenge));
    const r = await postLogin(s.base, page.cookie, { csrf_token: page.csrf, username: "bob", password: "bob-test-password" });
    const bobCookie = r.headers.getSetCookie().find((c) => c.startsWith("auth_session="))?.split(";")[0] ?? "";
    const bobTok = await redeem(s.base, new URL(r.headers.get("location") ?? "").searchParams.get("code") ?? "", verifier);
    expect(bobTok.status).toBe(200);
    expect((await logout(s, { id_token_hint: a.id }, bobCookie)).status).toBe(200);
    await expectLoggedOut(s, a);
    expect((await refresh(s.base, bobTok.body.refresh_token as string)).status).toBe(200);
  });

  it("a second logout with the same hint is harmless (200, still logged out)", async () => {
    const s = await startServer();
    const l = await login(s);
    expect((await logout(s, { id_token_hint: l.id })).status).toBe(200);
    expect((await logout(s, { id_token_hint: l.id })).status).toBe(200);
    await expectLoggedOut(s, l);
  });

  it("POST form works the same way", async () => {
    const s = await startServer();
    const l = await login(s);
    const r = await fetch(`${s.base}/logout`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ id_token_hint: l.id, post_logout_redirect_uri: SPA_LOGGED_OUT, state: "p" }).toString(),
    });
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe(`${SPA_LOGGED_OUT}?state=p`);
    await expectLoggedOut(s, l);
  });

  it("a repeated parameter -> 400", async () => {
    const s = await startServer();
    const l = await login(s);
    const r = await fetch(`${s.base}/logout?id_token_hint=${l.id}&state=a&state=b`, { redirect: "manual" });
    expect(r.status).toBe(400);
    await expectStillValid(s, l);
  });

  it("the id_token from a REFRESH also names the session and logs it out", async () => {
    const s = await startServer();
    const l = await login(s);
    const r = await refresh(s.base, l.rt);
    expect(decodeJwt(r.body.id_token as string).payload.sid).toBe(decodeJwt(l.id).payload.sid);
    expect((await logout(s, { id_token_hint: r.body.id_token as string })).status).toBe(200);
    expect((await refresh(s.base, r.body.refresh_token as string)).body.error).toBe("invalid_grant");
  });
});
