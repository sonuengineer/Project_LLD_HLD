// ES256 JWTs (RFC 7515 / 7519) with node:crypto only. ES256 = ECDSA on P-256 with SHA-256; the JWS signature is
// the raw 64-byte r||s ("ieee-p1363"), NOT the DER encoding node produces by default.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import type { KeyObject } from "node:crypto";

export interface PublicJwk {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
  kid: string;
  use: "sig";
  alg: "ES256";
}

export interface SigningKey {
  kid: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
  publicJwk: PublicJwk;
}

/** RFC 7638 JWK thumbprint: SHA-256 over the required members in lexicographic order, no whitespace. */
export function jwkThumbprint(jwk: { crv: string; kty: string; x: string; y: string }): string {
  const canonical = `{"crv":"${jwk.crv}","kty":"${jwk.kty}","x":"${jwk.x}","y":"${jwk.y}"}`;
  return createHash("sha256").update(canonical, "utf8").digest("base64url");
}

export function signingKeyFromPrivate(privateKey: KeyObject): SigningKey {
  if (privateKey.asymmetricKeyType !== "ec" || privateKey.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
    throw new Error("signing key must be an EC P-256 private key");
  }
  const publicKey = createPublicKey(privateKey);
  const jwk = publicKey.export({ format: "jwk" }) as { crv: string; kty: string; x: string; y: string };
  const kid = jwkThumbprint(jwk);
  return {
    kid,
    privateKey,
    publicKey,
    publicJwk: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, kid, use: "sig", alg: "ES256" },
  };
}

export function generateSigningKey(): SigningKey {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return signingKeyFromPrivate(privateKey);
}

export function signingKeyFromPem(pem: string): SigningKey {
  return signingKeyFromPrivate(createPrivateKey(pem));
}

const b64json = (v: unknown): string => Buffer.from(JSON.stringify(v), "utf8").toString("base64url");

export function signJwt(key: SigningKey, typ: string, payload: Record<string, unknown>): string {
  const header = { alg: "ES256", typ, kid: key.kid };
  const signingInput = `${b64json(header)}.${b64json(payload)}`;
  const sig = sign("sha256", Buffer.from(signingInput, "ascii"), { key: key.privateKey, dsaEncoding: "ieee-p1363" });
  return `${signingInput}.${sig.toString("base64url")}`;
}

export class JwtError extends Error {}

export interface VerifyOptions {
  issuer: string;
  audience: string;
  typ: string;
  nowSeconds: number;
  /** Skip only the exp check (OIDC RP-initiated logout accepts an expired id_token_hint). Everything else is checked. */
  ignoreExpiry?: boolean;
}

/**
 * Verifies an ES256 JWT that THIS server issued. The algorithm is fixed (never taken from the token), so
 * `alg: none` and HS256-with-the-public-key tricks fail before any signature check.
 */
export function verifyJwt(token: string, keys: SigningKey[], opts: VerifyOptions): Record<string, unknown> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new JwtError("malformed token");
  const [h, p, s] = parts as [string, string, string];
  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  try {
    header = JSON.parse(Buffer.from(h, "base64url").toString("utf8")) as Record<string, unknown>;
    payload = JSON.parse(Buffer.from(p, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new JwtError("malformed token");
  }
  if (header.alg !== "ES256") throw new JwtError("unexpected alg");
  if (header.typ !== opts.typ) throw new JwtError("unexpected typ");
  const key = keys.find((k) => k.kid === header.kid);
  if (!key) throw new JwtError("unknown kid");
  const sig = Buffer.from(s, "base64url");
  const ok = sig.length === 64 &&
    verify("sha256", Buffer.from(`${h}.${p}`, "ascii"), { key: key.publicKey, dsaEncoding: "ieee-p1363" }, sig);
  if (!ok) throw new JwtError("bad signature");
  if (payload.iss !== opts.issuer) throw new JwtError("wrong issuer");
  const aud = payload.aud;
  const audOk = typeof aud === "string" ? aud === opts.audience : Array.isArray(aud) && aud.includes(opts.audience);
  if (!audOk) throw new JwtError("wrong audience");
  if (typeof payload.exp !== "number") throw new JwtError("expired");
  if (!opts.ignoreExpiry && opts.nowSeconds >= payload.exp) throw new JwtError("expired");
  return payload;
}

/**
 * OIDC Core 3.1.3.6: at_hash = base64url of the left-most half of the hash of the ASCII access token, using
 * the hash of the id_token's alg (ES256 -> SHA-256 -> first 16 bytes).
 */
export function atHash(accessToken: string): string {
  return createHash("sha256").update(accessToken, "ascii").digest().subarray(0, 16).toString("base64url");
}
