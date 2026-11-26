// The core of the project. Stage 1 had one vault per ownerId, locked or unlocked as a single whole. Stage 2
// allows several devices to hold their own unlocked session on the SAME vault at once, and makes saving an
// entry a real async call to a VaultStore (a disk, a network service) -- which is where two devices can
// genuinely race each other.
//
// Every mutating operation now follows the same shape, mirrored from 17-parking-lot's reserve/confirm: a
// SYNCHRONOUS claim (so the race is prevented by construction -- JS cannot preempt synchronous code), one
// await across the store call, then a synchronous apply (success) or release (failure). Nothing is ever
// applied to the vault until its store write has actually succeeded.
//
// The rule carried over from every other project in this repo: an error means nothing happened. The
// deliberate exceptions are a WRONG unlock/changeMasterPassword attempt (recording it is the point of
// lockout) and ENTRY_CONFLICT/VAULT_BUSY (the whole point of those is "someone else got there first, and we
// are telling you instead of silently losing your change").
import { decrypt, deriveKey, encrypt, newSalt, type EncryptedBlob } from "./crypto.js";
import { PasswordManagerError } from "./errors.js";
import { Clock, systemClock } from "./clock.js";
import { InMemoryVaultStore, type PersistedVault, type VaultStore } from "./store.js";
import { withTimeout } from "./timeout.js";
import { BreachChecker, type BreachCheckerOptions } from "./breach-checker.js";
import type { DecryptedEntryBody, EntryDetail, EntryInput, EntrySummary, UnlockResult, VaultExport, VaultSummary } from "./types.js";

export const MIN_MASTER_PASSWORD_LENGTH = 8;
export const MAX_MASTER_PASSWORD_LENGTH = 256;
export const MAX_OWNER_ID_LENGTH = 200;
export const MAX_TITLE_LENGTH = 200;
export const MAX_USERNAME_LENGTH = 200;
export const MAX_PASSWORD_LENGTH = 1024;
export const MAX_NOTES_LENGTH = 4096;
export const MAX_FAILED_ATTEMPTS = 5;
export const LOCKOUT_MS = 30_000;
export const DEFAULT_COMMIT_TIMEOUT_MS = 5_000;

const CANARY_PLAINTEXT = Buffer.from("password-manager-canary-v1", "utf8");

interface StoredEntry {
  id: string;
  blob: EncryptedBlob;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
  version: number; // bumped on every successful update; lets a concurrent update detect it lost the race
}

interface VaultRecord {
  ownerId: string;
  createdAt: number;
  salt: Buffer;
  canary: EncryptedBlob;
  entries: Map<string, StoredEntry>;
  nextEntrySeq: number;
  failedAttempts: number;
  lockedUntil: number | null;
  generation: number; // bumped on every successful changeMasterPassword; invalidates other sessions
  rotating: boolean; // true while a changeMasterPassword commit is in flight -- excludes entry ops
  pendingEntryOps: number; // count of in-flight add/update/delete commits -- excludes rotation
}

interface Session {
  sessionId: string;
  ownerId: string;
  key: Buffer;
  generation: number; // the vault's generation at the moment this session unlocked
}

export interface PasswordManagerOptions {
  clock?: Clock;
  store?: VaultStore;
  commitTimeoutMs?: number;
  breachChecker?: BreachChecker;
  breachCheckerOptions?: BreachCheckerOptions;
}

function requireString(value: unknown, field: string, max: number, allowEmpty = false): string {
  if (typeof value !== "string") throw new PasswordManagerError("INVALID_REQUEST", `${field} must be a string`);
  if (!allowEmpty && value.trim() === "") throw new PasswordManagerError("INVALID_REQUEST", `${field} must not be empty`);
  if (value.length > max) throw new PasswordManagerError("INVALID_REQUEST", `${field} must be at most ${max} characters`);
  return value;
}

function requireMasterPassword(value: unknown): string {
  if (typeof value !== "string" || value.length < MIN_MASTER_PASSWORD_LENGTH || value.length > MAX_MASTER_PASSWORD_LENGTH) {
    throw new PasswordManagerError(
      "INVALID_REQUEST",
      `masterPassword must be a string between ${MIN_MASTER_PASSWORD_LENGTH} and ${MAX_MASTER_PASSWORD_LENGTH} characters`,
    );
  }
  return value;
}

export class PasswordManager {
  private readonly vaults = new Map<string, VaultRecord>();
  private readonly sessions = new Map<string, Session>();
  private readonly clock: Clock;
  private readonly store: VaultStore;
  private readonly commitTimeoutMs: number;
  private readonly breachChecker: BreachChecker;
  private nextSessionSeq = 1;

