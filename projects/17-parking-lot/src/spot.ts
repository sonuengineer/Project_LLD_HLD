import { ParkingError } from "./errors.js";
import type { SpotSize } from "./types.js";

// free -> reserved (a gate claimed it, the car is not through the barrier yet)
// reserved -> occupied (the car is in)
// reserved | occupied -> free (gate failed and cancelled / car left)
export type SpotState = "free" | "reserved" | "occupied";

// Three states, three guarded transitions. Still a field and methods rather than the State pattern: no state has
// behaviour of its own, only "which transition is allowed", and each method checks exactly that.
export class ParkingSpot {
  private current: SpotState = "free";
  private holder: string | null = null;

  constructor(
    readonly id: string,
    readonly level: number,
    readonly position: number,
    readonly size: SpotSize,
  ) {}

  get state(): SpotState {
    return this.current;
  }

  get isFree(): boolean {
    return this.current === "free";
  }

  get heldBy(): string | null {
    return this.holder;
  }

  reserve(ticketId: string): void {
    if (this.current !== "free") {
      throw new ParkingError("SPOT_STATE", `spot ${this.id} is ${this.current}, cannot reserve`);
    }
    this.current = "reserved";
    this.holder = ticketId;
  }

  confirm(ticketId: string): void {
    if (this.current !== "reserved" || this.holder !== ticketId) {
      throw new ParkingError("SPOT_STATE", `spot ${this.id} is not reserved by ticket ${ticketId}`);
    }
    this.current = "occupied";
  }

  // Lost ticket: the car stays, the spot moves to the replacement ticket.
  transfer(fromTicketId: string, toTicketId: string): void {
    if (this.current !== "occupied" || this.holder !== fromTicketId) {
      throw new ParkingError("SPOT_STATE", `spot ${this.id} is not occupied by ticket ${fromTicketId}`);
    }
    this.holder = toTicketId;
  }

  // Needs the holding ticket, so a bug elsewhere cannot free someone else's spot.
  release(ticketId: string): void {
    if (this.current === "free" || this.holder !== ticketId) {
      throw new ParkingError("SPOT_STATE", `spot ${this.id} is not held by ticket ${ticketId}`);
    }
    this.current = "free";
    this.holder = null;
  }
}
