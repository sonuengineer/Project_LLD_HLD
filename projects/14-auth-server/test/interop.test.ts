// Interop: independent, widely used libraries (devDependencies only) talk to the real server.
// - jose verifies our JWTs with the key it fetches from OUR /jwks endpoint.
// - openid-client (v6, built on oauth4webapi) runs discovery, the authorization code + PKCE flow, id_token
//   validation (including nonce and state), userinfo, refresh and revocation.
// The only part done by hand is the login form itself, because openid-client is a client library and does not
// drive a browser: we follow its authorization URL, post our form, and hand the redirect back to it.
import { createLocalJWKSet, createRemoteJWKSet, errors as joseErrors, jwtVerify } from "jose";
import * as oidc from "openid-client";
import { afterEach, describe, expect, it } from "vitest";
import { ALICE, closeAll, getCode, openLogin, postLogin, redeem, SPA_REDIRECT, startServer, WEB_REDIRECT, WEB_SECRET } from "./helpers.js";

afterEach(closeAll);

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