  constructor(options: PasswordManagerOptions = {}) {
    this.clock = options.clock ?? systemClock;
    this.store = options.store ?? new InMemoryVaultStore();
    this.commitTimeoutMs = options.commitTimeoutMs ?? DEFAULT_COMMIT_TIMEOUT_MS;
    this.breachChecker = options.breachChecker ?? new BreachChecker(options.breachCheckerOptions);
  }

  // A standalone utility, like generatePassword(): no vault or session needed. Never throws -- see
  // BreachChecker's own doc comment for why.
  async checkBreach(password: string): Promise<boolean | null> {
    requireString(password, "password", MAX_PASSWORD_LENGTH);
    return this.breachChecker.check(password);
  }

  // Synchronous and store-free: nothing can race the creation of a vault that does not exist yet.
  createVault(ownerId: string, masterPassword: string): VaultSummary {
    requireString(ownerId, "ownerId", MAX_OWNER_ID_LENGTH);
    requireMasterPassword(masterPassword);
    if (this.vaults.has(ownerId)) throw new PasswordManagerError("VAULT_ALREADY_EXISTS", `a vault already exists for ${ownerId}`);

    const salt = newSalt();
    const key = deriveKey(masterPassword, salt);
    const canary = encrypt(key, CANARY_PLAINTEXT);
    const record: VaultRecord = {
      ownerId,
      createdAt: this.clock.now(),
      salt,
      canary,
      entries: new Map(),
      nextEntrySeq: 1,
      failedAttempts: 0,
      lockedUntil: null,
      generation: 0,
      rotating: false,
      pendingEntryOps: 0,
    };
    this.vaults.set(ownerId, record);
    return this.toSummary(record);
  }

  // Unlocking is synchronous (it never writes to the store) and returns a fresh sessionId. Several devices
  // can each unlock the same vault and hold their own session; locking one does not touch the others.
  unlock(ownerId: string, masterPassword: string): UnlockResult {
    const record = this.requireVault(ownerId);
    const key = this.verifyMasterPassword(record, masterPassword);
    const sessionId = `sess${this.nextSessionSeq++}`;
    this.sessions.set(sessionId, { sessionId, ownerId, key, generation: record.generation });
    return { sessionId, ...this.toSummary(record) };
  }

  lock(sessionId: string): void {
    if (!this.sessions.delete(sessionId)) {
      throw new PasswordManagerError("UNKNOWN_SESSION", `no active session ${sessionId}`);
    }
  }

  // Alive AND still current -- a session whose vault has since changed its master password is not active,
  // even though lock() was never called on it.
  isSessionActive(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    const record = this.vaults.get(session.ownerId);
    return !!record && record.generation === session.generation;
  }

  getVault(ownerId: string): VaultSummary {
    return this.toSummary(this.requireVault(ownerId));
  }

  async addEntry(sessionId: string, input: EntryInput): Promise<EntrySummary> {
    const session = this.requireSession(sessionId);
    const record = this.requireVault(session.ownerId);
    const password = requireString(input.password, "password", MAX_PASSWORD_LENGTH);
    // Kicked off now (its clock starts ticking during the rest of this function's validation) but not
    // awaited yet -- claimEntryOp below must still run synchronously, with no await ahead of it, exactly
    // like every other claim in this project.
    const breachCheck = this.breachChecker.check(password);
    const partialBody = {
      title: requireString(input.title, "title", MAX_TITLE_LENGTH),
      username: requireString(input.username, "username", MAX_USERNAME_LENGTH),
      password,
      notes: requireString(input.notes ?? "", "notes", MAX_NOTES_LENGTH, true),
    };

    this.claimEntryOp(record); // synchronous: fails fast if a rotation is in progress
    try {
      // A flaky breach-check service never holds this claim open longer than its own timeout, and
      // BreachChecker.check() never throws, so it cannot fail this save either way.
      const body: DecryptedEntryBody = { ...partialBody, breached: await breachCheck };
      // The id is allocated now, synchronously, so two concurrent adds can never collide.
      const now = this.clock.now();
      const stored: StoredEntry = {
        id: `e${record.nextEntrySeq++}`,
        blob: encrypt(session.key, Buffer.from(JSON.stringify(body), "utf8")),
        createdAt: now,
        updatedAt: now,
        lastUsedAt: null,
        version: 1,
      };
      await this.commit(record, [...record.entries.values(), stored]);
      record.entries.set(stored.id, stored); // only applied after the store confirms it
      return this.toSummaryEntry(stored, body);
    } finally {
      record.pendingEntryOps--;
    }
  }

  getEntry(sessionId: string, entryId: string): EntryDetail {
    const session = this.requireSession(sessionId);
    const record = this.requireVault(session.ownerId);
    const stored = this.requireEntry(record, entryId);
    const body = this.decryptBody(session.key, stored.blob);
    stored.lastUsedAt = this.clock.now();
    return { ...this.toSummaryEntry(stored, body), password: body.password, notes: body.notes };
  }

