import { ManualClock, Messenger, type ConversationStore, type MessengerOptions, type PersistedConversation } from "../src/index.js";
import { InMemoryUsers } from "../src/users.js";

export const T0 = Date.UTC(2026, 10, 26, 10, 0);

export function setup(userIds: string[] = ["u1", "u2", "u3", "u4"], options: Partial<MessengerOptions> = {}) {
  const clock = new ManualClock(T0);
  const users = new InMemoryUsers();
  for (const userId of userIds) users.upsert({ userId, displayName: `User ${userId}` });
  let n = 0;
  const messenger = new Messenger({ users, clock, newId: () => `id${++n}`, ...options });
  return { clock, users, messenger };
}

export function errorCode(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return undefined;
}

export async function asyncErrorCode(fn: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await fn();
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return undefined;
}

interface PendingCommit {
  snapshot: PersistedConversation;
  resolve: () => void;
}

// A ConversationStore whose persist() never resolves on its own -- the test resolves each call manually, in
// whatever order it chooses, giving full control over how two concurrent operations interleave. Mirrors
// 23-password-manager's FakeVaultStore (itself mirrored from 17-parking-lot's FakeDevice).
export class FakeConversationStore implements ConversationStore {
  readonly pending: PendingCommit[] = [];

  persist(snapshot: PersistedConversation): Promise<void> {
    return new Promise<void>((resolve) => {
      this.pending.push({ snapshot, resolve });
    });
  }

  // Resolves the OLDEST still-pending call (FIFO), returning the snapshot it was given.
  resolveNext(): PersistedConversation {
    const call = this.pending.shift();
    if (!call) throw new Error("no pending commit to resolve");
    call.resolve();
    return call.snapshot;
  }

  resolveAt(index: number): PersistedConversation {
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
