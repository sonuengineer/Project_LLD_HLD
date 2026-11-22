import type { Availability, ParkingLot } from "./parking-lot.js";

// An Observer of the lot: starts from availability() and then only applies change events, never re-reads the lot.
// If an event were lost or delivered out of order, the board would drift; the randomized tests compare it with
// availability() after every step.
export class DisplayBoard {
  private readonly rowsByKey = new Map<string, Availability>();
  private readonly unsubscribe: () => void;

  constructor(lot: ParkingLot) {
    for (const row of lot.availability()) this.rowsByKey.set(key(row), row);
    this.unsubscribe = lot.subscribe((row) => {
      this.rowsByKey.set(key(row), row);
    });
  }

  rows(): Availability[] {
    return [...this.rowsByKey.values()].map((r) => ({ ...r }));
  }

  render(): string {
    return this.rows()
      .map((r) => `L${r.level} ${r.size.padEnd(7)} ${r.free === 0 ? "FULL" : `${r.free} free`}`)
      .join("\n");
  }

  close(): void {
    this.unsubscribe();
  }
}

const key = (r: Availability) => `${r.level}:${r.size}`;
