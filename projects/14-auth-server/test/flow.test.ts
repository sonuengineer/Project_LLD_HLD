// Integration: the real HTTP server on an ephemeral port, walked end to end.
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { ALICE, basic, closeAll, decodeJwt, getCode, postForm, redeem, refresh, startServer, userinfo, WEB_REDIRECT, WEB_SECRET } from "./helpers.js";

afterEach(closeAll);

describe("full flow", () => {
  it("public client: authorize -> login (CSRF) -> code -> token -> userinfo -> refresh -> revoke", async () => {
    const s = await startServer();
    const { code, state, verifier, location, params } = await getCode(s.base);
    expect(`${location.origin}${location.pathname}`).toBe(params.redirect_uri);
    expect(state).toBe(params.state);
    expect(location.searchParams.get("iss")).toBe(s.base);
    expect(code.length).toBeGreaterThanOrEqual(43);

    const tok = await redeem(s.base, code, verifier);
    expect(tok.status).toBe(200);
    expect(tok.headers.get("cache-control")).toBe("no-store");
    expect(tok.headers.get("pragma")).toBe("no-cache");
    expect(tok.body.token_type).toBe("Bearer");
    expect(tok.body.expires_in).toBe(300);
    expect(tok.body.scope).toBe("openid profile email");
    const at = tok.body.access_token as string;
    const { header, payload } = decodeJwt(at);
    expect(header).toMatchObject({ alg: "ES256", typ: "at+jwt", kid: s.keys[0]?.kid });
    expect(payload).toMatchObject({ iss: s.base, sub: ALICE.sub, aud: `${s.base}/userinfo`, client_id: "spa", scope: "openid profile email" });
    expect(typeof payload.jti).toBe("string");
    expect((payload.exp as number) - (payload.iat as number)).toBe(300);

    const id = decodeJwt(tok.body.id_token as string).payload;
    expect(id).toMatchObject({ iss: s.base, sub: ALICE.sub, aud: "spa", nonce: params.nonce });
    expect(typeof id.auth_time).toBe("number");

    const ui = await userinfo(s.base, at);
    expect(ui.status).toBe(200);
    expect(ui.body).toEqual({ sub: ALICE.sub, name: "Alice Test", email: "alice@example.test" });

    const r1 = await refresh(s.base, tok.body.refresh_token as string);
    expect(r1.status).toBe(200);
    expect(r1.headers.get("cache-control")).toBe("no-store");
    expect(r1.body.refresh_token).not.toBe(tok.body.refresh_token);
    expect(r1.body.id_token).toBeUndefined();
    expect((await userinfo(s.base, r1.body.access_token as string)).status).toBe(200);

    const rv = await postForm(s.base, "/revoke", { token: r1.body.refresh_token as string, client_id: "spa" });
    expect(rv.status).toBe(200);
    expect((await refresh(s.base, r1.body.refresh_token as string)).body.error).toBe("invalid_grant");
    // Revoking the refresh token also killed the access tokens of the same family (checked by /userinfo).
    expect((await userinfo(s.base, r1.body.access_token as string)).status).toBe(401);
    expect((await userinfo(s.base, at)).status).toBe(401);
  });

  it("confidential client authenticates with client_secret_basic for token, refresh and revoke", async () => {
    const s = await startServer();
    const { code, verifier } = await getCode(s.base, { client_id: "web", redirect_uri: WEB_REDIRECT });
    const auth = basic("web", WEB_SECRET);
    const tok = await postForm(s.base, "/token", { grant_type: "authorization_code", code, redirect_uri: WEB_REDIRECT, code_verifier: verifier }, auth);
    expect(tok.status).toBe(200);
    expect(decodeJwt(tok.body.id_token as string).payload.aud).toBe("web");
    const r1 = await postForm(s.base, "/token", { grant_type: "refresh_token", refresh_token: tok.body.refresh_token as string }, auth);
    expect(r1.status).toBe(200);
    const rv = await postForm(s.base, "/revoke", { token: r1.body.refresh_token as string, token_type_hint: "refresh_token" }, auth);
    expect(rv.status).toBe(200);
    const r2 = await postForm(s.base, "/token", { grant_type: "refresh_token", refresh_token: r1.body.refresh_token as string }, auth);
    expect(r2.body.error).toBe("invalid_grant");
  });

  it("at_hash is the left half of SHA-256 over the access token (computed here independently)", async () => {
    const s = await startServer();
    const { code, verifier } = await getCode(s.base);
    const tok = await redeem(s.base, code, verifier);
    const at = tok.body.access_token as string;
    const expected = createHash("sha256").update(at).digest().subarray(0, 16).toString("base64url");
    expect(decodeJwt(tok.body.id_token as string).payload.at_hash).toBe(expected);
  });

  it("without the openid scope there is no id_token", async () => {
    const s = await startServer();
    const { code, verifier } = await getCode(s.base, { scope: "profile" });
    const tok = await redeem(s.base, code, verifier);
    expect(tok.status).toBe(200);
    expect(tok.body.id_token).toBeUndefined();
    expect(tok.body.scope).toBe("profile");
  });

  it("a client without the refresh_token grant gets no refresh token and may not use the grant", async () => {
    const s = await startServer();
    const { code, verifier } = await getCode(s.base, { client_id: "no-refresh", redirect_uri: "http://127.0.0.1:5175/cb", scope: "openid" });
    const tok = await redeem(s.base, code, verifier, { client_id: "no-refresh", redirect_uri: "http://127.0.0.1:5175/cb" });
    expect(tok.status).toBe(200);
    expect(tok.body.refresh_token).toBeUndefined();
    const r = await refresh(s.base, "anything", { client_id: "no-refresh" });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("unauthorized_client");
  });

  it("userinfo releases only the claims the scope allows", async () => {
    const s = await startServer();
    const { code, verifier } = await getCode(s.base, { scope: "openid email" });
    const tok = await redeem(s.base, code, verifier);
    expect((await userinfo(s.base, tok.body.access_token as string)).body).toEqual({ sub: ALICE.sub, email: "alice@example.test" });
  });
});
