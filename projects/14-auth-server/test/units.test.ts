// Unit tests for the pure pieces: secrets, JWTs, config validation, HTML escaping.
import { createHash, generateKeyPairSync } from "node:crypto";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, validateConfig } from "../src/config.js";
import { atHash, generateSigningKey, JwtError, signJwt, signingKeyFromPrivate, verifyJwt } from "../src/jwt.js";
import { loginPage } from "../src/pages.js";
import { hashSecret, parseSecretHash, pkceMatches, s256, safeEqual, verifySecret } from "../src/secrets.js";

const FAST = { N: 2 ** 14, r: 8, p: 1 };

describe("secrets", () => {
  it("scrypt hash round trip; wrong secret fails; salt makes hashes differ", async () => {
    const h1 = await hashSecret("correct horse", FAST);
    const h2 = await hashSecret("correct horse", FAST);
    expect(h1).not.toBe(h2);
    expect(h1).toMatch(/^scrypt\$16384\$8\$1\$/);
    expect(await verifySecret("correct horse", h1)).toBe(true);
    expect(await verifySecret("correct horsf", h1)).toBe(false);
  });

  it("the default cost is the OWASP minimum N=2^17, r=8, p=1", async () => {
    expect(parseSecretHash(await hashSecret("x")).params).toEqual({ N: 131072, r: 8, p: 1 });
  });

  it("rejects malformed hashes and absurd parameters", () => {
    expect(() => parseSecretHash("plain-text")).toThrow();
    expect(() => parseSecretHash("scrypt$3$8$1$c2FsdHNhbHQ$" + "A".repeat(43))).toThrow(/range/);
    expect(() => parseSecretHash("scrypt$4194304$8$1$c2FsdHNhbHQ$" + "A".repeat(43))).toThrow(/range/);
  });

  it("safeEqual compares contents, also for different lengths", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(safeEqual("", "")).toBe(true);
  });

  it("PKCE S256 matches the RFC 7636 appendix B example", () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    expect(s256(verifier)).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    expect(pkceMatches(verifier, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")).toBe(true);
    expect(pkceMatches(verifier.slice(0, -1) + "j", "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")).toBe(false);
  });

  it("PKCE rejects verifiers that break the RFC 7636 syntax even if they hash correctly", () => {
    const short = "a".repeat(42);
    expect(pkceMatches(short, s256(short))).toBe(false);
    const bad = "a".repeat(42) + "!";
    expect(pkceMatches(bad, s256(bad))).toBe(false);
  });
});

describe("jwt", () => {
  const opts = (now: number) => ({ issuer: "https://issuer.example.test", audience: "api", typ: "at+jwt", nowSeconds: now });
  const payload = { iss: "https://issuer.example.test", aud: "api", sub: "u", exp: 2000 };

  it("sign + verify round trip, 64-byte raw ECDSA signature", () => {
    const k = generateSigningKey();
    const t = signJwt(k, "at+jwt", payload);
    expect(Buffer.from(t.split(".")[2] ?? "", "base64url")).toHaveLength(64);
    expect(verifyJwt(t, [k], opts(1000)).sub).toBe("u");
  });

  it.each([
    ["wrong audience", { ...payload, aud: "other" }, "at+jwt", 1000, "wrong audience"],
    ["wrong issuer", { ...payload, iss: "x" }, "at+jwt", 1000, "wrong issuer"],
    ["expired (exp == now)", payload, "at+jwt", 2000, "expired"],
    ["no exp", { iss: payload.iss, aud: "api" }, "at+jwt", 1000, "expired"],
    ["wrong typ", payload, "JWT", 1000, "unexpected typ"],
  ])("%s -> JwtError", (_l, p, typ, now, msg) => {
    const k = generateSigningKey();
    expect(() => verifyJwt(signJwt(k, typ, p), [k], opts(now))).toThrow(msg);
  });

  it("ignoreExpiry skips ONLY the exp check (used for logout's id_token_hint)", () => {
    const k = generateSigningKey();
    const t = signJwt(k, "at+jwt", payload);
    expect(verifyJwt(t, [k], { ...opts(5000), ignoreExpiry: true }).sub).toBe("u");
    expect(() => verifyJwt(t, [k], { ...opts(5000), ignoreExpiry: true, audience: "other" })).toThrow("wrong audience");
    expect(() => verifyJwt(signJwt(k, "at+jwt", { iss: payload.iss, aud: "api" }), [k], { ...opts(1000), ignoreExpiry: true })).toThrow("expired");
  });

  it("unknown kid, malformed token and bad signature are rejected", () => {
    const k = generateSigningKey();
    const t = signJwt(k, "at+jwt", payload);
    expect(() => verifyJwt(t, [generateSigningKey()], opts(1000))).toThrow("unknown kid");
    expect(() => verifyJwt("a.b", [k], opts(1000))).toThrow(JwtError);
    const [h, p] = t.split(".");
    expect(() => verifyJwt(`${h}.${p}.${Buffer.alloc(64).toString("base64url")}`, [k], opts(1000))).toThrow("bad signature");
  });

  it("refuses non P-256 keys", () => {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-384" });
    expect(() => signingKeyFromPrivate(privateKey)).toThrow();
  });

  it("at_hash = base64url(left 128 bits of SHA-256)", () => {
    const expected = createHash("sha256").update("token-value").digest().subarray(0, 16).toString("base64url");
    expect(atHash("token-value")).toBe(expected);
    expect(atHash("token-value")).toHaveLength(22);
  });
});

