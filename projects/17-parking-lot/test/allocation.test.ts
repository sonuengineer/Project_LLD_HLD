import { describe, expect, it } from "vitest";
import { nearestFirst, smallestFitFirst } from "../src/allocation.js";
import { ParkingSpot } from "../src/spot.js";
import type { SpotSize } from "../src/types.js";

// Candidates in nearest-first order, the way the lot passes them.
function spots(...sizes: SpotSize[]): ParkingSpot[] {
  return sizes.map((size, i) => new ParkingSpot(`S${i}`, 0, i, size));
}

describe("nearestFirst", () => {
  it("takes the first candidate even if it is bigger than needed", () => {
    const c = spots("large", "compact");
    expect(nearestFirst.choose("car", c)).toBe(c[0]);
  });

  it("returns undefined for no candidates", () => {
    expect(nearestFirst.choose("car", [])).toBeUndefined();
  });
});

describe("smallestFitFirst", () => {
  it("prefers a smaller spot further away over a larger near one", () => {
    const c = spots("large", "large", "compact");
    expect(smallestFitFirst.choose("car", c)).toBe(c[2]);
  });

  it("takes the nearest of the smallest size on a tie", () => {
    const c = spots("large", "compact", "compact");
    expect(smallestFitFirst.choose("car", c)).toBe(c[1]);
  });

  it("puts a motorcycle in a small spot before a compact one", () => {
    const c = spots("compact", "large", "small");
    expect(smallestFitFirst.choose("motorcycle", c)).toBe(c[2]);
  });

  it("returns undefined for no candidates", () => {
    expect(smallestFitFirst.choose("car", [])).toBeUndefined();
  });
});
