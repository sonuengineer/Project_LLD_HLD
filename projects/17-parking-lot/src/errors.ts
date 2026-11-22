// One error class with a machine-readable code, so callers (a gate UI, an HTTP layer later) switch on `code`
// instead of parsing messages.

export type ParkingErrorCode =
  | "INVALID_LAYOUT" // constructor: empty lot, empty level, unknown spot size
  | "INVALID_RATE" // pricing constructor: negative or non-integer money
  | "INVALID_PLATE" // plate empty or not letters/digits after normalising
  | "INVALID_VEHICLE" // vehicle type not one of VEHICLE_TYPES
  | "ALREADY_PARKED" // the same plate is already inside
  | "LOT_FULL" // no free spot fits this vehicle (other sizes may still be free)
  | "TICKET_NOT_ACTIVE" // unknown ticket, or it was already used to exit
  | "INVALID_TIME" // exit time before entry time (clock went backwards)
  | "SPOT_STATE" // occupy a taken spot / release with the wrong ticket (a bug if it ever reaches a caller)
  | "STRATEGY_BUG"; // a plugged-in strategy returned something the lot cannot accept

export class ParkingError extends Error {
  constructor(
    readonly code: ParkingErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ParkingError";
  }
}
