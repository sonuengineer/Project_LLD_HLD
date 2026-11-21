// The authorization server: routing plus every endpoint. Runtime imports are node:http, node:crypto (through
// secrets.ts / jwt.ts) and this project's own files only.
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ClientConfig, ServerConfig, UserConfig } from "./config.js";
import { SUPPORTED_SCOPES } from "./config.js";
import { HttpError, isFormEncoded, noStore, oauthError, parseCookies, parseForm, readBody, sendHtml, sendJson } from "./http.js";
import { atHash, generateSigningKey, JwtError, signJwt, verifyJwt } from "./jwt.js";
import type { SigningKey } from "./jwt.js";
import { errorPage, loginPage } from "./pages.js";
import { CHALLENGE_RE, DEFAULT_SCRYPT, parseSecretHash, pkceMatches, randomToken, safeEqual, sha256, verifyAgainstDummy, verifySecret } from "./secrets.js";
import type { ScryptParams } from "./secrets.js";
import { memoryStores } from "./store.js";
import type { LoginTransaction, Stores, TokenFamily } from "./store.js";

/** Lifetimes in seconds. Short on purpose: codes are one-shot, access tokens cannot be recalled from third parties. */
export interface Lifetimes {
  code: number;
  accessToken: number;
  idToken: number;
  refreshToken: number;
  loginTransaction: number;
}

export const DEFAULT_LIFETIMES: Lifetimes = {
  code: 60,
  accessToken: 300,
  idToken: 300,
  refreshToken: 14 * 24 * 3600,
  loginTransaction: 600,
};

export interface AuthServerOptions {
  /** The issuer identifier, e.g. https://auth.example.test (no trailing slash). Every endpoint lives under it. */
  issuer: string;
  config: ServerConfig;
  /** The first key signs; all keys are published in /jwks. Default: one fresh P-256 key (lost on restart). */
  keys?: SigningKey[];
  stores?: Stores;
  /** Clock in milliseconds; injectable so expiry tests do not sleep. */
  now?: () => number;
  lifetimes?: Partial<Lifetimes>;
  /** `aud` of access tokens. Default `${issuer}/userinfo` (the only resource stage 1 serves). */
  accessTokenAudience?: string;
  /** Wrong password attempts allowed on one login transaction before it is thrown away. */
  maxLoginFailures?: number;
}

export const TX_COOKIE = "auth_tx";

interface Ctx {
  issuer: string;
  config: ServerConfig;
  keys: SigningKey[];
  stores: Stores;
  now: () => number;
  life: Lifetimes;
  audience: string;
  maxLoginFailures: number;
  secureCookie: boolean;
  dummyParams: ScryptParams;
  failures: Map<string, number>;
}

const nowSec = (ctx: Ctx): number => Math.floor(ctx.now() / 1000);

export function discoveryDocument(issuer: string): Record<string, unknown> {
  return {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    userinfo_endpoint: `${issuer}/userinfo`,
    jwks_uri: `${issuer}/jwks`,
    revocation_endpoint: `${issuer}/revoke`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["ES256"],
    scopes_supported: SUPPORTED_SCOPES,
    claims_supported: ["sub", "iss", "aud", "exp", "iat", "auth_time", "nonce", "at_hash", "name", "email"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["client_secret_basic", "none"],
    revocation_endpoint_auth_methods_supported: ["client_secret_basic", "none"],
    authorization_response_iss_parameter_supported: true,
  };
}

export function createAuthHandler(opts: AuthServerOptions): (req: IncomingMessage, res: ServerResponse) => void {
  if (opts.issuer.endsWith("/")) throw new Error("issuer must not end with a slash");
  const issuerUrl = new URL(opts.issuer);
  // The cost of the "unknown user" dummy hash should match real users' hashes.
  const firstUser = opts.config.users[0];
  const ctx: Ctx = {
    issuer: opts.issuer,
    config: opts.config,
    keys: opts.keys && opts.keys.length > 0 ? opts.keys : [generateSigningKey()],
    stores: opts.stores ?? memoryStores(),
    now: opts.now ?? Date.now,
    life: { ...DEFAULT_LIFETIMES, ...opts.lifetimes },
    audience: opts.accessTokenAudience ?? `${opts.issuer}/userinfo`,
    maxLoginFailures: opts.maxLoginFailures ?? 5,
    secureCookie: issuerUrl.protocol === "https:",
    dummyParams: firstUser ? parseSecretHash(firstUser.password_hash).params : DEFAULT_SCRYPT,
    failures: new Map(),
  };
  return (req, res) => {
    route(ctx, req, res).catch((err: unknown) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (err instanceof HttpError) {
        oauthError(res, err.status, "invalid_request", err.message);
        return;
      }
      oauthError(res, 500, "server_error", "internal error");
    });
  };
}

