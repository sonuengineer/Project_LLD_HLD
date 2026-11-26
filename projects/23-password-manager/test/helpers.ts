import { ManualClock, PasswordManager } from "../src/index.js";

export const T0 = 1_700_000_000_000;

export function setup() {
  const clock = new ManualClock(T0);
  const manager = new PasswordManager({ clock });
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
