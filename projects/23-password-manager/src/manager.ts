// The core of the project: PasswordManager holds one vault per ownerId. A vault is either locked (no key held
// in memory) or unlocked (the key derived from the last correct master password is held, for calls to use).
//
// The rule carried over from every other project in this repo: an error means nothing happened. The one
// deliberate exception is a WRONG unlock attempt -- recording that attempt (and locking out after enough of
// them) is the entire point of the operation, not a side effect of it.
import { decrypt, deriveKey, encrypt, newSalt, type EncryptedBlob } from "./crypto.js";
import { PasswordManagerError } from "./errors.js";
import { Clock, systemClock } from "./clock.js";
import type { DecryptedEntryBody, EntryDetail, EntryInput, EntrySummary, VaultExport, VaultSummary } from "./types.js";

export const MIN_MASTER_PASSWORD_LENGTH = 8;
export const MAX_MASTER_PASSWORD_LENGTH = 256;
export const MAX_OWNER_ID_LENGTH = 200;
export const MAX_TITLE_LENGTH = 200;
export const MAX_USERNAME_LENGTH = 200;
export const MAX_PASSWORD_LENGTH = 1024;
export const MAX_NOTES_LENGTH = 4096;
export const MAX_FAILED_ATTEMPTS = 5;
export const LOCKOUT_MS = 30_000;

const CANARY_PLAINTEXT = Buffer.from("password-manager-canary-v1", "utf8");

interface StoredEntry {
  id: string;
  blob: EncryptedBlob;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
}

interface VaultRecord {
  ownerId: string;
  createdAt: number;
  salt: Buffer;
  canary: EncryptedBlob;
  entries: Map<string, StoredEntry>;
  nextEntrySeq: number;
  key: Buffer | null; // held only while unlocked
  failedAttempts: number;
  lockedUntil: number | null;
}

export interface PasswordManagerOptions {
  clock?: Clock;
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
  private readonly clock: Clock;

  constructor(options: PasswordManagerOptions = {}) {
    this.clock = options.clock ?? systemClock;
  }

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
      key: null, // locked by default -- creating a vault does not implicitly unlock it
      failedAttempts: 0,
      lockedUntil: null,
    };
    this.vaults.set(ownerId, record);
    return this.toSummary(record);
  }

  unlock(ownerId: string, masterPassword: string): VaultSummary {
    const record = this.requireVault(ownerId);
    record.key = this.verifyMasterPassword(record, masterPassword);
    return this.toSummary(record);
  }

  lock(ownerId: string): void {
    const record = this.requireVault(ownerId);
    record.key = null;
  }

  isUnlocked(ownerId: string): boolean {
    return this.requireVault(ownerId).key !== null;
  }

  getVault(ownerId: string): VaultSummary {
    return this.toSummary(this.requireVault(ownerId));
  }

  addEntry(ownerId: string, input: EntryInput): EntrySummary {
    const record = this.requireVault(ownerId);
    const key = this.requireUnlocked(record);
    const body: DecryptedEntryBody = {
      title: requireString(input.title, "title", MAX_TITLE_LENGTH),
      username: requireString(input.username, "username", MAX_USERNAME_LENGTH),
      password: requireString(input.password, "password", MAX_PASSWORD_LENGTH),
      notes: requireString(input.notes ?? "", "notes", MAX_NOTES_LENGTH, true),
    };
    const blob = encrypt(key, Buffer.from(JSON.stringify(body), "utf8"));
    const now = this.clock.now();
    const stored: StoredEntry = { id: `e${record.nextEntrySeq++}`, blob, createdAt: now, updatedAt: now, lastUsedAt: null };
    record.entries.set(stored.id, stored);
    return this.toSummaryEntry(stored, body);
  }

  getEntry(ownerId: string, entryId: string): EntryDetail {
    const record = this.requireVault(ownerId);
    const key = this.requireUnlocked(record);
    const stored = this.requireEntry(record, entryId);
    const body = this.decryptBody(key, stored.blob);
    stored.lastUsedAt = this.clock.now();
    return { ...this.toSummaryEntry(stored, body), password: body.password, notes: body.notes };
  }

  listEntries(ownerId: string): EntrySummary[] {
    const record = this.requireVault(ownerId);
    const key = this.requireUnlocked(record);
    return [...record.entries.values()].map((stored) => this.toSummaryEntry(stored, this.decryptBody(key, stored.blob)));
  }

  updateEntry(ownerId: string, entryId: string, patch: Partial<EntryInput>): EntrySummary {
    const record = this.requireVault(ownerId);
    const key = this.requireUnlocked(record);
    const stored = this.requireEntry(record, entryId);
    const existing = this.decryptBody(key, stored.blob);
    const merged: DecryptedEntryBody = {
      title: requireString(patch.title ?? existing.title, "title", MAX_TITLE_LENGTH),
      username: requireString(patch.username ?? existing.username, "username", MAX_USERNAME_LENGTH),
      password: requireString(patch.password ?? existing.password, "password", MAX_PASSWORD_LENGTH),
      notes: requireString(patch.notes ?? existing.notes, "notes", MAX_NOTES_LENGTH, true),
    };
    // Every field is validated above before anything is written -- an invalid patch throws with the entry
    // completely untouched.
    stored.blob = encrypt(key, Buffer.from(JSON.stringify(merged), "utf8"));
    stored.updatedAt = this.clock.now();
    return this.toSummaryEntry(stored, merged);
  }

  deleteEntry(ownerId: string, entryId: string): void {
    const record = this.requireVault(ownerId);
    this.requireUnlocked(record);
    this.requireEntry(record, entryId);
    record.entries.delete(entryId);
  }

  // Re-encrypts every entry under a new key, all at once. If anything fails (wrong oldPassword, lockout,
  // an unreadable entry), nothing about the vault changes -- the new salt/canary/entries are only assigned
  // after every entry has been decrypted and re-encrypted successfully.
  changeMasterPassword(ownerId: string, oldPassword: string, newPassword: string): void {
    const record = this.requireVault(ownerId);
    const oldKey = this.verifyMasterPassword(record, oldPassword);
    requireMasterPassword(newPassword);

    const newSaltBuf = newSalt();
    const newKey = deriveKey(newPassword, newSaltBuf);
    const newCanary = encrypt(newKey, CANARY_PLAINTEXT);
    const reEncrypted = new Map<string, StoredEntry>();
    for (const stored of record.entries.values()) {
      const body = this.decryptBody(oldKey, stored.blob);
      reEncrypted.set(stored.id, { ...stored, blob: encrypt(newKey, Buffer.from(JSON.stringify(body), "utf8")) });
    }

    record.salt = newSaltBuf;
    record.canary = newCanary;
    record.entries = reEncrypted;
    record.key = null; // re-authenticate with the new password, the same way a real app re-prompts after this
  }

  // Raw ciphertext only -- never decrypts anything, so it works whether or not the vault is unlocked. A real
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

  private requireUnlocked(record: VaultRecord): Buffer {
    if (record.key === null) throw new PasswordManagerError("VAULT_LOCKED", `vault for ${record.ownerId} is locked`);
    return record.key;
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
    return { ownerId: record.ownerId, createdAt: record.createdAt, unlocked: record.key !== null, entryCount: record.entries.size };
  }

  private toSummaryEntry(stored: StoredEntry, body: DecryptedEntryBody): EntrySummary {
    return {
      id: stored.id,
      title: body.title,
      username: body.username,
      createdAt: stored.createdAt,
      updatedAt: stored.updatedAt,
      lastUsedAt: stored.lastUsedAt,
    };
  }
}