export function createAuthServer(opts: AuthServerOptions): http.Server {
  return http.createServer(createAuthHandler(opts));
}

async function route(ctx: Ctx, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://internal");
  const method = req.method ?? "GET";
  const allow = (methods: string[]): boolean => {
    if (methods.includes(method)) return true;
    res.setHeader("Allow", methods.join(", "));
    oauthError(res, 405, "invalid_request", `method ${method} not allowed`);
    return false;
  };
  switch (url.pathname) {
    case "/.well-known/openid-configuration":
      if (allow(["GET"])) sendJson(res, 200, discoveryDocument(ctx.issuer), { "Cache-Control": "public, max-age=300" });
      return;
    case "/jwks":
      if (allow(["GET"])) sendJson(res, 200, { keys: ctx.keys.map((k) => k.publicJwk) }, { "Cache-Control": "public, max-age=300" });
      return;
    case "/authorize":
      if (allow(["GET"])) handleAuthorize(ctx, url, res);
      return;
    case "/login":
      if (allow(["POST"])) await handleLogin(ctx, req, res);
      return;
    case "/token":
      if (allow(["POST"])) await handleToken(ctx, req, res);
      return;
    case "/userinfo":
      if (allow(["GET", "POST"])) handleUserinfo(ctx, req, res);
      return;
    case "/revoke":
      if (allow(["POST"])) await handleRevoke(ctx, req, res);
      return;
    default:
      sendJson(res, 404, { error: "not_found", error_description: "no such endpoint" });
  }
}

// ---- /authorize ---------------------------------------------------------------------------------------------

function findClient(ctx: Ctx, id: string | undefined): ClientConfig | undefined {
  return id === undefined ? undefined : ctx.config.clients.find((c) => c.client_id === id);
}

/** Exact string comparison against the registered list: no prefix, wildcard, or normalisation. */
export function redirectUriAllowed(client: ClientConfig, redirectUri: string): boolean {
  return client.redirect_uris.includes(redirectUri);
}

function redirectWith(res: ServerResponse, redirectUri: string, params: Record<string, string | undefined>, headers: Record<string, string | string[]> = {}): void {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
  noStore(res);
  res.writeHead(302, { Location: u.toString(), ...headers });
  res.end();
}

