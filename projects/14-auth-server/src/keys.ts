// Signing keys. A KeyRing answers two questions: which key signs right now, and which keys are published in
// /jwks (and accepted when this server verifies its own tokens).
//
// FileKeyRing rotates with overlap. Every key goes through three states:
//   next     published in /jwks, does NOT sign yet (so verifiers that cache the JWKS already have it)
//   active   signs new tokens (exactly one)
//   retired  stopped signing at `retiredAt`, still published until every token it signed has expired
// rotate(): active -> retired, next -> active, a fresh key becomes next. A retired key is dropped once
// `retiredAt + retainMs` has passed, where retainMs = the longest token lifetime it could have signed.
// Rotation happens automatically when the active key is older than `rotateAfterMs`, checked whenever a token is
// signed, or explicitly by calling rotate().
//
// The private keys live in `<dataDir>/keys.json` (PKCS#8 PEM, NOT encrypted at rest), generated at first start,
// written with mode 0600 (owner read/write only) via temp file + rename. On Windows the mode is ignored by node
// apart from the read-only bit; protect the directory with NTFS permissions instead.
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { signingKeyFromPem } from "./jwt.js";
import type { SigningKey } from "./jwt.js";

export interface KeyRing {
  /** The key that signs a token issued at `nowMs`. */
  signing(nowMs: number): SigningKey;
  /** Keys published in /jwks and accepted for verification at `nowMs`. */
  published(nowMs: number): SigningKey[];
}

/** Fixed keys (stage 1 behaviour, tests): the first signs, all are published, nothing rotates. */
export class StaticKeyRing implements KeyRing {
  constructor(private readonly keys: SigningKey[]) {
    if (keys.length === 0) throw new Error("at least one key is required");
  }
  signing(): SigningKey {
    return this.keys[0] as SigningKey;
  }
  published(): SigningKey[] {
    return this.keys;
  }
}

export const KEYS_FILE = "keys.json";

interface StoredKey {
  kid: string;
  pem: string;
  createdAt: number;
  activatedAt: number | null;
  retiredAt: number | null;
}

interface LoadedKey extends StoredKey {
  key: SigningKey;
}

export interface FileKeyRingOptions {
  /** Rotate when the active key is this old. Default 30 days. */
  rotateAfterMs?: number;
  /** How long a retired key stays published. Must be >= the longest lifetime of a token it signs. */
  retainMs: number;
  now?: () => number;
}

function newPem(): string {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return privateKey.export({ format: "pem", type: "pkcs8" }).toString();
}

export class FileKeyRing implements KeyRing {
  private keys: LoadedKey[];
  private readonly path: string;
  private readonly rotateAfterMs: number;
  private readonly retainMs: number;

  private constructor(dir: string, keys: LoadedKey[], opts: FileKeyRingOptions) {
    this.path = join(dir, KEYS_FILE);
    this.keys = keys;
    this.rotateAfterMs = opts.rotateAfterMs ?? 30 * 24 * 3600 * 1000;
    this.retainMs = opts.retainMs;
  }

  /** Loads `<dir>/keys.json`, or creates it with an active and a next key. */
  static open(dir: string, opts: FileKeyRingOptions): FileKeyRing {
    const now = (opts.now ?? Date.now)();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, KEYS_FILE);
    let stored: StoredKey[];
    let fresh = false;
    if (existsSync(path)) {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as { keys?: StoredKey[] };
      if (!Array.isArray(parsed.keys)) throw new Error(`${path}: no keys[]`);
      stored = parsed.keys;
    } else {
      fresh = true;
      stored = [
        { kid: "", pem: newPem(), createdAt: now, activatedAt: now, retiredAt: null },
        { kid: "", pem: newPem(), createdAt: now, activatedAt: null, retiredAt: null },
      ];
    }
    const loaded = stored.map((s) => {
      const key = signingKeyFromPem(s.pem);
      if (s.kid !== "" && s.kid !== key.kid) throw new Error(`${path}: kid ${s.kid} does not match its key`);
      return { ...s, kid: key.kid, key };
    });
    const ring = new FileKeyRing(dir, loaded, opts);
    if (ring.keys.filter((k) => ring.state(k) === "active").length !== 1) throw new Error(`${path}: exactly one active key is required`);
    if (fresh) ring.save();
    return ring;
  }

  private state(k: StoredKey): "next" | "active" | "retired" {
    if (k.activatedAt === null) return "next";
    return k.retiredAt === null ? "active" : "retired";
  }

  private active(): LoadedKey {
    return this.keys.find((k) => this.state(k) === "active") as LoadedKey;
  }

  private save(): void {
    const body = JSON.stringify({ keys: this.keys.map(({ kid, pem, createdAt, activatedAt, retiredAt }) => ({ kid, pem, createdAt, activatedAt, retiredAt })) }, null, 1);
    const tmp = `${this.path}.tmp`;
    // Mode 0600 is applied when the temp file is created; rename keeps it.
    const fd = openSync(tmp, "w", 0o600);
    try {
      writeSync(fd, body);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, this.path);
  }

  /** active -> retired, next -> active, new next. Persisted before it takes effect in memory. */
  rotate(nowMs: number): void {
    const before = this.keys;
    let promoted = false;
    const after: LoadedKey[] = before.map((k) => {
      const st = this.state(k);
      if (st === "active") return { ...k, retiredAt: nowMs };
      if (st === "next" && !promoted) {
        promoted = true;
        return { ...k, activatedAt: nowMs };
      }
      return k;
    });
    if (!promoted) {
      // No pre-published key (hand-edited file): activate a new one directly.
      const pem = newPem();
      const key = signingKeyFromPem(pem);
      after.push({ kid: key.kid, pem, createdAt: nowMs, activatedAt: nowMs, retiredAt: null, key });
    }
    const pem = newPem();
    const key = signingKeyFromPem(pem);
    after.push({ kid: key.kid, pem, createdAt: nowMs, activatedAt: null, retiredAt: null, key });
    this.keys = after.filter((k) => !this.expired(k, nowMs));
    try {
      this.save();
    } catch (e) {
      this.keys = before;
      throw e;
    }
  }

  private expired(k: StoredKey, nowMs: number): boolean {
    return k.retiredAt !== null && nowMs >= k.retiredAt + this.retainMs;
  }

  signing(nowMs: number): SigningKey {
    const a = this.active();
    if (a.activatedAt !== null && nowMs - a.activatedAt >= this.rotateAfterMs) this.rotate(nowMs);
    return this.active().key;
  }

  published(nowMs: number): SigningKey[] {
    // Order: active first, then next, then retired. Expired retired keys are simply not listed; they are removed
    // from the file at the next rotation.
    const rank = { active: 0, next: 1, retired: 2 } as const;
    return this.keys
      .filter((k) => !this.expired(k, nowMs))
      .sort((a, b) => rank[this.state(a)] - rank[this.state(b)])
      .map((k) => k.key);
  }

  /** For tests and the startup log line. */
  describe(): { kid: string; state: "next" | "active" | "retired"; retiredAt: number | null }[] {
    return this.keys.map((k) => ({ kid: k.kid, state: this.state(k), retiredAt: k.retiredAt }));
  }
}
