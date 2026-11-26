import type { EncryptedBlob } from "./crypto.js";

export interface VaultSummary {
  ownerId: string;
  createdAt: number;
  activeSessions: number; // how many devices currently hold a valid, unlocked session
  entryCount: number;
}

export interface UnlockResult extends VaultSummary {
  sessionId: string;
}

export interface EntryInput {
  title: string;
  username: string;
  password: string;
  notes?: string;
}

// What listEntries() returns: enough to find and recognize an entry, never the secret itself.
// breached: true = found in the breach-check provider, false = checked and clean, null = never checked or
// the breach-check service could not be reached (unknown, NOT "assumed safe").
export interface EntrySummary {
  id: string;
  title: string;
  username: string;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
  breached: boolean | null;
}

// What getEntry() returns: everything, including the one field listEntries() withholds.
export interface EntryDetail extends EntrySummary {
  password: string;
  notes: string;
}

// What exportVault() returns: raw ciphertext only. Works without unlocking, on purpose -- a backup of an
// encrypted vault should not itself require knowing the master password.
export interface VaultExport {
  ownerId: string;
  createdAt: number;
  salt: string; // base64
  canary: EncryptedBlob;
  entries: Array<{
    id: string;
    blob: EncryptedBlob;
    createdAt: number;
    updatedAt: number;
    lastUsedAt: number | null;
  }>;
  sharingPublicKey: string | null;
  wrappedPrivateKey: EncryptedBlob | null;
}

// Internal entry shape, decrypted into this before being trimmed down to EntrySummary/EntryDetail.
export interface DecryptedEntryBody {
  title: string;
  username: string;
  password: string;
  notes: string;
  breached: boolean | null;
}
