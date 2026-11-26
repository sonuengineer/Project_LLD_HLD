import { ManualClock, Messenger } from "../src/index.js";
import { InMemoryUsers } from "../src/users.js";

export const T0 = Date.UTC(2026, 10, 26, 10, 0);

export function setup(userIds: string[] = ["u1", "u2", "u3", "u4"]) {
  const clock = new ManualClock(T0);
  const users = new InMemoryUsers();
  for (const userId of userIds) users.upsert({ userId, displayName: `User ${userId}` });
  let n = 0;
  const messenger = new Messenger({ users, clock, newId: () => `id${++n}` });
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
