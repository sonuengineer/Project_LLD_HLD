import { afterEach, describe, expect, it } from "vitest";
import { basic, closeAll, getCode, pkce, postForm, redeem, startServer, userinfo, WEB_REDIRECT, WEB_SECRET } from "./helpers.js";

afterEach(closeAll);

function expectOAuthError(r: { status: number; headers: Headers; body: Record<string, unknown> }, status: number, error: string): void {
  expect(r.status).toBe(status);
  expect(r.body.error).toBe(error);
  expect(typeof r.body.error_description).toBe("string");
  expect(r.headers.get("cache-control")).toBe("no-store");
  expect(r.headers.get("content-type")).toBe("application/json");
}

describe("/token authorization_code grant: PKCE", () => {
  it("wrong code_verifier -> invalid_grant", async () => {
    const s = await startServer();
    const { code } = await getCode(s.base);
    expectOAuthError(await redeem(s.base, code, pkce().verifier), 400, "invalid_grant");
  });

  it("missing code_verifier -> invalid_request", async () => {
    const s = await startServer();
    const { code } = await getCode(s.base);
    expectOAuthError(await postForm(s.base, "/token", { grant_type: "authorization_code", code, redirect_uri: "http://127.0.0.1:5173/callback", client_id: "spa" }), 400, "invalid_request");
  });

  it("the challenge itself sent as verifier (plain-style) -> invalid_grant", async () => {
    const s = await startServer();
    const { code, params } = await getCode(s.base);
    expectOAuthError(await redeem(s.base, code, params.code_challenge ?? ""), 400, "invalid_grant");
  });
});

describe("/token authorization_code grant: code rules", () => {
  it("a reused code fails AND revokes the tokens issued from it", async () => {
    const s = await startServer();
    const { code, verifier } = await getCode(s.base);
    const first = await redeem(s.base, code, verifier);
    expect(first.status).toBe(200);
    expect((await userinfo(s.base, first.body.access_token as string)).status).toBe(200);

    expectOAuthError(await redeem(s.base, code, verifier), 400, "invalid_grant");

    expect((await userinfo(s.base, first.body.access_token as string)).status).toBe(401);
    const r = await postForm(s.base, "/token", { grant_type: "refresh_token", refresh_token: first.body.refresh_token as string, client_id: "spa" });
    expectOAuthError(r, 400, "invalid_grant");
  });

  it("the code is burned by its first presentation, even a failed one", async () => {
    const s = await startServer();
    const { code, verifier } = await getCode(s.base);
    expect((await redeem(s.base, code, pkce().verifier)).status).toBe(400);
    expectOAuthError(await redeem(s.base, code, verifier), 400, "invalid_grant");
  });

  it("an expired code (older than 60 s) -> invalid_grant", async () => {
    const s = await startServer();
    const { code, verifier } = await getCode(s.base);
    s.clock.t += 60_000;
    expectOAuthError(await redeem(s.base, code, verifier), 400, "invalid_grant");
  });

  it("a code just inside its lifetime still works", async () => {
    const s = await startServer();
    const { code, verifier } = await getCode(s.base);
    s.clock.t += 59_000;
    expect((await redeem(s.base, code, verifier)).status).toBe(200);
  });

  it("an unknown code -> invalid_grant", async () => {
    const s = await startServer();
    expectOAuthError(await redeem(s.base, "not-a-real-code", pkce().verifier), 400, "invalid_grant");
  });

  it("redirect_uri different from the authorization request -> invalid_grant", async () => {
    const s = await startServer();
    const { code, verifier } = await getCode(s.base);
    expectOAuthError(await redeem(s.base, code, verifier, { redirect_uri: "http://127.0.0.1:5173/callback/" }), 400, "invalid_grant");
  });

  it("a code issued to another client -> invalid_grant", async () => {
    const s = await startServer();
    const { code, verifier } = await getCode(s.base);
    expectOAuthError(await redeem(s.base, code, verifier, { client_id: "other-spa" }), 400, "invalid_grant");
  });
});

