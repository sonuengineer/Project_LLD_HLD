// Storage behind small interfaces. Stage 1 keeps everything in memory (lost on restart, one process only).
// A database implementation must keep the same guarantees, the important one being that `consume` and
// `markUsed` are ATOMIC (in SQL: UPDATE ... SET used = true WHERE hash = $1 AND used = false, check row count).
// Secrets (codes, refresh tokens) are stored only as SHA-256 hashes; the map keys are those hashes.

/** A login in progress: the validated /authorize request, waiting for the user to submit the login form. */
export interface LoginTransaction {
  id: string;
  csrfToken: string;
  clientId: string;
  redirectUri: string;
  scope: string[];
  state?: string;
  nonce?: string;
  codeChallenge: string;
  expiresAt: number;
}

export interface AuthorizationCode {
  codeHash: string;
  clientId: string;
  redirectUri: string;
  sub: string;
  scope: string[];
  nonce?: string;
  codeChallenge: string;
  authTime: number;
  expiresAt: number;
  /** The token family created when this code was redeemed; revoked if the code is ever presented again. */
  familyId?: string;
}

export type ConsumeResult =
  | { kind: "missing" }
  | { kind: "ok"; code: AuthorizationCode }
  | { kind: "reused"; code: AuthorizationCode };

/** Everything issued from one authorization code: its access tokens and its chain of rotated refresh tokens. */
export interface TokenFamily {
  id: string;
  clientId: string;
  sub: string;
  scope: string[];
  authTime: number;
  revoked: boolean;
}

export interface RefreshToken {
  tokenHash: string;
  familyId: string;
  clientId: string;
  expiresAt: number;
  /** true once it has been exchanged; presenting it again is reuse. */
  used: boolean;
}

export interface TransactionStore {
  save(tx: LoginTransaction): void;
  get(id: string): LoginTransaction | undefined;
  delete(id: string): void;
}

export interface CodeStore {
  save(code: AuthorizationCode): void;
  /** Atomically marks the code used. The first call returns ok, every later call returns reused. */
  consume(codeHash: string): ConsumeResult;
  setFamily(codeHash: string, familyId: string): void;
}

export interface TokenStore {
  createFamily(f: TokenFamily): void;
  getFamily(id: string): TokenFamily | undefined;
  revokeFamily(id: string): void;
  saveRefresh(t: RefreshToken): void;
  getRefresh(tokenHash: string): RefreshToken | undefined;
  /** Atomically marks a refresh token used. Returns false if it was already used. */
  markUsed(tokenHash: string): boolean;
  /** Remembers which family an access token (by jti) belongs to, so /userinfo can honour revocation. */
  recordAccessToken(jti: string, familyId: string): void;
  familyOfAccessToken(jti: string): string | undefined;
}

export interface Stores {
  transactions: TransactionStore;
  codes: CodeStore;
  tokens: TokenStore;
}

export class MemoryTransactionStore implements TransactionStore {
  private readonly m = new Map<string, LoginTransaction>();
  save(tx: LoginTransaction): void {
    this.m.set(tx.id, tx);
  }
  get(id: string): LoginTransaction | undefined {
    return this.m.get(id);
  }
  delete(id: string): void {
    this.m.delete(id);
  }
}

export class MemoryCodeStore implements CodeStore {
  private readonly m = new Map<string, { code: AuthorizationCode; used: boolean }>();
  save(code: AuthorizationCode): void {
    this.m.set(code.codeHash, { code, used: false });
  }
  consume(codeHash: string): ConsumeResult {
    const e = this.m.get(codeHash);
    if (!e) return { kind: "missing" };
    if (e.used) return { kind: "reused", code: e.code };
    // Check-and-set in one synchronous step: no other request can run in between on Node's single thread.
    e.used = true;
    return { kind: "ok", code: e.code };
  }
  setFamily(codeHash: string, familyId: string): void {
    const e = this.m.get(codeHash);
    if (e) e.code.familyId = familyId;
  }
}

export class MemoryTokenStore implements TokenStore {
  private readonly families = new Map<string, TokenFamily>();
  private readonly refresh = new Map<string, RefreshToken>();
  private readonly access = new Map<string, string>();
  createFamily(f: TokenFamily): void {
    this.families.set(f.id, f);
  }
  getFamily(id: string): TokenFamily | undefined {
    return this.families.get(id);
  }
  revokeFamily(id: string): void {
    const f = this.families.get(id);
    if (f) f.revoked = true;
  }
  saveRefresh(t: RefreshToken): void {
    this.refresh.set(t.tokenHash, t);
  }
  getRefresh(tokenHash: string): RefreshToken | undefined {
    return this.refresh.get(tokenHash);
  }
  markUsed(tokenHash: string): boolean {
    const t = this.refresh.get(tokenHash);
    if (!t || t.used) return false;
    t.used = true;
    return true;
  }
  recordAccessToken(jti: string, familyId: string): void {
    this.access.set(jti, familyId);
  }
  familyOfAccessToken(jti: string): string | undefined {
    return this.access.get(jti);
  }
}

export function memoryStores(): Stores {
  return { transactions: new MemoryTransactionStore(), codes: new MemoryCodeStore(), tokens: new MemoryTokenStore() };
}
