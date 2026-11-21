import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { validateConfig } from "../src/config.js";
import type { ServerConfig } from "../src/config.js";
import { generateSigningKey } from "../src/jwt.js";
import type { SigningKey } from "../src/jwt.js";
import { hashSecret, s256 } from "../src/secrets.js";
import { createAuthHandler } from "../src/server.js";
import type { AuthServerOptions } from "../src/server.js";
import { memoryStores } from "../src/store.js";
import type { Stores } from "../src/store.js";

// Test-only scrypt cost (N=2^14 instead of 2^17) so the suite stays fast. The cost is stored inside each hash
// and verifySecret reads it from there, so the code path is the same as with production parameters.
const FAST = { N: 2 ** 14, r: 8, p: 1 };

export const ALICE = { username: "alice", password: "alice-test-password", sub: "user-0001" };
export const WEB_SECRET = "web-client-test-secret";
export const SPA_REDIRECT = "http://127.0.0.1:5173/callback";
export const WEB_REDIRECT = "https://app.example.test/callback";
export const SPA_LOGGED_OUT = "http://127.0.0.1:5173/logged-out";

let configPromise: Promise<ServerConfig> | undefined;

export function testConfig(): Promise<ServerConfig> {
  configPromise ??= (async () =>
    validateConfig({
      clients: [
        { client_id: "spa", client_type: "public", redirect_uris: [SPA_REDIRECT], post_logout_redirect_uris: [SPA_LOGGED_OUT], allowed_scopes: ["openid", "profile", "email"], grant_types: ["authorization_code", "refresh_token"] },
        { client_id: "other-spa", client_type: "public", redirect_uris: ["http://127.0.0.1:5174/callback"], allowed_scopes: ["openid"], grant_types: ["authorization_code", "refresh_token"] },
        { client_id: "no-refresh", client_type: "public", redirect_uris: ["http://127.0.0.1:5175/cb"], allowed_scopes: ["openid"], grant_types: ["authorization_code"] },
        { client_id: "web", client_type: "confidential", client_secret_hash: await hashSecret(WEB_SECRET, FAST), redirect_uris: [WEB_REDIRECT], allowed_scopes: ["openid", "profile", "email"], grant_types: ["authorization_code", "refresh_token"] },
      ],
      users: [
        { sub: ALICE.sub, username: ALICE.username, password_hash: await hashSecret(ALICE.password, FAST), name: "Alice Test", email: "alice@example.test" },
        { sub: "user-0002", username: "bob", password_hash: await hashSecret("bob-test-password", FAST) },
      ],
    }))();
  return configPromise;
}

export interface TestServer {
  base: string;
  port: number;
  clock: { t: number };
  stores: Stores;
  keys: SigningKey[];
  close(): Promise<void>;
}

const open: http.Server[] = [];

/** Starts the real HTTP server on an ephemeral port. The issuer is the URL it really listens on. */
export async function startServer(extra: Partial<AuthServerOptions> = {}, opts: { port?: number; clock?: { t: number } } = {}): Promise<TestServer> {
  const server = http.createServer();
  // `port` lets a restart test come back on the same port, so the issuer (and every token's iss) stays the same.
  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, "127.0.0.1", resolve));
  open.push(server);
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  const clock = opts.clock ?? { t: Date.now() };
  const stores = extra.stores ?? memoryStores();
  const keys = extra.keys ?? [generateSigningKey()];
  server.on("request", createAuthHandler({ issuer: base, config: await testConfig(), now: () => clock.t, stores, keys, ...extra }));
  return {
    base,
    port,
    clock,
    stores,
    keys,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export async function closeAll(): Promise<void> {
  for (const s of open.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
}

export function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: s256(verifier) };
}