describe("config", () => {
  const hash = "scrypt$16384$8$1$c2FsdHNhbHRzYWx0$" + Buffer.alloc(32).toString("base64url");
  const client = { client_id: "c", client_type: "public", redirect_uris: ["https://app.example.test/cb"], allowed_scopes: ["openid"] };

  it("the shipped example config loads, and its documented fake passwords verify", async () => {
    const cfg = loadConfig(fileURLToPath(new URL("../config/example.json", import.meta.url)));
    expect(cfg.clients.map((c) => c.client_id)).toEqual(["demo-spa", "demo-web"]);
    expect(await verifySecret("alice-password-FAKE", cfg.users[0]?.password_hash ?? "")).toBe(true);
    expect(await verifySecret("webapp-secret-FAKE", cfg.clients[1]?.client_secret_hash ?? "")).toBe(true);
  });

  it.each([
    ["fragment in redirect_uri", { ...client, redirect_uris: ["https://app.example.test/cb#x"] }],
    ["relative redirect_uri", { ...client, redirect_uris: ["/cb"] }],
    ["http on a non-loopback host", { ...client, redirect_uris: ["http://app.example.test/cb"] }],
    ["confidential without secret hash", { ...client, client_type: "confidential" }],
    ["confidential with a plain-text secret", { ...client, client_type: "confidential", client_secret_hash: "s3cret" }],
    ["public with a secret", { ...client, client_secret_hash: hash }],
    ["unknown scope", { ...client, allowed_scopes: ["admin"] }],
    ["unknown grant", { ...client, grant_types: ["password"] }],
    ["http post_logout_redirect_uri on a non-loopback host", { ...client, post_logout_redirect_uris: ["http://app.example.test/bye"] }],
    ["post_logout_redirect_uri with a fragment", { ...client, post_logout_redirect_uris: ["https://app.example.test/bye#x"] }],
  ])("rejects a client with %s", (_l, c) => {
    expect(() => validateConfig({ clients: [c], users: [] })).toThrow(ConfigError);
  });

  it("rejects duplicate client ids and plain-text user passwords", () => {
    expect(() => validateConfig({ clients: [client, client], users: [] })).toThrow(/duplicate/);
    expect(() => validateConfig({ clients: [], users: [{ sub: "1", username: "u", password_hash: "pw" }] })).toThrow(ConfigError);
  });
});

describe("pages", () => {
  it("escapes every dynamic value in the login page", () => {
    const html = loginPage({ clientName: "<script>alert(1)</script>", scope: ['"><img>'], csrfToken: 'a"b', error: "<b>" });
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain('value="a&quot;b"');
  });
});