  listEntries(sessionId: string): EntrySummary[] {
    const session = this.requireSession(sessionId);
    const record = this.requireVault(session.ownerId);
    return [...record.entries.values()].map((stored) => this.toSummaryEntry(stored, this.decryptBody(session.key, stored.blob)));
  }

  async updateEntry(sessionId: string, entryId: string, patch: Partial<EntryInput>): Promise<EntrySummary> {
    const session = this.requireSession(sessionId);
    const record = this.requireVault(session.ownerId);

    this.claimEntryOp(record);
    try {
      const stored = this.requireEntry(record, entryId);
      const expectedVersion = stored.version;
      const existing = this.decryptBody(session.key, stored.blob);
      const newPassword = requireString(patch.password ?? existing.password, "password", MAX_PASSWORD_LENGTH);
      // Only re-check breach status when the password actually changed -- re-checking an unchanged password
      // would just burn a call against the breach-check service for no new information.
      const breached = patch.password !== undefined ? await this.breachChecker.check(newPassword) : existing.breached;
      const merged: DecryptedEntryBody = {
        title: requireString(patch.title ?? existing.title, "title", MAX_TITLE_LENGTH),
        username: requireString(patch.username ?? existing.username, "username", MAX_USERNAME_LENGTH),
        password: newPassword,
        notes: requireString(patch.notes ?? existing.notes, "notes", MAX_NOTES_LENGTH, true),
        breached,
      };
      const newBlob = encrypt(session.key, Buffer.from(JSON.stringify(merged), "utf8"));
      const updated: StoredEntry = { ...stored, blob: newBlob, updatedAt: this.clock.now(), version: expectedVersion + 1 };

      await this.commit(record, [...record.entries.values()].map((e) => (e.id === entryId ? updated : e)));

      // Re-check AFTER the await: another update or delete may have landed on this same entry while this one
      // was in flight. If so, this one lost the race -- its (already-persisted) write is discarded, not
      // silently applied over the winner's.
      const current = record.entries.get(entryId);
      if (!current) throw new PasswordManagerError("UNKNOWN_ENTRY", `entry ${entryId} was deleted while this update was in flight`);
      if (current.version !== expectedVersion) {
        throw new PasswordManagerError("ENTRY_CONFLICT", `entry ${entryId} was changed by another operation first`);
      }
      record.entries.set(entryId, updated);
      return this.toSummaryEntry(updated, merged);
    } finally {
      record.pendingEntryOps--;
    }
  }

  async deleteEntry(sessionId: string, entryId: string): Promise<void> {
    const session = this.requireSession(sessionId);
    const record = this.requireVault(session.ownerId);

    this.claimEntryOp(record);
    try {
      this.requireEntry(record, entryId);
      await this.commit(record, [...record.entries.values()].filter((e) => e.id !== entryId));
      if (!record.entries.has(entryId)) {
        throw new PasswordManagerError("UNKNOWN_ENTRY", `no entry ${entryId} in vault for ${record.ownerId}`);
      }
      record.entries.delete(entryId);
    } finally {
      record.pendingEntryOps--;
    }
  }

  // Re-encrypts every entry under a new key, all at once, as one store commit. Nothing about the vault is
  // touched until that commit succeeds. Excludes (and is excluded by) any in-flight add/update/delete, so a
  // concurrently-added entry can never be silently dropped by this swapping in a stale snapshot.
  async changeMasterPassword(ownerId: string, oldPassword: string, newPassword: string): Promise<void> {
    const record = this.requireVault(ownerId);
    const oldKey = this.verifyMasterPassword(record, oldPassword);
    requireMasterPassword(newPassword);

    if (record.rotating) throw new PasswordManagerError("VAULT_BUSY", `vault for ${ownerId} is already rotating its master password`);
    if (record.pendingEntryOps > 0) throw new PasswordManagerError("VAULT_BUSY", `vault for ${ownerId} has an entry operation in flight`);
    record.rotating = true;
    try {
      const newSaltBuf = newSalt();
      const newKey = deriveKey(newPassword, newSaltBuf);
      const newCanary = encrypt(newKey, CANARY_PLAINTEXT);
      const reEncrypted = new Map<string, StoredEntry>();
      for (const stored of record.entries.values()) {
        const body = this.decryptBody(oldKey, stored.blob);
        reEncrypted.set(stored.id, { ...stored, blob: encrypt(newKey, Buffer.from(JSON.stringify(body), "utf8")) });
      }

      await this.commit({ ...record, salt: newSaltBuf, canary: newCanary }, [...reEncrypted.values()]);

      record.salt = newSaltBuf;
      record.canary = newCanary;
      record.entries = reEncrypted;
      record.generation++; // every other session's captured generation is now stale -- SESSION_INVALIDATED
    } finally {
      record.rotating = false;
    }
  }

