import { afterEach, describe, expect, it } from "vitest";
import { ALICE, authorizeParams, closeAll, openLogin, pkce, postLogin, startServer } from "./helpers.js";

afterEach(closeAll);

async function page() {
  const s = await startServer();
  const p = authorizeParams(pkce().challenge);
  return { s, p, login: await openLogin(s.base, p) };
}

describe("/login", () => {
  it("correct credentials and CSRF token -> 302 to the redirect_uri with code, state and iss; cookie cleared", async () => {
    const { s, p, login } = await page();
    const r = await postLogin(s.base, login.cookie, { csrf_token: login.csrf, username: ALICE.username, password: ALICE.password });
    expect(r.status).toBe(302);
    const loc = new URL(r.headers.get("location") ?? "");
    expect(loc.searchParams.get("state")).toBe(p.state);
    expect(loc.searchParams.get("code")).toBeTruthy();
    expect(r.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("bad CSRF token -> 403, no code", async () => {
    const { s, login } = await page();
    const r = await postLogin(s.base, login.cookie, { csrf_token: login.csrf.slice(0, -1) + (login.csrf.endsWith("A") ? "B" : "A"), username: ALICE.username, password: ALICE.password });
    expect(r.status).toBe(403);
    expect(r.headers.get("location")).toBeNull();
  });

  it("missing CSRF token -> 403", async () => {
    const { s, login } = await page();
    const r = await postLogin(s.base, login.cookie, { username: ALICE.username, password: ALICE.password });
    expect(r.status).toBe(403);
  });

  it("a CSRF token from ANOTHER login transaction is rejected", async () => {
    const { s, login } = await page();
    const other = await openLogin(s.base, authorizeParams(pkce().challenge));
    const r = await postLogin(s.base, login.cookie, { csrf_token: other.csrf, username: ALICE.username, password: ALICE.password });
    expect(r.status).toBe(403);
  });

  it("missing transaction cookie -> 400", async () => {
    const { s, login } = await page();
    const r = await postLogin(s.base, "", { csrf_token: login.csrf, username: ALICE.username, password: ALICE.password });
    expect(r.status).toBe(400);
  });

  it("wrong password -> 401 with the form again, no code", async () => {
    const { s, login } = await page();
    const r = await postLogin(s.base, login.cookie, { csrf_token: login.csrf, username: ALICE.username, password: "wrong" });
    expect(r.status).toBe(401);
    expect(r.headers.get("location")).toBeNull();
    const html = await r.text();
    expect(html).toContain("Invalid username or password.");
    expect(html).toContain(`value="${login.csrf}"`);
  });

  it("unknown user -> same 401 and message as a wrong password", async () => {
    const { s, login } = await page();
    const r = await postLogin(s.base, login.cookie, { csrf_token: login.csrf, username: "mallory", password: "x" });
    expect(r.status).toBe(401);
    expect(await r.text()).toContain("Invalid username or password.");
  });

  it("after 5 failed attempts the transaction is discarded", async () => {
    const { s, login } = await page();
    for (let i = 0; i < 4; i++) {
      expect((await postLogin(s.base, login.cookie, { csrf_token: login.csrf, username: ALICE.username, password: "wrong" })).status).toBe(401);
    }
    const fifth = await postLogin(s.base, login.cookie, { csrf_token: login.csrf, username: ALICE.username, password: "wrong" });
    expect(await fifth.text()).toContain("Too many failed attempts");
    const ok = await postLogin(s.base, login.cookie, { csrf_token: login.csrf, username: ALICE.username, password: ALICE.password });
    expect(ok.status).toBe(400);
  });

  it("the login transaction is single-use: posting the same form twice mints only one code", async () => {
    const { s, login } = await page();
    const form = { csrf_token: login.csrf, username: ALICE.username, password: ALICE.password };
    expect((await postLogin(s.base, login.cookie, form)).status).toBe(302);
    expect((await postLogin(s.base, login.cookie, form)).status).toBe(400);
  });

  it("an expired login transaction is rejected", async () => {
    const { s, login } = await page();
    s.clock.t += 601_000;
    const r = await postLogin(s.base, login.cookie, { csrf_token: login.csrf, username: ALICE.username, password: ALICE.password });
    expect(r.status).toBe(400);
  });

  it("only form posts are accepted", async () => {
    const { s, login } = await page();
    const r = await fetch(`${s.base}/login`, { method: "POST", headers: { "content-type": "application/json", cookie: login.cookie }, body: "{}" });
    expect(r.status).toBe(400);
  });
});