function handleAuthorize(ctx: Ctx, url: URL, res: ServerResponse): void {
  const q = url.searchParams;
  const one = (name: string): string | undefined | null => {
    const all = q.getAll(name);
    if (all.length > 1) return null; // repeated parameter
    return all[0];
  };
  const clientId = one("client_id");
  const redirectUri = one("redirect_uri");
  const client = typeof clientId === "string" ? findClient(ctx, clientId) : undefined;
  // RFC 6749 4.1.2.1: with an unknown client or an unregistered redirect_uri the server MUST NOT redirect
  // (that would make it an open redirector); it tells the user directly.
  if (!client) {
    sendHtml(res, 400, errorPage("Invalid request", "Unknown or missing client_id."));
    return;
  }
  if (typeof redirectUri !== "string" || !redirectUriAllowed(client, redirectUri)) {
    sendHtml(res, 400, errorPage("Invalid request", "The redirect_uri is missing or not registered for this client."));
    return;
  }
  const state = one("state");
  const fail = (error: string, description: string): void =>
    redirectWith(res, redirectUri, { error, error_description: description, state: state ?? undefined, iss: ctx.issuer });

  for (const name of new Set(q.keys())) {
    if (q.getAll(name).length > 1) {
      fail("invalid_request", `parameter ${name} is repeated`);
      return;
    }
  }
  const responseType = one("response_type");
  if (!responseType) return fail("invalid_request", "response_type is required");
  if (responseType !== "code") return fail("unsupported_response_type", "only response_type=code is supported");
  const responseMode = one("response_mode");
  if (responseMode && responseMode !== "query") return fail("invalid_request", "only response_mode=query is supported");

  // PKCE is mandatory for every client, and only S256. RFC 7636 4.3: a missing method means "plain".
  const challenge = one("code_challenge");
  const method = one("code_challenge_method");
  if (!challenge) return fail("invalid_request", "code_challenge is required (PKCE)");
  if (method !== "S256") return fail("invalid_request", "code_challenge_method must be S256");
  if (!CHALLENGE_RE.test(challenge)) return fail("invalid_request", "code_challenge is not a valid S256 challenge");

  const scope = (one("scope") ?? "").split(" ").filter((s) => s !== "");
  if (scope.length === 0) return fail("invalid_scope", "scope is required");
  const notAllowed = scope.filter((s) => !client.allowed_scopes.includes(s));
  if (notAllowed.length > 0) return fail("invalid_scope", `scope not allowed for this client: ${notAllowed.join(" ")}`);

  // There are no login sessions in stage 1, so the user can never be authenticated "silently".
  const prompt = (one("prompt") ?? "").split(" ");
  if (prompt.includes("none")) return fail("login_required", "no login session; prompt=none cannot be satisfied");

  const tx: LoginTransaction = {
    id: randomToken(),
    csrfToken: randomToken(),
    clientId: client.client_id,
    redirectUri,
    scope: [...new Set(scope)],
    state: state ?? undefined,
    nonce: one("nonce") ?? undefined,
    codeChallenge: challenge,
    expiresAt: ctx.now() + ctx.life.loginTransaction * 1000,
  };
  ctx.stores.transactions.save(tx);
  sendHtml(res, 200, loginPage({ clientName: client.client_name ?? client.client_id, scope: tx.scope, csrfToken: tx.csrfToken }), {
    "Set-Cookie": txCookie(ctx, tx.id, ctx.life.loginTransaction),
  });
}

function txCookie(ctx: Ctx, value: string, maxAge: number): string {
  return `${TX_COOKIE}=${value}; Path=/login; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${ctx.secureCookie ? "; Secure" : ""}`;
}

// ---- /login -------------------------------------------------------------------------------------------------

