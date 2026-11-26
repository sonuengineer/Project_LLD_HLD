import { ManualClock, PasswordManager, type PasswordManagerOptions, type PersistedVault, type VaultStore } from "../src/index.js";

export const T0 = 1_700_000_000_000;

export function setup(options: Partial<PasswordManagerOptions> = {}) {
  const clock = new ManualClock(T0);
  const manager = new PasswordManager({ clock, ...options });
  return { manager, clock };
}

export function errorCode(fn: () => unknown): string {
  try {
    fn();
    return "NO_ERROR";
  } catch (err) {
    return (err as { code?: string }).code ?? "UNKNOWN_ERROR";
  }
}

export async function asyncErrorCode(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return "NO_ERROR";
  } catch (err) {
    return (err as { code?: string }).code ?? "UNKNOWN_ERROR";
  }
}

interface PendingCommit {
  snapshot: PersistedVault;
  resolve: () => void;
  reject: (err: unknown) => void;
}

// A VaultStore whose persist() never resolves on its own -- the test resolves/rejects each call manually, in
// whatever order it chooses, giving full control over how two concurrent operations interleave. Mirrors
// 17-parking-lot's FakeDevice.
export class FakeVaultStore implements VaultStore {
  readonly pending: PendingCommit[] = [];

  persist(snapshot: PersistedVault, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const call: PendingCommit = { snapshot, resolve, reject };
      this.pending.push(call);
      // A timed-out call must not linger in `pending` -- otherwise a later resolveNext()/resolveAt() would
      // grab this already-settled call instead of a genuinely still-pending one.
      signal.addEventListener(
        "abort",
        () => {
          const i = this.pending.indexOf(call);
          if (i !== -1) this.pending.splice(i, 1);
          reject(new Error("aborted"));
        },
        { once: true },
      );
    });
  }

  // Resolves the OLDEST still-pending call (FIFO), returning the snapshot it was given.
  resolveNext(): PersistedVault {
    const call = this.pending.shift();
    if (!call) throw new Error("no pending commit to resolve");
    call.resolve();
    return call.snapshot;
  }

  resolveAt(index: number): PersistedVault {
    const call = this.pending[index];
    if (!call) throw new Error(`no pending commit at index ${index}`);
    this.pending.splice(index, 1);
    call.resolve();
    return call.snapshot;
  }
}

// Lets pending microtasks (e.g. the synchronous part of an async function up to its first await) run before
// the test inspects or resolves anything.
export function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
