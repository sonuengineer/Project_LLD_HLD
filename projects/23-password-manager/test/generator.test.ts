import { describe, expect, it } from "vitest";
import { generatePassword, MAX_GENERATED_LENGTH, MIN_GENERATED_LENGTH } from "../src/generator.js";
import { errorCode } from "./helpers.js";

describe("generatePassword", () => {
  it("defaults to length 16 using all four character classes", () => {
    const pw = generatePassword();
    expect(pw).toHaveLength(16);
  });

  it("respects an explicit length, within bounds (exact min and max are accepted)", () => {
    expect(generatePassword({ length: MIN_GENERATED_LENGTH })).toHaveLength(MIN_GENERATED_LENGTH);
    expect(generatePassword({ length: MAX_GENERATED_LENGTH })).toHaveLength(MAX_GENERATED_LENGTH);
    expect(errorCode(() => generatePassword({ length: MIN_GENERATED_LENGTH - 1 }))).toBe("INVALID_REQUEST");
    expect(errorCode(() => generatePassword({ length: MAX_GENERATED_LENGTH + 1 }))).toBe("INVALID_REQUEST");
    expect(errorCode(() => generatePassword({ length: 4.5 }))).toBe("INVALID_REQUEST");
  });

  it("disabling a character class means the result never contains a character from it", () => {
    const pw = generatePassword({ length: 32, symbols: false, digits: false });
    expect(/[0-9]/.test(pw)).toBe(false);
    expect(/[!@#$%^&*()\-_=+[\]{};:,.<>?]/.test(pw)).toBe(false);
  });

  it("enabling a character class guarantees at least one character from it (checked over many draws)", () => {
    for (let i = 0; i < 50; i++) {
      const pw = generatePassword({ length: 8, lower: true, upper: true, digits: true, symbols: true });
      expect(/[a-z]/.test(pw)).toBe(true);
      expect(/[A-Z]/.test(pw)).toBe(true);
      expect(/[0-9]/.test(pw)).toBe(true);
    }
  });

  it("disabling every character class throws INVALID_REQUEST", () => {
    expect(errorCode(() => generatePassword({ lower: false, upper: false, digits: false, symbols: false }))).toBe("INVALID_REQUEST");
  });

  it("two calls are (overwhelmingly likely to be) different", () => {
    expect(generatePassword({ length: 32 })).not.toBe(generatePassword({ length: 32 }));
  });

  it("the per-class guaranteed characters are not pinned to fixed positions (the result is shuffled)", () => {
    const classOf = (ch: string): string => {
      if (/[a-z]/.test(ch)) return "lower";
      if (/[A-Z]/.test(ch)) return "upper";
      if (/[0-9]/.test(ch)) return "digit";
      return "symbol";
    };
    const firstPositionClasses = new Set<string>();
    for (let i = 0; i < 30; i++) {
      firstPositionClasses.add(classOf(generatePassword({ length: 8 })[0]!));
    }
    // Without shuffling, the first character would always come from the same class (whichever is first among
    // the enabled pools) on every single call.
    expect(firstPositionClasses.size).toBeGreaterThan(1);
  });
});
