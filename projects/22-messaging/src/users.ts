// Where the Messenger finds whether a user exists. An interface, because in a real system this is another
// service or a table; the in-memory version is for tests and the demo.
import { MessagingError } from "./errors.js";
import type { User } from "./types.js";

export interface UserDirectory {
  get(userId: string): User | undefined;
}

export class InMemoryUsers implements UserDirectory {
  private readonly users = new Map<string, User>();

  upsert(user: User): void {
    if (typeof user.userId !== "string" || user.userId.trim() === "") {
      throw new MessagingError("INVALID_REQUEST", "userId must be a non-empty string");
    }
    if (typeof user.displayName !== "string" || user.displayName.trim() === "") {
      throw new MessagingError("INVALID_REQUEST", "displayName must be a non-empty string");
    }
    this.users.set(user.userId, { ...user });
  }

  get(userId: string): User | undefined {
    const found = this.users.get(userId);
    return found ? { ...found } : undefined;
  }
}
