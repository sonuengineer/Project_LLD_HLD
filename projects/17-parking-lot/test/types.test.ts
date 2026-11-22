import { describe, expect, it } from "vitest";
import { SPOT_SIZES, VEHICLE_TYPES, fits } from "../src/types.js";

describe("fits", () => {
  // The full 3 x 3 table, written out by hand so a change to SMALLEST_FIT or to the size order shows up here.
  const expected: Record<string, Record<string, boolean>> = {
    motorcycle: { small: true, compact: true, large: true },
    car: { small: false, compact: true, large: true },
    truck: { small: false, compact: false, large: true },
  };

  for (const vehicle of VEHICLE_TYPES) {
    for (const size of SPOT_SIZES) {
      it(`${vehicle} in ${size}: ${expected[vehicle]![size]}`, () => {
        expect(fits(vehicle, size)).toBe(expected[vehicle]![size]);
      });
    }
  }
});
