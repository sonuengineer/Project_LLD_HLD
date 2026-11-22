import { describe, expect, it } from "vitest";
import { FreeSpotIndex } from "../src/free-index.js";
import { ParkingSpot } from "../src/spot.js";
import { SPOT_SIZES, type SpotSize } from "../src/types.js";

function lot(sizes: SpotSize[]) {
  const spots = sizes.map((size, i) => new ParkingSpot(`S${i}`, 0, i, size));
  return { spots, index: new FreeSpotIndex(spots) };
}

// Brute force: what nearest() must return.
const scan = (spots: ParkingSpot[], size: SpotSize) => spots.find((s) => s.isFree && s.size === size);

describe("FreeSpotIndex", () => {
  it("returns the nearest free spot of a size, or undefined", () => {
    const { spots, index } = lot(["large", "compact", "compact", "small"]);
    expect(index.nearest("compact")).toBe(spots[1]);
    expect(index.nearest("small")).toBe(spots[3]);
    expect(lot(["compact"]).index.nearest("large")).toBeUndefined();
  });

  it("skips spots taken since (lazy deletion) and offers them again once released", () => {
    const { spots, index } = lot(["compact", "compact", "compact"]);
    spots[0]!.reserve("a");
    spots[1]!.reserve("b");
    expect(index.nearest("compact")).toBe(spots[2]);
    spots[0]!.release("a");
    index.released(spots[0]!);
    expect(index.nearest("compact")).toBe(spots[0]);
  });

  it("a spot released while its old heap entry is still there is not added twice", () => {
    const { spots, index } = lot(["compact", "compact"]);
    // Take spot 1 (not the heap top), release it, take it again: its entry never left the heap.
    spots[1]!.reserve("a");
    spots[1]!.release("a");
    index.released(spots[1]!);
    expect(index.entryCount()).toBe(2); // not 3: the old entry is reused
    spots[0]!.reserve("b");
    spots[1]!.reserve("c");
    expect(index.nearest("compact")).toBeUndefined();
    spots[1]!.release("c");
    index.released(spots[1]!);
    expect(index.nearest("compact")).toBe(spots[1]);
  });

  it("matches a brute-force scan through 3000 random take / release steps", () => {
    const sizes = Array.from({ length: 60 }, (_, i) => SPOT_SIZES[(i * 7) % 3]!);
    const { spots, index } = lot(sizes);
    let seed = 7;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let step = 0; step < 3000; step++) {
      const s = spots[Math.floor(rand() * spots.length)]!;
      if (s.isFree) {
        s.reserve(`t${step}`);
      } else {
        s.release(s.heldBy!);
        index.released(s);
      }
      for (const size of SPOT_SIZES) expect(index.nearest(size)).toBe(scan(spots, size));
      expect(index.entryCount()).toBeLessThanOrEqual(spots.length);
    }
  });
});
