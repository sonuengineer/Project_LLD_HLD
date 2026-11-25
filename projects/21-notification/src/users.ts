// Where the notifier finds a user's addresses. An interface, because in a real system this is another service or a
// table; the in-memory version is for tests and the demo.
import { NotificationError } from "./errors.js";
import { validateOffset } from "./preferences.js";
import type { Recipient } from "./types.js";

export interface UserDirectory {
  get(userId: string): Recipient | undefined;
  // Stage 3: called when a provider reports a push token as dead (the app was uninstalled). Optional: a directory
  // that cannot change (someone else's service) just keeps the token, and the provider keeps refusing it.
  removePushToken?(userId: string, token: string): boolean;
}

// Stage 3: devices registering and unregistering themselves (the app calls this on start and on logout).
export interface PushTokenRegistry {
  addPushToken(userId: string, token: string): boolean; // false: no such user
  removePushToken(userId: string, token: string): boolean; // false: no such user or token
}

// Users reinstall apps and change phones without unregistering, so stale tokens pile up. A cap with the OLDEST
// dropped keeps the newest devices; a stale token that slips through is removed the first time a provider calls
// it dead.
export const MAX_PUSH_TOKENS = 10;
export const MAX_TOKEN_LENGTH = 4096;

export function checkPushToken(token: unknown): asserts token is string {
  if (typeof token !== "string" || token === "" || token.length > MAX_TOKEN_LENGTH || /\s/.test(token)) {
    throw new NotificationError("INVALID_REQUEST", `a push token is a non-empty string without spaces, at most ${MAX_TOKEN_LENGTH} characters`);
  }
}

export class InMemoryUsers implements UserDirectory, PushTokenRegistry {
  private readonly users = new Map<string, Recipient>();

  upsert(recipient: Recipient): void {
    if (typeof recipient.userId !== "string" || recipient.userId.trim() === "") {
      throw new NotificationError("INVALID_REQUEST", "userId must be a non-empty string");
    }
    if (recipient.utcOffsetMinutes !== undefined) validateOffset(recipient.utcOffsetMinutes);
    if (recipient.pushTokens !== undefined) {
      if (!Array.isArray(recipient.pushTokens)) throw new NotificationError("INVALID_REQUEST", "pushTokens must be a list");
      recipient.pushTokens.forEach(checkPushToken);
      if (new Set(recipient.pushTokens).size > MAX_PUSH_TOKENS) {
        throw new NotificationError("INVALID_REQUEST", `at most ${MAX_PUSH_TOKENS} push tokens per user`);
      }
    }
    this.users.set(recipient.userId, copy(recipient));
  }

  get(userId: string): Recipient | undefined {
    const found = this.users.get(userId);
    return found ? copy(found) : undefined;
  }

  // Registering a token again moves it to the newest place (the device is alive). Over the cap, the oldest goes.
  addPushToken(userId: string, token: string): boolean {
    checkPushToken(token);
    const user = this.users.get(userId);
    if (!user) return false;
    const tokens = (user.pushTokens ?? []).filter((t) => t !== token);
    tokens.push(token);
    user.pushTokens = tokens.slice(-MAX_PUSH_TOKENS);
    return true;
  }

  removePushToken(userId: string, token: string): boolean {
    const user = this.users.get(userId);
    if (!user?.pushTokens?.includes(token)) return false;
    user.pushTokens = user.pushTokens.filter((t) => t !== token);
    return true;
  }
}

// The list is copied too: a caller changing the array it got back must not change the stored user.
function copy(recipient: Recipient): Recipient {
  const out: Recipient = { ...recipient };
  if (recipient.pushTokens) out.pushTokens = [...new Set(recipient.pushTokens)];
  return out;
}