describe("/token client authentication", () => {
  it("wrong client secret -> 401 invalid_client with WWW-Authenticate", async () => {
    const s = await startServer();
    const { code, verifier } = await getCode(s.base, { client_id: "web", redirect_uri: WEB_REDIRECT });
    const r = await postForm(s.base, "/token", { grant_type: "authorization_code", code, redirect_uri: WEB_REDIRECT, code_verifier: verifier }, basic("web", WEB_SECRET + "x"));
    expectOAuthError(r, 401, "invalid_client");
    expect(r.headers.get("www-authenticate")).toContain("Basic");
    // The failed authentication did not burn the code (it never reached the grant).
    const ok = await postForm(s.base, "/token", { grant_type: "authorization_code", code, redirect_uri: WEB_REDIRECT, code_verifier: verifier }, basic("web", WEB_SECRET));
    expect(ok.status).toBe(200);
  });

  it("confidential client without credentials -> 401 invalid_client", async () => {
    const s = await startServer();
    const { code, verifier } = await getCode(s.base, { client_id: "web", redirect_uri: WEB_REDIRECT });
    expectOAuthError(await postForm(s.base, "/token", { grant_type: "authorization_code", code, redirect_uri: WEB_REDIRECT, code_verifier: verifier, client_id: "web" }), 401, "invalid_client");
  });

  it("client_secret in the body (client_secret_post) is refused", async () => {
    const s = await startServer();
    expectOAuthError(await postForm(s.base, "/token", { grant_type: "authorization_code", code: "x", redirect_uri: WEB_REDIRECT, code_verifier: pkce().verifier, client_id: "web", client_secret: WEB_SECRET }), 401, "invalid_client");
  });

  it("Basic credentials for a PUBLIC client are refused", async () => {
    const s = await startServer();
    expectOAuthError(await postForm(s.base, "/token", { grant_type: "authorization_code", code: "x", redirect_uri: "x", code_verifier: pkce().verifier }, basic("spa", "anything")), 401, "invalid_client");
  });

  it("unknown client -> 401 invalid_client", async () => {
    const s = await startServer();
    expectOAuthError(await postForm(s.base, "/token", { grant_type: "authorization_code", client_id: "ghost" }), 401, "invalid_client");
  });

  it("body client_id that contradicts the Basic credentials -> invalid_request", async () => {
    const s = await startServer();
    expectOAuthError(await postForm(s.base, "/token", { grant_type: "authorization_code", client_id: "spa" }, basic("web", WEB_SECRET)), 400, "invalid_request");
  });
});

describe("/token request format", () => {
  it("unsupported grant_type -> unsupported_grant_type", async () => {
    const s = await startServer();
    expectOAuthError(await postForm(s.base, "/token", { grant_type: "password", client_id: "spa" }), 400, "unsupported_grant_type");
  });

  it("missing grant_type -> invalid_request", async () => {
    const s = await startServer();
    expectOAuthError(await postForm(s.base, "/token", { client_id: "spa" }), 400, "invalid_request");
  });

  it("JSON body -> invalid_request", async () => {
    const s = await startServer();
    const r = await fetch(`${s.base}/token`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toBe("invalid_request");
  });

  it("repeated parameter -> invalid_request", async () => {
    const s = await startServer();
    const r = await fetch(`${s.base}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "grant_type=authorization_code&client_id=spa&client_id=spa" });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toBe("invalid_request");
  });

  it("oversized body -> 413", async () => {
    const s = await startServer();
    const r = await fetch(`${s.base}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "a=" + "x".repeat(20_000) });
    expect(r.status).toBe(413);
  });

  it("GET -> 405", async () => {
    const s = await startServer();
    expect((await fetch(`${s.base}/token`)).status).toBe(405);
  });
});