async function handleLogin(ctx: Ctx, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!isFormEncoded(req)) {
    sendHtml(res, 400, errorPage("Invalid request", "Expected a form post."));
    return;
  }
  const { params, duplicate } = parseForm(await readBody(req));
  if (duplicate) {
    sendHtml(res, 400, errorPage("Invalid request", `Parameter ${duplicate} is repeated.`));
    return;
  }
  const txId = parseCookies(req).get(TX_COOKIE);
  const tx = txId ? ctx.stores.transactions.get(txId) : undefined;
  if (!tx || ctx.now() >= tx.expiresAt) {
    if (tx) ctx.stores.transactions.delete(tx.id);
    sendHtml(res, 400, errorPage("Login expired", "This login attempt is unknown or has expired. Go back to the application and start again."));
    return;
  }
  // Synchronizer token: the form must carry the token that was issued together with THIS browser's
  // transaction cookie. A cross-site form cannot read it.
  if (!safeEqual(params.get("csrf_token") ?? "", tx.csrfToken)) {
    sendHtml(res, 403, errorPage("Forbidden", "Invalid CSRF token."));
    return;
  }
  const client = findClient(ctx, tx.clientId);
  if (!client) {
    ctx.stores.transactions.delete(tx.id);
    sendHtml(res, 400, errorPage("Invalid request", "The client no longer exists."));
    return;
  }
  const user = await checkPassword(ctx, params.get("username") ?? "", params.get("password") ?? "");
  if (!user) {
    const n = (ctx.failures.get(tx.id) ?? 0) + 1;
    if (n >= ctx.maxLoginFailures) {
      ctx.failures.delete(tx.id);
      ctx.stores.transactions.delete(tx.id);
      sendHtml(res, 401, errorPage("Login failed", "Too many failed attempts. Go back to the application and start again."));
      return;
    }
    ctx.failures.set(tx.id, n);
    sendHtml(res, 401, loginPage({ clientName: client.client_name ?? client.client_id, scope: tx.scope, csrfToken: tx.csrfToken, error: "Invalid username or password." }));
    return;
  }
  // The transaction is single-use: a second post of the same form cannot mint a second code.
  ctx.stores.transactions.delete(tx.id);
  ctx.failures.delete(tx.id);
  const code = randomToken();
  const now = ctx.now();
  ctx.stores.codes.save({
    codeHash: sha256(code),
    clientId: tx.clientId,
    redirectUri: tx.redirectUri,
    sub: user.sub,
    scope: tx.scope,
    nonce: tx.nonce,
    codeChallenge: tx.codeChallenge,
    authTime: Math.floor(now / 1000),
    expiresAt: now + ctx.life.code * 1000,
  });
  redirectWith(res, tx.redirectUri, { code, state: tx.state, iss: ctx.issuer }, { "Set-Cookie": txCookie(ctx, "", 0) });
}

async function checkPassword(ctx: Ctx, username: string, password: string): Promise<UserConfig | undefined> {
  const user = ctx.config.users.find((u) => u.username === username);
  if (!user) {
    await verifyAgainstDummy(password, ctx.dummyParams);
    return undefined;
  }
  return (await verifySecret(password, user.password_hash)) ? user : undefined;
}

// ---- client authentication (token and revocation endpoints) -------------------------------------------------

type ClientAuthResult = { ok: true; client: ClientConfig } | { ok: false; status: number; error: string; description: string };

const BASIC_CHALLENGE = { "WWW-Authenticate": 'Basic realm="token"' };

async function authenticateClient(ctx: Ctx, req: IncomingMessage, params: Map<string, string>): Promise<ClientAuthResult> {
  const bad = (description: string): ClientAuthResult => ({ ok: false, status: 401, error: "invalid_client", description });
  if (params.has("client_secret")) return bad("client_secret_post is not supported; use HTTP Basic (client_secret_basic)");
  const header = req.headers.authorization;
  if (header !== undefined) {
    const m = /^Basic ([A-Za-z0-9+/=]+)$/i.exec(header.trim());
    if (!m) return bad("unsupported Authorization header");
    const decoded = Buffer.from(m[1] ?? "", "base64").toString("utf8");
    const i = decoded.indexOf(":");
    if (i < 0) return bad("malformed Basic credentials");
    let id: string;
    let secret: string;
    try {
      // RFC 6749 2.3.1: client_id and secret are form-urlencoded before Basic encoding.
      id = decodeURIComponent(decoded.slice(0, i).replace(/\+/g, " "));
      secret = decodeURIComponent(decoded.slice(i + 1).replace(/\+/g, " "));
    } catch {
      return bad("malformed Basic credentials");
    }
    const bodyId = params.get("client_id");
    if (bodyId !== undefined && bodyId !== id) return { ok: false, status: 400, error: "invalid_request", description: "client_id in body differs from Basic credentials" };
    const client = findClient(ctx, id);
    if (!client || client.client_type !== "confidential" || !client.client_secret_hash) {
      await verifyAgainstDummy(secret, ctx.dummyParams);
      return bad("client authentication failed");
    }
    if (!(await verifySecret(secret, client.client_secret_hash))) return bad("client authentication failed");
    return { ok: true, client };
  }
  const id = params.get("client_id");
  const client = findClient(ctx, id);
  if (!client) return bad("client authentication failed");
  if (client.client_type !== "public") return bad("confidential clients must authenticate with HTTP Basic");
  return { ok: true, client };
}