export function authorizeParams(challenge: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    response_type: "code",
    client_id: "spa",
    redirect_uri: SPA_REDIRECT,
    scope: "openid profile email",
    state: "state-" + randomBytes(6).toString("hex"),
    nonce: "nonce-" + randomBytes(6).toString("hex"),
    code_challenge: challenge,
    code_challenge_method: "S256",
    ...extra,
  };
}

export interface LoginPage {
  status: number;
  cookie: string;
  csrf: string;
  html: string;
}

/** GET /authorize and read the login form: the transaction cookie and the CSRF token. */
export async function openLogin(base: string, params: Record<string, string> | string): Promise<LoginPage> {
  const qs = typeof params === "string" ? params : new URLSearchParams(params).toString();
  const r = await fetch(`${base}/authorize?${qs}`, { redirect: "manual" });
  const html = await r.text();
  const cookie = (r.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const csrf = /name="csrf_token" value="([^"]+)"/.exec(html)?.[1] ?? "";
  return { status: r.status, cookie, csrf, html };
}

export function postLogin(base: string, cookie: string, form: Record<string, string>): Promise<Response> {
  return fetch(`${base}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie },
    body: new URLSearchParams(form).toString(),
  });
}

/** Whole front channel: authorize -> login form -> post credentials -> read the code from the redirect. */
export async function getCode(base: string, extra: Record<string, string> = {}): Promise<{ code: string; state: string; verifier: string; location: URL; params: Record<string, string>; sessionCookie: string }> {
  const { verifier, challenge } = pkce();
  const params = authorizeParams(challenge, extra);
  const page = await openLogin(base, params);
  if (page.status !== 200) throw new Error(`authorize returned ${page.status}: ${page.html}`);
  const r = await postLogin(base, page.cookie, { csrf_token: page.csrf, username: ALICE.username, password: ALICE.password });
  if (r.status !== 302) throw new Error(`login returned ${r.status}`);
  const location = new URL(r.headers.get("location") ?? "");
  const sessionCookie = r.headers.getSetCookie().find((c) => c.startsWith("auth_session="))?.split(";")[0] ?? "";
  return { code: location.searchParams.get("code") ?? "", state: location.searchParams.get("state") ?? "", verifier, location, params, sessionCookie };
}

export async function postForm(base: string, path: string, form: Record<string, string>, headers: Record<string, string> = {}): Promise<{ status: number; headers: Headers; body: Record<string, unknown> }> {
  const r = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(form).toString(),
  });
  const text = await r.text();
  return { status: r.status, headers: r.headers, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

export function basic(id: string, secret: string): Record<string, string> {
  return { authorization: "Basic " + Buffer.from(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`).toString("base64") };
}

/** Exchange a code for the public "spa" client (or another client via `form`). */
export function redeem(base: string, code: string, verifier: string, form: Record<string, string> = {}, headers: Record<string, string> = {}) {
  return postForm(base, "/token", { grant_type: "authorization_code", code, redirect_uri: SPA_REDIRECT, code_verifier: verifier, client_id: "spa", ...form }, headers);
}

export function refresh(base: string, refreshToken: string, form: Record<string, string> = {}) {
  return postForm(base, "/token", { grant_type: "refresh_token", refresh_token: refreshToken, client_id: "spa", ...form });
}

export async function userinfo(base: string, accessToken: string): Promise<{ status: number; headers: Headers; body: Record<string, unknown> }> {
  const r = await fetch(`${base}/userinfo`, { headers: { authorization: `Bearer ${accessToken}` } });
  const text = await r.text();
  return { status: r.status, headers: r.headers, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

/** Decode a JWT part without verifying (tests only). */
export function decodeJwt(token: string): { header: Record<string, unknown>; payload: Record<string, unknown> } {
  const [h, p] = token.split(".");
  return {
    header: JSON.parse(Buffer.from(h ?? "", "base64url").toString("utf8")) as Record<string, unknown>,
    payload: JSON.parse(Buffer.from(p ?? "", "base64url").toString("utf8")) as Record<string, unknown>,
  };
}
