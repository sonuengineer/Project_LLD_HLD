// The k-anonymity protocol real breach-check services use (Have I Been Pwned's password API is the
// well-known example): the caller never sends the password, or even its full hash -- only the first 5 hex
// characters of its SHA-1. The service returns every breached hash sharing that prefix; the caller compares
// the remaining suffix locally. The provider below is a small, fixed, clearly-fake in-memory dataset -- NOT a
// real breach database and NOT a real network call -- but it speaks the real protocol, which is the part
// worth testing: the exact value sent out must never be more than 5 characters.
import { createHash } from "node:crypto";

export interface BreachProvider {
  // `prefix` is always exactly 5 uppercase hex characters. Returns the matching suffixes (uppercase hex,
  // 35 characters each) of every breached password hash sharing that prefix.
  lookupPrefix(prefix: string, signal: AbortSignal): Promise<string[]>;
}

export function sha1Hex(input: string): string {
  return createHash("sha1").update(input, "utf8").digest("hex").toUpperCase();
}

const DEFAULT_BREACHED_PASSWORDS = ["password", "123456", "qwerty123", "letmein", "iloveyou", "admin123"];

export class FakeBreachProvider implements BreachProvider {
  private readonly suffixesByPrefix = new Map<string, Set<string>>();

  constructor(breachedPasswords: string[] = DEFAULT_BREACHED_PASSWORDS) {
    for (const password of breachedPasswords) {
      const hash = sha1Hex(password);
      const prefix = hash.slice(0, 5);
      const suffix = hash.slice(5);
      const set = this.suffixesByPrefix.get(prefix) ?? new Set<string>();
      set.add(suffix);
      this.suffixesByPrefix.set(prefix, set);
    }
  }

  async lookupPrefix(prefix: string, signal: AbortSignal): Promise<string[]> {
    if (signal.aborted) throw new Error("aborted");
    return [...(this.suffixesByPrefix.get(prefix.toUpperCase()) ?? [])];
  }
}

// The only function that ever sees the plaintext password. Only `prefix` (5 characters) crosses into
// `provider.lookupPrefix` -- the comparison against `suffix` happens entirely here, locally.
export async function isPasswordBreached(password: string, provider: BreachProvider, signal: AbortSignal): Promise<boolean> {
  const hash = sha1Hex(password);
  const prefix = hash.slice(0, 5);
  const suffix = hash.slice(5);
  const suffixes = await provider.lookupPrefix(prefix, signal);
  return suffixes.includes(suffix);
}