async function readOAuthForm(req: IncomingMessage, res: ServerResponse): Promise<Map<string, string> | undefined> {
  if (!isFormEncoded(req)) {
    oauthError(res, 400, "invalid_request", "content-type must be application/x-www-form-urlencoded");
    return undefined;
  }
  const { params, duplicate } = parseForm(await readBody(req));
  if (duplicate) {
    oauthError(res, 400, "invalid_request", `parameter ${duplicate} is repeated`);
    return undefined;
  }
  return params;
}

// ---- /token -------------------------------------------------------------------------------------------------

async function handleToken(ctx: Ctx, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const params = await readOAuthForm(req, res);
  if (!params) return;
  const auth = await authenticateClient(ctx, req, params);
  if (!auth.ok) {
    oauthError(res, auth.status, auth.error, auth.description, auth.status === 401 ? BASIC_CHALLENGE : {});
    return;
  }
  const client = auth.client;
  const grant = params.get("grant_type");
  if (!grant) return oauthError(res, 400, "invalid_request", "grant_type is required");
  if (grant !== "authorization_code" && grant !== "refresh_token") return oauthError(res, 400, "unsupported_grant_type", `grant_type ${grant} is not supported`);
  if (!client.grant_types.includes(grant)) return oauthError(res, 400, "unauthorized_client", `client may not use grant_type ${grant}`);
  if (grant === "authorization_code") return codeGrant(ctx, client, params, res);
  return refreshGrant(ctx, client, params, res);
}

function codeGrant(ctx: Ctx, client: ClientConfig, params: Map<string, string>, res: ServerResponse): void {
  const code = params.get("code");
  const redirectUri = params.get("redirect_uri");
  const verifier = params.get("code_verifier");
  if (!code) return oauthError(res, 400, "invalid_request", "code is required");
  if (!redirectUri) return oauthError(res, 400, "invalid_request", "redirect_uri is required");
  if (!verifier) return oauthError(res, 400, "invalid_request", "code_verifier is required (PKCE)");

  // The code is burned on its first presentation, whatever happens next.
  const result = ctx.stores.codes.consume(sha256(code));
  if (result.kind === "missing") return oauthError(res, 400, "invalid_grant", "authorization code is invalid");
  if (result.kind === "reused") {
    // OAuth 2.0 Security BCP (RFC 9700) 4.4.2 / RFC 6749 4.1.2: a code used twice means it leaked;
    // revoke what was issued from it.
    if (result.code.familyId) ctx.stores.tokens.revokeFamily(result.code.familyId);
    return oauthError(res, 400, "invalid_grant", "authorization code was already used; tokens issued from it are revoked");
  }
  const c = result.code;
  if (ctx.now() >= c.expiresAt) return oauthError(res, 400, "invalid_grant", "authorization code expired");
  if (c.clientId !== client.client_id) return oauthError(res, 400, "invalid_grant", "authorization code was issued to another client");
  if (c.redirectUri !== redirectUri) return oauthError(res, 400, "invalid_grant", "redirect_uri does not match the authorization request");
  if (!pkceMatches(verifier, c.codeChallenge)) return oauthError(res, 400, "invalid_grant", "PKCE verification failed");
  const user = ctx.config.users.find((u) => u.sub === c.sub);
  if (!user) return oauthError(res, 400, "invalid_grant", "user no longer exists");

  const family: TokenFamily = { id: randomToken(16), clientId: client.client_id, sub: c.sub, scope: c.scope, authTime: c.authTime, revoked: false };
  ctx.stores.tokens.createFamily(family);
  ctx.stores.codes.setFamily(c.codeHash, family.id);
  sendTokens(ctx, res, client, family, c.scope, { nonce: c.nonce, withIdToken: c.scope.includes("openid") });
}

