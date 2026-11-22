// One error class with a machine-readable code, so callers (a gate UI, an HTTP layer later) switch on `code`
// instead of parsing messages.

export type ParkingErrorCode =
  | "INVALID_LAYOUT" // constructor: empty lot, empty level, unknown spot size
  | "INVALID_RATE" // pricing constructor: negative or non-integer money
  | "INVALID_PLATE" // plate empty or not letters/digits after normalising
  | "INVALID_VEHICLE" // vehicle type not one of VEHICLE_TYPES
  | "ALREADY_PARKED" // the same plate is already inside, or entering at another gate
  | "LOT_FULL" // no free spot fits this vehicle (other sizes may still be free)
  | "RESERVATION_NOT_FOUND" // confirm / cancel of an id that is not a pending reservation
  | "TICKET_NOT_ACTIVE" // unknown ticket, already used to exit, or the car is not in yet
  | "TICKET_BUSY" // an exit with this ticket is already in progress (at another gate)
  | "EXIT_NOT_STARTED" // commitExit / abortExit without beginExit
  | "INVALID_TIME" // exit time before entry time (clock went backwards)
  | "DEVICE_FAILED" // a gate's ticket printer / barrier failed or timed out; the claim was rolled back
  | "SPOT_STATE" // invalid spot transition (a bug if it ever reaches a caller)
  | "STRATEGY_BUG"; // a plugged-in strategy returned something the lot cannot accept

export class ParkingError extends Error {
  constructor(
    readonly code: ParkingErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ParkingError";
  }
}
