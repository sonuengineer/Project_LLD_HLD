// A password generator is a pure utility: it needs no vault and has no state. Kept separate from manager.ts so
// it is obviously reusable (e.g. a UI's "generate" button calls this directly, before any entry exists).
import { randomInt } from "node:crypto";
import { PasswordManagerError } from "./errors.js";

const LOWER = "abcdefghijklmnopqrstuvwxyz";
const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const DIGITS = "0123456789";
const SYMBOLS = "!@#$%^&*()-_=+[]{};:,.<>?";

export const MIN_GENERATED_LENGTH = 4;
export const MAX_GENERATED_LENGTH = 128;
export const DEFAULT_GENERATED_LENGTH = 16;

export interface GeneratePasswordOptions {
  length?: number;
  lower?: boolean;
  upper?: boolean;
  digits?: boolean;
  symbols?: boolean;
}

// crypto.randomInt is used instead of Math.random(): Math.random() is not a cryptographically secure source
// and must never be used to generate a secret.
export function generatePassword(options: GeneratePasswordOptions = {}): string {
  const length = options.length ?? DEFAULT_GENERATED_LENGTH;
  if (!Number.isInteger(length) || length < MIN_GENERATED_LENGTH || length > MAX_GENERATED_LENGTH) {
    throw new PasswordManagerError(
      "INVALID_REQUEST",
      `length must be an integer between ${MIN_GENERATED_LENGTH} and ${MAX_GENERATED_LENGTH}`,
    );
  }

  const useLower = options.lower ?? true;
  const useUpper = options.upper ?? true;
  const useDigits = options.digits ?? true;
  const useSymbols = options.symbols ?? true;

  const pools: string[] = [];
  if (useLower) pools.push(LOWER);
  if (useUpper) pools.push(UPPER);
  if (useDigits) pools.push(DIGITS);
  if (useSymbols) pools.push(SYMBOLS);
  if (pools.length === 0) {
    throw new PasswordManagerError("INVALID_REQUEST", "at least one character class must be enabled");
  }
  // No separate "length too short for every class" check is needed: there are at most 4 classes, and
  // MIN_GENERATED_LENGTH is already 4, so length is always >= pools.length here.

  const fullCharset = pools.join("");
  const chars: string[] = [];

  // Guarantee at least one character from each enabled pool first, so e.g. "digits: true" cannot come back
  // with no digit at all just because the rest of the draw happened to miss that pool.
  for (const pool of pools) {
    chars.push(pool[randomInt(pool.length)]!);
  }
  for (let i = chars.length; i < length; i++) {
    chars.push(fullCharset[randomInt(fullCharset.length)]!);
  }

  // Fisher-Yates with a crypto-secure index, so the "guaranteed" characters above are not predictably at the
  // front of the result.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }

  return chars.join("");
}
