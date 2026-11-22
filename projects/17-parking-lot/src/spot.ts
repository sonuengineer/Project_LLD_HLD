import { ParkingError } from "./errors.js";
import type { SpotSize } from "./types.js";

// A spot is free or held by exactly one ticket. Two states and two transitions, so a field plus guarded methods
// is enough; the State pattern would add a class per state for no behaviour difference.
export class ParkingSpot {
  private ticketId: string | null = null;

  constructor(
    readonly id: string,
    readonly level: number,
    readonly position: number,
    readonly size: SpotSize,
  ) {}

  get isFree(): boolean {
    return this.ticketId === null;
  }

  get heldBy(): string | null {
    return this.ticketId;
  }

  occupy(ticketId: string): void {
    if (this.ticketId !== null) {
      throw new ParkingError("SPOT_STATE", `spot ${this.id} is already occupied`);
    }
    this.ticketId = ticketId;
  }

  // Release needs the ticket that holds the spot, so a bug elsewhere cannot free someone else's spot.
  release(ticketId: string): void {
    if (this.ticketId !== ticketId) {
      throw new ParkingError("SPOT_STATE", `spot ${this.id} is not held by ticket ${ticketId}`);
    }
    this.ticketId = null;
  }
}
