import { describe, expect, it } from "vitest";
import { fittingSizes, nearestFirst, smallestFitFirst } from "../src/allocation.js";
import type { FreeSpots } from "../src/free-index.js";
import { ParkingSpot } from "../src/spot.js";
import type { SpotSize } from "../src/types.js";

// A hand-made "nearest free spot per size" answer, so the strategies are tested without the real index.
function free(map: Partial<Record<SpotSize, ParkingSpot>>): FreeSpots {
  return { nearest: (size) => map[size] };
}
const at = (level: number, position: number, size: SpotSize) => new ParkingSpot(`L${level}-${position + 1}`, level, position, size);

describe("fittingSizes", () => {
  it("lists the sizes each vehicle fits, smallest first", () => {
    expect(fittingSizes("motorcycle")).toEqual(["small", "compact", "large"]);
    expect(fittingSizes("car")).toEqual(["compact", "large"]);
    expect(fittingSizes("truck")).toEqual(["large"]);
  });
});

describe("nearestFirst", () => {
  it("takes the nearest fitting spot even if it is bigger than needed", () => {
    const large = at(0, 0, "large");
    expect(nearestFirst.choose("car", free({ large, compact: at(1, 0, "compact") }))).toBe(large);
  });

  it("compares the position when the level is the same", () => {
    const compact = at(0, 2, "compact");
    expect(nearestFirst.choose("car", free({ compact, large: at(0, 5, "large") }))).toBe(compact);
  });

  it("never offers a size the vehicle does not fit", () => {
    const large = at(1, 0, "large");
    expect(nearestFirst.choose("truck", free({ small: at(0, 0, "small"), compact: at(0, 1, "compact"), large }))).toBe(large);
  });

  it("returns undefined when nothing fitting is free", () => {
    expect(nearestFirst.choose("car", free({ small: at(0, 0, "small") }))).toBeUndefined();
  });
});

describe("smallestFitFirst", () => {
  it("prefers a smaller spot further away over a larger near one", () => {
    const compact = at(3, 0, "compact");
    expect(smallestFitFirst.choose("car", free({ large: at(0, 0, "large"), compact }))).toBe(compact);
  });

  it("puts a motorcycle in a small spot before a compact one", () => {
    const small = at(2, 0, "small");
    expect(smallestFitFirst.choose("motorcycle", free({ compact: at(0, 0, "compact"), small }))).toBe(small);
  });

  it("falls back to the next size up", () => {
    const large = at(0, 0, "large");
    expect(smallestFitFirst.choose("car", free({ small: at(0, 1, "small"), large }))).toBe(large);
  });

  it("returns undefined when nothing fitting is free", () => {
    expect(smallestFitFirst.choose("truck", free({ compact: at(0, 0, "compact") }))).toBeUndefined();
  });
});
