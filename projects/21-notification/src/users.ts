// Where the notifier finds a user's addresses. An interface, because in a real system this is another service or a
// table; the in-memory version is for tests and the demo.
import { NotificationError } from "./errors.js";
import { validateOffset } from "./preferences.js";
import type { Recipient } from "./types.js";

export interface UserDirectory {
  get(userId: string): Recipient | undefined;
}

export class InMemoryUsers implements UserDirectory {
  private readonly users = new Map<string, Recipient>();

  upsert(recipient: Recipient): void {
    if (typeof recipient.userId !== "string" || recipient.userId.trim() === "") {
      throw new NotificationError("INVALID_REQUEST", "userId must be a non-empty string");
    }
    if (recipient.utcOffsetMinutes !== undefined) validateOffset(recipient.utcOffsetMinutes);
    this.users.set(recipient.userId, { ...recipient });
  }

  get(userId: string): Recipient | undefined {
    const found = this.users.get(userId);
    return found ? { ...found } : undefined;
  }
}