function refreshGrant(ctx: Ctx, client: ClientConfig, params: Map<string, string>, res: ServerResponse): void {
  const token = params.get("refresh_token");
  if (!token) return oauthError(res, 400, "invalid_request", "refresh_token is required");
  const hash = sha256(token);
  const rt = ctx.stores.tokens.getRefresh(hash);
  if (!rt) return oauthError(res, 400, "invalid_grant", "refresh token is invalid");
  if (rt.clientId !== client.client_id) return oauthError(res, 400, "invalid_grant", "refresh token was issued to another client");
  const family = ctx.stores.tokens.getFamily(rt.familyId);
  if (!family || family.revoked) return oauthError(res, 400, "invalid_grant", "refresh token is revoked");
  if (ctx.now() >= rt.expiresAt) return oauthError(res, 400, "invalid_grant", "refresh token expired");
  if (rt.used) return reuseDetected(ctx, res, family.id);
  // RFC 6749 6: a narrower scope may be asked for; never a wider one.
  let scope = family.scope;
  const requested = params.get("scope");
  if (requested !== undefined) {
    const want = requested.split(" ").filter((s) => s !== "");
    const extra = want.filter((s) => !family.scope.includes(s));
    if (want.length === 0 || extra.length > 0) return oauthError(res, 400, "invalid_scope", "requested scope exceeds the original grant");
    scope = [...new Set(want)];
  }
  if (!ctx.config.users.some((u) => u.sub === family.sub)) return oauthError(res, 400, "invalid_grant", "user no longer exists");
  // The atomic step. `rt.used` above is only a fast path; with a real database two concurrent requests could
  // both pass it, and markUsed decides which one wins.
  if (!ctx.stores.tokens.markUsed(hash)) return reuseDetected(ctx, res, family.id);
  sendTokens(ctx, res, client, family, scope, { withIdToken: false });
}

/**
 * Rotation + reuse detection (RFC 9700 4.14.2): an already-exchanged refresh token came back, so either the
 * client or an attacker holds a stolen copy. We cannot tell which, so the whole family dies.
 */
function reuseDetected(ctx: Ctx, res: ServerResponse, familyId: string): void {
  ctx.stores.tokens.revokeFamily(familyId);
  oauthError(res, 400, "invalid_grant", "refresh token reuse detected; the token family is revoked");
}

function sendTokens(ctx: Ctx, res: ServerResponse, client: ClientConfig, family: TokenFamily, scope: string[], opts: { nonce?: string; withIdToken: boolean }): void {
  const iat = nowSec(ctx);
  const jti = randomToken(16);
  // RFC 9068 (JWT profile for access tokens): typ at+jwt, client_id claim.
  const accessToken = signJwt(ctx.keys[0] as SigningKey, "at+jwt", {
    iss: ctx.issuer,
    sub: family.sub,
    aud: ctx.audience,
    client_id: client.client_id,
    scope: scope.join(" "),
    iat,
    exp: iat + ctx.life.accessToken,
    jti,
  });
  ctx.stores.tokens.recordAccessToken(jti, family.id);
  const body: Record<string, unknown> = {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: ctx.life.accessToken,
    scope: scope.join(" "),
  };
  if (client.grant_types.includes("refresh_token")) {
    const refresh = randomToken();
    ctx.stores.tokens.saveRefresh({ tokenHash: sha256(refresh), familyId: family.id, clientId: client.client_id, expiresAt: ctx.now() + ctx.life.refreshToken * 1000, used: false });
    body.refresh_token = refresh;
  }
  if (opts.withIdToken) {
    const claims: Record<string, unknown> = {
      iss: ctx.issuer,
      sub: family.sub,
      aud: client.client_id,
      iat,
      exp: iat + ctx.life.idToken,
      auth_time: family.authTime,
      at_hash: atHash(accessToken),
    };
    if (opts.nonce !== undefined) claims.nonce = opts.nonce;
    body.id_token = signJwt(ctx.keys[0] as SigningKey, "JWT", claims);
  }
  noStore(res);
  sendJson(res, 200, body);
}

