import { afterEach, describe, expect, it } from "vitest";
import { authorizeParams, closeAll, openLogin, pkce, SPA_REDIRECT, startServer } from "./helpers.js";

afterEach(closeAll);

async function authorize(base: string, params: Record<string, string> | string): Promise<Response> {
  const qs = typeof params === "string" ? params : new URLSearchParams(params).toString();
  return fetch(`${base}/authorize?${qs}`, { redirect: "manual" });
}

function without(p: Record<string, string>, ...names: string[]): Record<string, string> {
  const out = { ...p };
  for (const n of names) delete out[n];
  return out;
}

describe("/authorize: client and redirect_uri (never redirect to an unverified URI)", () => {
  it("unknown client_id -> 400 page, no redirect", async () => {
    const s = await startServer();
    const r = await authorize(s.base, authorizeParams(pkce().challenge, { client_id: "nope" }));
    expect(r.status).toBe(400);
    expect(r.headers.get("location")).toBeNull();
  });

  it.each([
    ["missing", undefined],
    ["prefix match (extra path)", `${SPA_REDIRECT}/evil`],
    ["trailing slash", `${SPA_REDIRECT}/`],
    ["extra query parameter", `${SPA_REDIRECT}?next=x`],
    ["different port", "http://127.0.0.1:5999/callback"],
    ["different case in path", "http://127.0.0.1:5173/Callback"],
    ["registered for another client", "http://127.0.0.1:5174/callback"],
    ["different host", "http://localhost:5173/callback"],
  ])("redirect_uri %s -> 400 page, no redirect", async (_label, uri) => {
    const s = await startServer();
    const p = authorizeParams(pkce().challenge);
    const params = uri === undefined ? without(p, "redirect_uri") : { ...p, redirect_uri: uri };
    const r = await authorize(s.base, params);
    expect(r.status).toBe(400);
    expect(r.headers.get("location")).toBeNull();
    expect(r.headers.get("set-cookie")).toBeNull();
  });
});

describe("/authorize: errors are redirected to the registered URI with state", () => {
  async function expectRedirectError(params: Record<string, string> | string, error: string, state?: string): Promise<URL> {
    const s = await startServer();
    const r = await authorize(s.base, params);
    expect(r.status).toBe(302);
    expect(r.headers.get("set-cookie")).toBeNull();
    const loc = new URL(r.headers.get("location") ?? "");
    expect(`${loc.origin}${loc.pathname}`).toBe(SPA_REDIRECT);
    expect(loc.searchParams.get("error")).toBe(error);
    expect(loc.searchParams.get("error_description")).toBeTruthy();
    expect(loc.searchParams.get("code")).toBeNull();
    if (state !== undefined) expect(loc.searchParams.get("state")).toBe(state);
    expect(loc.searchParams.get("iss")).toBe(s.base);
    return loc;
  }

  it("missing PKCE (no code_challenge) -> invalid_request", async () => {
    const p = authorizeParams(pkce().challenge);
    await expectRedirectError(without(p, "code_challenge", "code_challenge_method"), "invalid_request", p.state);
  });

  it("code_challenge_method=plain -> invalid_request", async () => {
    const { verifier } = pkce();
    const p = authorizeParams(verifier, { code_challenge_method: "plain" });
    await expectRedirectError(p, "invalid_request", p.state);
  });

  it("code_challenge without a method (defaults to plain per RFC 7636) -> invalid_request", async () => {
    const p = authorizeParams(pkce().challenge);
    await expectRedirectError(without(p, "code_challenge_method"), "invalid_request", p.state);
  });

  it("malformed S256 challenge -> invalid_request", async () => {
    const p = authorizeParams("too-short", {});
    await expectRedirectError(p, "invalid_request", p.state);
  });

  it("response_type=token -> unsupported_response_type", async () => {
    const p = authorizeParams(pkce().challenge, { response_type: "token" });
    await expectRedirectError(p, "unsupported_response_type", p.state);
  });

  it("missing response_type -> invalid_request", async () => {
    const p = authorizeParams(pkce().challenge);
    await expectRedirectError(without(p, "response_type"), "invalid_request", p.state);
  });

  it("scope not allowed for the client -> invalid_scope", async () => {
    const p = authorizeParams(pkce().challenge, { scope: "openid admin" });
    await expectRedirectError(p, "invalid_scope", p.state);
  });

  it("empty scope -> invalid_scope", async () => {
    const p = authorizeParams(pkce().challenge, { scope: "" });
    await expectRedirectError(p, "invalid_scope", p.state);
  });

  it("repeated parameter -> invalid_request", async () => {
    const p = authorizeParams(pkce().challenge);
    const qs = new URLSearchParams(p).toString() + "&scope=openid";
    await expectRedirectError(qs, "invalid_request", p.state);
  });

  it("prompt=none -> login_required (there are no login sessions)", async () => {
    const p = authorizeParams(pkce().challenge, { prompt: "none" });
    await expectRedirectError(p, "login_required", p.state);
  });

  it("response_mode=fragment -> invalid_request", async () => {
    const p = authorizeParams(pkce().challenge, { response_mode: "fragment" });
    await expectRedirectError(p, "invalid_request", p.state);
  });

  it("an error without state carries no state", async () => {
    const p = without(authorizeParams(pkce().challenge, { response_type: "token" }), "state");
    const loc = await expectRedirectError(p, "unsupported_response_type");
    expect(loc.searchParams.has("state")).toBe(false);
  });
});

describe("/authorize: a valid request shows the login form", () => {
  it("sets an HttpOnly SameSite cookie, embeds a CSRF token, is not cacheable or frameable", async () => {
    const s = await startServer();
    const r = await authorize(s.base, authorizeParams(pkce().challenge));
    expect(r.status).toBe(200);
    const cookie = r.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/^auth_tx=[A-Za-z0-9_-]{43};/);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("x-frame-options")).toBe("DENY");
    expect(r.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    const html = await r.text();
    expect(html).toMatch(/name="csrf_token" value="[A-Za-z0-9_-]{43}"/);
  });

  it("the CSRF token differs for every login transaction", async () => {
    const s = await startServer();
    const a = await openLogin(s.base, authorizeParams(pkce().challenge));
    const b = await openLogin(s.base, authorizeParams(pkce().challenge));
    expect(a.csrf).not.toBe(b.csrf);
    expect(a.cookie).not.toBe(b.cookie);
  });

  it("only GET is allowed", async () => {
    const s = await startServer();
    const r = await fetch(`${s.base}/authorize`, { method: "POST" });
    expect(r.status).toBe(405);
    expect(r.headers.get("allow")).toBe("GET");
  });
});
