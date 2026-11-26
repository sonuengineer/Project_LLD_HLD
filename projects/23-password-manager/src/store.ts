// The one async dependency in this project: durably saving a vault's ciphertext somewhere (a disk, a network
// service). Nothing here ever sees a plaintext secret -- a PersistedVault is exactly the shape exportVault()
// already returns.
import type { EncryptedBlob } from "./crypto.js";

export interface PersistedEntry {
  id: string;
  blob: EncryptedBlob;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
}

export interface PersistedVault {
  ownerId: string;
  createdAt: number;
  salt: string; // base64
  canary: EncryptedBlob;
  entries: PersistedEntry[];
}

export interface VaultStore {
  persist(snapshot: PersistedVault, signal: AbortSignal): Promise<void>;
}

// The default store: an in-memory sink that resolves on the next microtask, standing in for a fast real
// write. It still genuinely yields control, so two concurrent operations really do interleave around it --
// nothing here assumes the write is synchronous, which is the whole point of stage 2.
export class InMemoryVaultStore implements VaultStore {
  private readonly snapshots = new Map<string, PersistedVault>();

  async persist(snapshot: PersistedVault, signal: AbortSignal): Promise<void> {
    await Promise.resolve();
    if (signal.aborted) throw new Error("aborted");
    this.snapshots.set(snapshot.ownerId, snapshot);
  }

  // Test/inspection only: what was last durably saved for this owner (or undefined if nothing ever was).
  lastPersisted(ownerId: string): PersistedVault | undefined {
    return this.snapshots.get(ownerId);
  }
}
