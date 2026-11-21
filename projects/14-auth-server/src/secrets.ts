// Everything that creates, hashes or compares a secret lives here, so it is easy to check that every
// comparison of a secret is constant-time.
import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";

/** A random, URL-safe secret (authorization codes, refresh tokens, CSRF tokens, ids). 32 bytes = 256 bits. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** SHA-256 as base64url. Used to store high-entropy server-generated secrets (codes, refresh tokens). */
export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("base64url");
}

/**
 * Constant-time string comparison. Both sides are hashed first so the comparison takes the same time
 * whatever the lengths are (timingSafeEqual itself throws on different lengths).
 */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

// ---- scrypt password / client secret hashing ----------------------------------------------------------------

export interface ScryptParams {
  N: number;
  r: number;
  p: number;
}

/** OWASP Password Storage Cheat Sheet minimum for scrypt: N=2^17, r=8, p=1 (about 128 MiB per hash). */
export const DEFAULT_SCRYPT: ScryptParams = { N: 2 ** 17, r: 8, p: 1 };
const KEY_LEN = 32;
const SALT_LEN = 16;

function scrypt(secret: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  // maxmem must exceed 128 * N * r bytes or node refuses the parameters.
  const maxmem = 128 * params.N * params.r + 16 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    scryptCb(secret, salt, KEY_LEN, { N: params.N, r: params.r, p: params.p, maxmem }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

/** Format: `scrypt$N$r$p$<salt base64url>$<hash base64url>`. The parameters travel with the hash. */
export async function hashSecret(secret: string, params: ScryptParams = DEFAULT_SCRYPT): Promise<string> {
  const salt = randomBytes(SALT_LEN);
  const key = await scrypt(secret, salt, params);
  return `scrypt$${params.N}$${params.r}$${params.p}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

interface ParsedHash {
  params: ScryptParams;
  salt: Buffer;
  key: Buffer;
}

export function parseSecretHash(stored: string): ParsedHash {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") throw new Error("not a scrypt hash");
  const [N, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  // Bounds stop a hostile config from asking for gigabytes of memory per login.
  const okN = Number.isInteger(N) && N >= 2 ** 10 && N <= 2 ** 20 && (N & (N - 1)) === 0;
  if (!okN || !Number.isInteger(r) || r < 1 || r > 32 || !Number.isInteger(p) || p < 1 || p > 16) {
    throw new Error("scrypt parameters out of range");
  }
  const salt = Buffer.from(parts[4] ?? "", "base64url");
  const key = Buffer.from(parts[5] ?? "", "base64url");
  if (salt.length < 8 || key.length !== KEY_LEN) throw new Error("bad salt or hash length");
  return { params: { N, r, p }, salt, key };
}

export async function verifySecret(secret: string, stored: string): Promise<boolean> {
  const parsed = parseSecretHash(stored);
  const key = await scrypt(secret, parsed.salt, parsed.params);
  return timingSafeEqual(key, parsed.key);
}

/**
 * Burn the same scrypt work when the user does not exist, so "unknown user" and "wrong password" take about
 * the same time (no user enumeration by timing). The result is always false.
 */
export async function verifyAgainstDummy(secret: string, params: ScryptParams): Promise<false> {
  await scrypt(secret, Buffer.alloc(SALT_LEN), params);
  return false;
}

// ---- PKCE (RFC 7636) ----------------------------------------------------------------------------------------

/** code_verifier: 43-128 chars of [A-Z a-z 0-9 - . _ ~] (RFC 7636 section 4.1). */
export const VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;
/** S256 challenge = base64url(sha256(verifier)) = exactly 43 chars without padding. */
export const CHALLENGE_RE = /^[A-Za-z0-9\-_]{43}$/;

export function s256(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

export function pkceMatches(verifier: string, challenge: string): boolean {
  if (!VERIFIER_RE.test(verifier)) return false;
  return safeEqual(s256(verifier), challenge);
}
