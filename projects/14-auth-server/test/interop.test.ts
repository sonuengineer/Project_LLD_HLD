// Interop: independent, widely used libraries (devDependencies only) talk to the real server.
// - jose verifies our JWTs with the key it fetches from OUR /jwks endpoint.
// - openid-client (v6, built on oauth4webapi) runs discovery, the authorization code + PKCE flow, id_token
//   validation (including nonce and state), userinfo, refresh and revocation.
// The only part done by hand is the login form itself, because openid-client is a client library and does not
// drive a browser: we follow its authorization URL, post our form, and hand the redirect back to it.
import { createLocalJWKSet, createRemoteJWKSet, errors as joseErrors, jwtVerify } from "jose";
import * as oidc from "openid-client";
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileKeyRing } from "../src/keys.js";
import { DEFAULT_LIFETIMES, keyRetentionMs } from "../src/server.js";
import { ALICE, closeAll, decodeJwt, getCode, openLogin, postLogin, redeem, SPA_LOGGED_OUT, SPA_REDIRECT, startServer, WEB_REDIRECT, WEB_SECRET } from "./helpers.js";

const dirs: string[] = [];
afterEach(async () => {
  await closeAll();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("interop: jose verifies our tokens via /jwks", () => {
  it("access token and id_token verify with createRemoteJWKSet; claims checked by jose", async () => {
    const s = await startServer();
    const { code, verifier, params } = await getCode(s.base);
    const tok = await redeem(s.base, code, verifier);
    const jwks = createRemoteJWKSet(new URL(`${s.base}/jwks`));

    const at = await jwtVerify(tok.body.access_token as string, jwks, { issuer: s.base, audience: `${s.base}/userinfo`, algorithms: ["ES256"], typ: "at+jwt" });
    expect(at.payload.sub).toBe(ALICE.sub);
    expect(at.protectedHeader.kid).toBe(s.keys[0]?.kid);

    const id = await jwtVerify(tok.body.id_token as string, jwks, { issuer: s.base, audience: "spa", algorithms: ["ES256"] });
    expect(id.payload.nonce).toBe(params.nonce);
  });

  it("jose rejects a tampered signature", async () => {
    const s = await startServer();
    const { code, verifier } = await getCode(s.base);
    const t = (await redeem(s.base, code, verifier)).body.access_token as string;
    const tampered = t.slice(0, -2) + (t.at(-2) === "A" ? "B" : "A") + t.slice(-1);
    const jwks = createRemoteJWKSet(new URL(`${s.base}/jwks`));
    await expect(jwtVerify(tampered, jwks, { issuer: s.base })).rejects.toBeInstanceOf(joseErrors.JWSSignatureVerificationFailed);
  });

  it("jose rejects our access token for the wrong audience", async () => {
    const s = await startServer();
    const { code, verifier } = await getCode(s.base);
    const t = (await redeem(s.base, code, verifier)).body.access_token as string;
    const jwks = createLocalJWKSet((await (await fetch(`${s.base}/jwks`)).json()) as { keys: [] });
    await expect(jwtVerify(t, jwks, { issuer: s.base, audience: "spa" })).rejects.toBeInstanceOf(joseErrors.JWTClaimValidationFailed);
  });
});

describe("interop: jose across a signing-key rotation", () => {
  it("a JWKS fetched BEFORE the rotation already has the new key; old and new tokens both verify; after the overlap the old kid is gone", async () => {
    const dir = mkdtempSync(join(tmpdir(), "auth-interop-"));
    dirs.push(dir);
    const clock = { t: Date.now() };
    const ring = FileKeyRing.open(dir, { retainMs: keyRetentionMs(DEFAULT_LIFETIMES), now: () => clock.t });
    const s = await startServer({ keyRing: ring }, { clock });
    const opts = { issuer: s.base, audience: `${s.base}/userinfo`, algorithms: ["ES256"], typ: "at+jwt" };
    const issue = async () => {
      const { code, verifier } = await getCode(s.base);
      return (await redeem(s.base, code, verifier)).body.access_token as string;
    };
    const oldToken = await issue();
    // jose fetches and caches the JWKS now, before the rotation.
    const cached = createRemoteJWKSet(new URL(`${s.base}/jwks`));
    await jwtVerify(oldToken, cached, opts);

    ring.rotate(clock.t);
    const newToken = await issue();
    expect(decodeJwt(newToken).header.kid).not.toBe(decodeJwt(oldToken).header.kid);
    // The new kid was pre-published as "next", so the cached JWKS verifies it. jose would NOT refetch here: it
    // reloads on an unknown kid only after a 30 s cooldown since the last fetch, which was milliseconds ago.
    await jwtVerify(newToken, cached, opts);
    await jwtVerify(oldToken, cached, opts);
    // A fresh fetch after the rotation also verifies both.
    const fresh = createRemoteJWKSet(new URL(`${s.base}/jwks`));
    await jwtVerify(oldToken, fresh, opts);
    await jwtVerify(newToken, fresh, opts);

    // After the overlap (= access token lifetime) the old key is no longer published. jose's currentDate is
    // pinned to before the old token's exp, so the failure below is about the missing key, not about expiry.
    clock.t += keyRetentionMs(DEFAULT_LIFETIMES);
    const after = createRemoteJWKSet(new URL(`${s.base}/jwks`));
    const pinned = { ...opts, currentDate: new Date((decodeJwt(oldToken).payload.iat as number) * 1000) };
    await expect(jwtVerify(oldToken, after, pinned)).rejects.toBeInstanceOf(joseErrors.JWKSNoMatchingKey);
    await jwtVerify(newToken, after, { ...opts, currentDate: new Date((decodeJwt(newToken).payload.iat as number) * 1000) });
  });
});

/** Follow openid-client's authorization URL through our login form; returns the callback URL with the code. */
async function loginVia(url: URL): Promise<URL> {
  const page = await openLogin(url.origin, url.search.slice(1));
  expect(page.status).toBe(200);
  const r = await postLogin(url.origin, page.cookie, { csrf_token: page.csrf, username: ALICE.username, password: ALICE.password });
  expect(r.status).toBe(302);
  return new URL(r.headers.get("location") ?? "");
}

async function runOpenIdClientFlow(config: oidc.Configuration, base: string, redirectUri: string, clientId: string) {
  const verifier = oidc.randomPKCECodeVerifier();
  const challenge = await oidc.calculatePKCECodeChallenge(verifier);
  const state = oidc.randomState();
  const nonce = oidc.randomNonce();
  const authUrl = oidc.buildAuthorizationUrl(config, { redirect_uri: redirectUri, scope: "openid profile email", code_challenge: challenge, code_challenge_method: "S256", state, nonce });
  expect(authUrl.toString().startsWith(`${base}/authorize?`)).toBe(true);

  const callback = await loginVia(authUrl);
  const tokens = await oidc.authorizationCodeGrant(config, callback, { pkceCodeVerifier: verifier, expectedState: state, expectedNonce: nonce, idTokenExpected: true });
  const claims = tokens.claims();
  expect(claims?.sub).toBe(ALICE.sub);
  expect(claims?.aud).toBe(clientId);
  expect(claims?.nonce).toBe(nonce);

  const info = await oidc.fetchUserInfo(config, tokens.access_token, ALICE.sub);
  expect(info.email).toBe("alice@example.test");

  const refreshed = await oidc.refreshTokenGrant(config, tokens.refresh_token ?? "");
  expect(refreshed.refresh_token).toBeTruthy();
  // Stage 2: the refresh response carries an id_token; openid-client validates its claims (iss, aud, exp, iat).
  expect(refreshed.claims()?.sub).toBe(ALICE.sub);
  expect(refreshed.claims()?.aud).toBe(clientId);
  expect(refreshed.refresh_token).not.toBe(tokens.refresh_token);

  await oidc.tokenRevocation(config, refreshed.refresh_token ?? "", { token_type_hint: "refresh_token" });
  await expect(oidc.refreshTokenGrant(config, refreshed.refresh_token ?? "")).rejects.toMatchObject({ error: "invalid_grant" });
  return { tokens, verifier, callback };
}

describe("interop: openid-client runs the whole flow", () => {
  // allowInsecureRequests: the test server listens on plain http://127.0.0.1; openid-client refuses http otherwise.
  const insecure = { execute: [oidc.allowInsecureRequests] };

  it("public client (token_endpoint_auth_method none) + PKCE: discovery, code grant, id_token, userinfo, refresh, revoke", async () => {
    const s = await startServer();
    const config = await oidc.discovery(new URL(s.base), "spa", { id_token_signed_response_alg: "ES256" }, oidc.None(), insecure);
    expect(config.serverMetadata().issuer).toBe(s.base);
    await runOpenIdClientFlow(config, s.base, SPA_REDIRECT, "spa");
  });

  it("confidential client with client_secret_basic", async () => {
    const s = await startServer();
    const config = await oidc.discovery(new URL(s.base), "web", { id_token_signed_response_alg: "ES256" }, oidc.ClientSecretBasic(WEB_SECRET), insecure);
    await runOpenIdClientFlow(config, s.base, WEB_REDIRECT, "web");
  });

  it("RP-initiated logout: discovery advertises end_session_endpoint, buildEndSessionUrl -> our /logout -> redirect with state; the session's tokens are dead", async () => {
    const s = await startServer();
    const config = await oidc.discovery(new URL(s.base), "spa", { id_token_signed_response_alg: "ES256" }, oidc.None(), insecure);
    expect(config.serverMetadata().end_session_endpoint).toBe(`${s.base}/logout`);
    const verifier = oidc.randomPKCECodeVerifier();
    const state = oidc.randomState();
    const authUrl = oidc.buildAuthorizationUrl(config, { redirect_uri: SPA_REDIRECT, scope: "openid", code_challenge: await oidc.calculatePKCECodeChallenge(verifier), code_challenge_method: "S256", state });
    const tokens = await oidc.authorizationCodeGrant(config, await loginVia(authUrl), { pkceCodeVerifier: verifier, expectedState: state });

    const logoutState = oidc.randomState();
    const endUrl = oidc.buildEndSessionUrl(config, { id_token_hint: tokens.id_token ?? "", post_logout_redirect_uri: SPA_LOGGED_OUT, state: logoutState });
    expect(endUrl.searchParams.get("client_id")).toBe("spa"); // openid-client adds it; we check it equals aud
    const r = await fetch(endUrl, { redirect: "manual" });
    expect(r.status).toBe(302);
    const back = new URL(r.headers.get("location") ?? "");
    expect(`${back.origin}${back.pathname}`).toBe(SPA_LOGGED_OUT);
    expect(back.searchParams.get("state")).toBe(logoutState);
    await expect(oidc.refreshTokenGrant(config, tokens.refresh_token ?? "")).rejects.toMatchObject({ error: "invalid_grant" });
  });

  it("openid-client surfaces our errors: reused code -> invalid_grant", async () => {
    const s = await startServer();
    const config = await oidc.discovery(new URL(s.base), "spa", { id_token_signed_response_alg: "ES256" }, oidc.None(), insecure);
    const verifier = oidc.randomPKCECodeVerifier();
    const state = oidc.randomState();
    const authUrl = oidc.buildAuthorizationUrl(config, { redirect_uri: SPA_REDIRECT, scope: "openid", code_challenge: await oidc.calculatePKCECodeChallenge(verifier), code_challenge_method: "S256", state });
    const callback = await loginVia(authUrl);
    await oidc.authorizationCodeGrant(config, callback, { pkceCodeVerifier: verifier, expectedState: state });
    await expect(oidc.authorizationCodeGrant(config, callback, { pkceCodeVerifier: verifier, expectedState: state })).rejects.toMatchObject({ error: "invalid_grant" });
  });

  it("openid-client really validates our id_token: a different expected nonce is rejected", async () => {
    const s = await startServer();
    const config = await oidc.discovery(new URL(s.base), "spa", { id_token_signed_response_alg: "ES256" }, oidc.None(), insecure);
    const verifier = oidc.randomPKCECodeVerifier();
    const state = oidc.randomState();
    const authUrl = oidc.buildAuthorizationUrl(config, { redirect_uri: SPA_REDIRECT, scope: "openid", code_challenge: await oidc.calculatePKCECodeChallenge(verifier), code_challenge_method: "S256", state, nonce: "nonce-sent" });
    const callback = await loginVia(authUrl);
    const err = await oidc.authorizationCodeGrant(config, callback, { pkceCodeVerifier: verifier, expectedState: state, expectedNonce: "nonce-other" }).then(() => undefined, (e: unknown) => e);
    // openid-client's own message is generic ("unexpected JWT claim value encountered"); the wrapped
    // oauth4webapi error underneath names the claim.
    expect(err).toMatchObject({ code: "OAUTH_JWT_CLAIM_COMPARISON_FAILED" });
    expect(String((err as { cause?: { message?: string } }).cause?.message)).toContain('"nonce"');
  });

  it("openid-client rejects a callback whose state does not match", async () => {
    const s = await startServer();
    const config = await oidc.discovery(new URL(s.base), "spa", { id_token_signed_response_alg: "ES256" }, oidc.None(), insecure);
    const verifier = oidc.randomPKCECodeVerifier();
    const authUrl = oidc.buildAuthorizationUrl(config, { redirect_uri: SPA_REDIRECT, scope: "openid", code_challenge: await oidc.calculatePKCECodeChallenge(verifier), code_challenge_method: "S256", state: "the-real-state" });
    const callback = await loginVia(authUrl);
    await expect(oidc.authorizationCodeGrant(config, callback, { pkceCodeVerifier: verifier, expectedState: "another-state" })).rejects.toThrow();
  });
});
