export { nearestFirst, smallestFitFirst, type AllocationStrategy } from "./allocation.js";
export { ManualClock, systemClock, type Clock } from "./clock.js";
export { ParkingError, type ParkingErrorCode } from "./errors.js";
export {
  ParkingLot,
  normalizePlate,
  type Availability,
  type LotLayout,
  type ParkingLotOptions,
  type Receipt,
  type Ticket,
} from "./parking-lot.js";
export { HOUR_MS, HourlyPricing, MINUTE_MS, type HourlyPricingOptions, type PricingStrategy } from "./pricing.js";
export { ParkingSpot } from "./spot.js";
export { SPOT_SIZES, VEHICLE_TYPES, fits, type SpotSize, type VehicleType } from "./types.js";
