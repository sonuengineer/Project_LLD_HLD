import type { FreeSpots } from "./free-index.js";
import type { ParkingSpot } from "./spot.js";
import { SPOT_SIZES, fits, type SpotSize, type VehicleType } from "./types.js";

// Strategy: WHICH free spot a vehicle gets is a policy the lot owner may change. A strategy only decides which size
// to take; finding the nearest free spot of a size is the index's job (O(log n), see free-index.ts).
//
// The lot calls choose() only when at least one fitting spot is free. Returning undefined, a spot that is taken, a
// spot that does not fit or a spot of another lot is a bug the lot rejects (STRATEGY_BUG) without changing state.
export interface AllocationStrategy {
  readonly name: string;
  choose(vehicle: VehicleType, free: FreeSpots): ParkingSpot | undefined;
}

// Sizes this vehicle fits, smallest first.
export function fittingSizes(vehicle: VehicleType): SpotSize[] {
  return SPOT_SIZES.filter((size) => fits(vehicle, size));
}

export function nearer(a: ParkingSpot, b: ParkingSpot): boolean {
  return a.level !== b.level ? a.level < b.level : a.position < b.position;
}

// Closest spot that fits, whatever its size. Shortest walk; a car may take a large spot a truck needs later.
export const nearestFirst: AllocationStrategy = {
  name: "nearest-first",
  choose: (vehicle, free) => {
    let best: ParkingSpot | undefined;
    for (const size of fittingSizes(vehicle)) {
      const spot = free.nearest(size);
      if (spot !== undefined && (best === undefined || nearer(spot, best))) best = spot;
    }
    return best;
  },
};

// Smallest size that fits, nearest among those. Keeps large spots for trucks. The default.
export const smallestFitFirst: AllocationStrategy = {
  name: "smallest-fit-first",
  choose: (vehicle, free) => {
    for (const size of fittingSizes(vehicle)) {
      const spot = free.nearest(size);
      if (spot !== undefined) return spot;
    }
    return undefined;
  },
};
