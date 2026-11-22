// Vehicle types and spot sizes. String unions (not TS enums) so the values are plain strings in JSON, logs and tests.

export const VEHICLE_TYPES = ["motorcycle", "car", "truck"] as const;
export type VehicleType = (typeof VEHICLE_TYPES)[number];

// Smallest first. The order IS the rule: a bigger spot can take anything a smaller one can.
export const SPOT_SIZES = ["small", "compact", "large"] as const;
export type SpotSize = (typeof SPOT_SIZES)[number];

// The smallest spot each vehicle fits in. One table instead of a 3x3 "fits" matrix: the matrix follows from it.
const SMALLEST_FIT: Record<VehicleType, SpotSize> = {
  motorcycle: "small",
  car: "compact",
  truck: "large",
};

export function sizeRank(size: SpotSize): number {
  return SPOT_SIZES.indexOf(size);
}

export function fits(vehicle: VehicleType, size: SpotSize): boolean {
  return sizeRank(size) >= sizeRank(SMALLEST_FIT[vehicle]);
}

export function isVehicleType(x: unknown): x is VehicleType {
  return typeof x === "string" && (VEHICLE_TYPES as readonly string[]).includes(x);
}

export function isSpotSize(x: unknown): x is SpotSize {
  return typeof x === "string" && (SPOT_SIZES as readonly string[]).includes(x);
}
