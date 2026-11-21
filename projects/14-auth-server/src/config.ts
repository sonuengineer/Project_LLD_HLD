// Static configuration: registered clients and users. Loaded once at startup from a JSON file and validated
// strictly, because a bad redirect_uri or an unhashed secret here is a security bug, not a typo.
import { readFileSync } from "node:fs";
import { parseSecretHash } from "./secrets.js";

export type ClientType = "public" | "confidential";

export interface ClientConfig {
  client_id: string;
  client_name?: string;
  /** public: no secret, PKCE required (it is required for everyone anyway). confidential: client_secret_basic. */
  client_type: ClientType;
  /** scrypt hash of the client secret (see src/hash-secret.ts). Required for confidential clients only. */
  client_secret_hash?: string;
  /** Compared with the request's redirect_uri by EXACT string equality. */
  redirect_uris: string[];
  allowed_scopes: string[];
  /** Where /logout may send the browser afterwards. EXACT string match, like redirect_uris. Optional. */
  post_logout_redirect_uris: string[];
  /** "authorization_code" is always allowed; add "refresh_token" to get refresh tokens. */
  grant_types: string[];
}

export interface UserConfig {
  sub: string;
  username: string;
  password_hash: string;
  name?: string;
  email?: string;
}

export interface ServerConfig {
  clients: ClientConfig[];
  users: UserConfig[];
}

export const SUPPORTED_SCOPES = ["openid", "profile", "email"];
const SUPPORTED_GRANTS = ["authorization_code", "refresh_token"];

export class ConfigError extends Error {}

function fail(msg: string): never {
  throw new ConfigError(msg);
}

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

function checkRedirectUri(clientId: string, uri: string): void {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    fail(`client ${clientId}: redirect_uri ${uri} is not an absolute URL`);
  }
  // RFC 6749 3.1.2: the redirection endpoint URI MUST NOT include a fragment.
  if (u.hash || uri.includes("#")) fail(`client ${clientId}: redirect_uri ${uri} must not contain a fragment`);
  if (u.protocol !== "https:" && u.protocol !== "http:") fail(`client ${clientId}: redirect_uri ${uri} must be http(s)`);
  // Plain http only for loopback (native apps / local development, RFC 8252 7.3).
  if (u.protocol === "http:" && !["127.0.0.1", "[::1]", "localhost"].includes(u.hostname)) {
    fail(`client ${clientId}: http redirect_uri ${uri} is only allowed for loopback hosts`);
  }
}

export function validateConfig(raw: unknown): ServerConfig {
  if (typeof raw !== "object" || raw === null) fail("config must be an object");
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.clients) || !Array.isArray(obj.users)) fail("config needs clients[] and users[]");
  const clients: ClientConfig[] = [];
  const ids = new Set<string>();
  for (const c of obj.clients as Record<string, unknown>[]) {
    const id = c.client_id;
    if (typeof id !== "string" || id === "") fail("client_id must be a non-empty string");
    if (ids.has(id)) fail(`duplicate client_id ${id}`);
    ids.add(id);
    if (c.client_type !== "public" && c.client_type !== "confidential") fail(`client ${id}: client_type must be public or confidential`);
    if (c.client_type === "confidential") {
      if (typeof c.client_secret_hash !== "string") fail(`client ${id}: confidential client needs client_secret_hash`);
      try {
        parseSecretHash(c.client_secret_hash);
      } catch (e) {
        fail(`client ${id}: client_secret_hash is not a valid scrypt hash (${(e as Error).message})`);
      }
    } else if (c.client_secret_hash !== undefined) {
      fail(`client ${id}: a public client must not have a secret`);
    }
    if (!isStringArray(c.redirect_uris) || c.redirect_uris.length === 0) fail(`client ${id}: redirect_uris must be a non-empty string array`);
    for (const uri of c.redirect_uris) checkRedirectUri(id, uri);
    if (!isStringArray(c.allowed_scopes)) fail(`client ${id}: allowed_scopes must be a string array`);
    for (const s of c.allowed_scopes) if (!SUPPORTED_SCOPES.includes(s)) fail(`client ${id}: unsupported scope ${s}`);
    const postLogout = c.post_logout_redirect_uris === undefined ? [] : c.post_logout_redirect_uris;
    if (!isStringArray(postLogout)) fail(`client ${id}: post_logout_redirect_uris must be a string array`);
    for (const uri of postLogout) checkRedirectUri(id, uri);
    const grants = c.grant_types === undefined ? ["authorization_code"] : c.grant_types;
    if (!isStringArray(grants)) fail(`client ${id}: grant_types must be a string array`);
    for (const g of grants) if (!SUPPORTED_GRANTS.includes(g)) fail(`client ${id}: unsupported grant_type ${g}`);
    clients.push({
      client_id: id,
      client_name: typeof c.client_name === "string" ? c.client_name : undefined,
      client_type: c.client_type,
      client_secret_hash: c.client_secret_hash as string | undefined,
      redirect_uris: [...c.redirect_uris],
      post_logout_redirect_uris: [...postLogout],
      allowed_scopes: [...c.allowed_scopes],
      grant_types: [...grants],
    });
  }
  const users: UserConfig[] = [];
  const names = new Set<string>();
  const subs = new Set<string>();
  for (const u of obj.users as Record<string, unknown>[]) {
    if (typeof u.sub !== "string" || u.sub === "" || typeof u.username !== "string" || u.username === "") fail("user needs sub and username");
    if (names.has(u.username) || subs.has(u.sub)) fail(`duplicate user ${u.username}`);
    names.add(u.username);
    subs.add(u.sub);
    if (typeof u.password_hash !== "string") fail(`user ${u.username}: password_hash missing`);
    try {
      parseSecretHash(u.password_hash);
    } catch (e) {
      fail(`user ${u.username}: password_hash is not a valid scrypt hash (${(e as Error).message})`);
    }
    users.push({
      sub: u.sub,
      username: u.username,
      password_hash: u.password_hash,
      name: typeof u.name === "string" ? u.name : undefined,
      email: typeof u.email === "string" ? u.email : undefined,
    });
  }
  return { clients, users };
}

export function loadConfig(path: string): ServerConfig {
  return validateConfig(JSON.parse(readFileSync(path, "utf8")));
}
