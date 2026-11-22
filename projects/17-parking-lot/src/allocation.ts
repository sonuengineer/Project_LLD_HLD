import type { ParkingSpot } from "./spot.js";
import { sizeRank, type VehicleType } from "./types.js";

// Strategy: WHICH free spot a vehicle gets is a policy the lot owner may change; the lot itself only guarantees
// that the chosen spot is free and fits.
//
// `candidates` are the free spots this vehicle fits in, nearest first (lower level, then lower position). The lot
// never calls choose() with an empty list. Returning anything that is not one of the candidates is a bug the lot
// rejects (STRATEGY_BUG) without changing any state.
export interface AllocationStrategy {
  readonly name: string;
  choose(vehicle: VehicleType, candidates: readonly ParkingSpot[]): ParkingSpot | undefined;
}

// Closest spot that fits, whatever its size. Shortest walk; a car may take a large spot a truck needs later.
export const nearestFirst: AllocationStrategy = {
  name: "nearest-first",
  choose: (_vehicle, candidates) => candidates[0],
};

// Smallest size that fits, nearest among those. Keeps large spots for trucks. The default.
export const smallestFitFirst: AllocationStrategy = {
  name: "smallest-fit-first",
  choose: (_vehicle, candidates) => {
    let best: ParkingSpot | undefined;
    for (const spot of candidates) {
      // Strict "<" keeps the first (nearest) spot on a size tie.
      if (best === undefined || sizeRank(spot.size) < sizeRank(best.size)) best = spot;
    }
    return best;
  },
};