// ---- /userinfo ----------------------------------------------------------------------------------------------

function bearerError(res: ServerResponse, status: number, error: string | undefined, description: string): void {
  const challenge = error ? `Bearer error="${error}", error_description="${description}"` : "Bearer";
  noStore(res);
  sendJson(res, status, error ? { error, error_description: description } : { error: "invalid_request", error_description: description }, { "WWW-Authenticate": challenge });
}

function handleUserinfo(ctx: Ctx, req: IncomingMessage, res: ServerResponse): void {
  const m = /^Bearer ([A-Za-z0-9\-._~+/]+=*)$/i.exec((req.headers.authorization ?? "").trim());
  if (!m) return bearerError(res, 401, undefined, "a Bearer access token is required");
  let claims: Record<string, unknown>;
  try {
    claims = verifyJwt(m[1] ?? "", ctx.keys, { issuer: ctx.issuer, audience: ctx.audience, typ: "at+jwt", nowSeconds: nowSec(ctx) });
  } catch (e) {
    if (e instanceof JwtError) return bearerError(res, 401, "invalid_token", e.message);
    throw e;
  }
  const familyId = typeof claims.jti === "string" ? ctx.stores.tokens.familyOfAccessToken(claims.jti) : undefined;
  const family = familyId ? ctx.stores.tokens.getFamily(familyId) : undefined;
  if (!family || family.revoked) return bearerError(res, 401, "invalid_token", "token revoked");
  const scope = typeof claims.scope === "string" ? claims.scope.split(" ") : [];
  if (!scope.includes("openid")) return bearerError(res, 403, "insufficient_scope", "the openid scope is required");
  const user = ctx.config.users.find((u) => u.sub === claims.sub);
  if (!user) return bearerError(res, 401, "invalid_token", "unknown subject");
  const out: Record<string, unknown> = { sub: user.sub };
  if (scope.includes("profile") && user.name !== undefined) out.name = user.name;
  if (scope.includes("email") && user.email !== undefined) out.email = user.email;
  noStore(res);
  sendJson(res, 200, out);
}

// ---- /revoke (RFC 7009) -------------------------------------------------------------------------------------

async function handleRevoke(ctx: Ctx, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const params = await readOAuthForm(req, res);
  if (!params) return;
  const auth = await authenticateClient(ctx, req, params);
  if (!auth.ok) {
    oauthError(res, auth.status, auth.error, auth.description, auth.status === 401 ? BASIC_CHALLENGE : {});
    return;
  }
  const token = params.get("token");
  if (!token) return oauthError(res, 400, "invalid_request", "token is required");
  const rt = ctx.stores.tokens.getRefresh(sha256(token));
  // Only refresh tokens are revocable here. Revoking one kills its whole family (RFC 7009 2.1: the server
  // SHOULD also invalidate access tokens from the same grant). A token of another client is left alone and,
  // like an unknown token, answered with 200 so the endpoint does not reveal which tokens exist.
  if (rt && rt.clientId === auth.client.client_id) ctx.stores.tokens.revokeFamily(rt.familyId);
  noStore(res);
  res.writeHead(200, { "Content-Length": 0 });
  res.end();
}