  // Raw ciphertext only -- never decrypts anything, so it works whether or not any session is active. A real
  // "export my encrypted vault file" feature works the same way.
  exportVault(ownerId: string): VaultExport {
    const record = this.requireVault(ownerId);
    return {
      ownerId: record.ownerId,
      createdAt: record.createdAt,
      salt: record.salt.toString("base64"),
      canary: { ...record.canary },
      entries: [...record.entries.values()].map((e) => ({
        id: e.id,
        blob: { ...e.blob },
        createdAt: e.createdAt,
        updatedAt: e.updatedAt,
        lastUsedAt: e.lastUsedAt,
      })),
    };
  }

  // The synchronous half of the claim: must run before any await, so two concurrent entry ops either both
  // proceed (fine -- they touch independent ids, or detect their own conflict via version) or a rotation in
  // progress rejects them immediately, with nothing yet changed.
  private claimEntryOp(record: VaultRecord): void {
    if (record.rotating) throw new PasswordManagerError("VAULT_BUSY", `vault for ${record.ownerId} is rotating its master password`);
    record.pendingEntryOps++;
  }

  private async commit(record: VaultRecord, entries: StoredEntry[]): Promise<void> {
    const snapshot: PersistedVault = {
      ownerId: record.ownerId,
      createdAt: record.createdAt,
      salt: record.salt.toString("base64"),
      canary: record.canary,
      entries: entries.map((e) => ({ id: e.id, blob: e.blob, createdAt: e.createdAt, updatedAt: e.updatedAt, lastUsedAt: e.lastUsedAt })),
    };
    await withTimeout((signal) => this.store.persist(snapshot, signal), this.commitTimeoutMs);
  }

  // Shared by unlock() and changeMasterPassword(): both are a "prove you know the master password" check, and
  // both must count against the same lockout -- otherwise changeMasterPassword would be an unrated side door
  // for guessing the password.
  private verifyMasterPassword(record: VaultRecord, candidate: string): Buffer {
    if (record.lockedUntil !== null) {
      if (this.clock.now() < record.lockedUntil) {
        throw new PasswordManagerError("LOCKED_OUT", `too many wrong attempts; try again after ${record.lockedUntil}`);
      }
      record.lockedUntil = null;
      record.failedAttempts = 0;
    }
    requireMasterPassword(candidate);
    const candidateKey = deriveKey(candidate, record.salt);
    try {
      decrypt(candidateKey, record.canary);
    } catch {
      record.failedAttempts++;
      if (record.failedAttempts >= MAX_FAILED_ATTEMPTS) {
        record.lockedUntil = this.clock.now() + LOCKOUT_MS;
      }
      throw new PasswordManagerError("INVALID_MASTER_PASSWORD", "wrong master password");
    }
    record.failedAttempts = 0;
    record.lockedUntil = null;
    return candidateKey;
  }

  private requireVault(ownerId: string): VaultRecord {
    const record = this.vaults.get(ownerId);
    if (!record) throw new PasswordManagerError("UNKNOWN_OWNER", `no vault exists for ${ownerId}`);
    return record;
  }

  private requireSession(sessionId: string): Session {
    const session = this.sessions.get(sessionId);
    if (!session) throw new PasswordManagerError("UNKNOWN_SESSION", `no active session ${sessionId}`);
    const record = this.vaults.get(session.ownerId);
    if (!record || record.generation !== session.generation) {
      this.sessions.delete(sessionId); // lazy cleanup: this session can never become valid again
      throw new PasswordManagerError("SESSION_INVALIDATED", "the master password changed since this session unlocked; unlock again");
    }
    return session;
  }

  private requireEntry(record: VaultRecord, entryId: string): StoredEntry {
    const stored = record.entries.get(entryId);
    if (!stored) throw new PasswordManagerError("UNKNOWN_ENTRY", `no entry ${entryId} in vault for ${record.ownerId}`);
    return stored;
  }

  private decryptBody(key: Buffer, blob: EncryptedBlob): DecryptedEntryBody {
    return JSON.parse(decrypt(key, blob).toString("utf8")) as DecryptedEntryBody;
  }

  private toSummary(record: VaultRecord): VaultSummary {
    let activeSessions = 0;
    for (const session of this.sessions.values()) {
      if (session.ownerId === record.ownerId && session.generation === record.generation) activeSessions++;
    }
    return { ownerId: record.ownerId, createdAt: record.createdAt, activeSessions, entryCount: record.entries.size };
  }

  private toSummaryEntry(stored: StoredEntry, body: DecryptedEntryBody): EntrySummary {
    return {
      id: stored.id,
      title: body.title,
      username: body.username,
      createdAt: stored.createdAt,
      updatedAt: stored.updatedAt,
      lastUsedAt: stored.lastUsedAt,
      breached: body.breached,
    };
  }
}
