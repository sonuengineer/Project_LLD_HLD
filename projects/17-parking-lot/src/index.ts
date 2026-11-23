export { fittingSizes, nearestFirst, smallestFitFirst, type AllocationStrategy } from "./allocation.js";
export { ManualClock, systemClock, type Clock } from "./clock.js";
export { DisplayBoard } from "./display-board.js";
export { ParkingError, type ParkingErrorCode } from "./errors.js";
export { EventQueue, type Listener } from "./events.js";
export { FakePaymentGateway, type FakeCharge, type FakeOutcome } from "./fake-gateway.js";
export { FreeSpotIndex, type FreeSpots } from "./free-index.js";
export {
  EntryGate,
  ExitGate,
  type EntryDevice,
  type ExitDevice,
  type ExitGateOptions,
  type GateOptions,
} from "./gates.js";
export {
  ParkingLot,
  normalizePlate,
  type Availability,
  type AvailabilityChanged,
  type Bill,
  type ExitQuote,
  type LotLayout,
  type ParkingLotOptions,
  type Payment,
  type PaymentQuote,
  type Receipt,
  type Ticket,
  type TicketStatus,
} from "./parking-lot.js";
export { PayStation } from "./pay-station.js";
export {
  PaymentDeclinedError,
  chargeWithRetry,
  type PaymentGateway,
  type PaymentRequest,
  type RetryOptions,
} from "./payment.js";
export {
  DAY_MS,
  HOUR_MS,
  HourlyPricing,
  MINUTE_MS,
  type HourlyPricingOptions,
  type PricingStrategy,
} from "./pricing.js";
export { ParkingSpot, type SpotState } from "./spot.js";
export { SPOT_SIZES, VEHICLE_TYPES, fits, type SpotSize, type VehicleType } from "./types.js";
