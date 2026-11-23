import { ParkingError } from "./errors.js";
import { VEHICLE_TYPES, type VehicleType } from "./types.js";

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

// Strategy: how much a stay costs. Money is an integer in minor units (paise, cents): no floating point, so
// 3 x 0.10 never becomes 0.30000000000000004. Times are epoch milliseconds.
export interface PricingStrategy {
  readonly name: string;
  fee(vehicle: VehicleType, entryAt: number, exitAt: number): number;
}

export interface HourlyPricingOptions {
  // Stays up to and including this many minutes are free. Above it, the WHOLE stay is charged (not stay - grace).
  graceMinutes?: number;
  // At most this many hours are charged per started 24 h, counted from entry (1-24). Unset = no cap.
  dailyCapHours?: number;
}

// Rate per started hour: 1 ms over a full hour is charged as the next hour.
// The fee never goes down as the stay gets longer (the pay-then-exit window relies on that; tested).
export class HourlyPricing implements PricingStrategy {
  readonly name = "hourly";
  private readonly rates: Readonly<Record<VehicleType, number>>;
  private readonly graceMs: number;
  private readonly capHours: number | undefined;

  constructor(ratesPerHourMinor: Record<VehicleType, number>, options: HourlyPricingOptions = {}) {
    for (const vehicle of VEHICLE_TYPES) {
      const rate = ratesPerHourMinor[vehicle];
      if (!Number.isSafeInteger(rate) || rate < 0) {
        throw new ParkingError("INVALID_RATE", `rate for ${vehicle} must be a non-negative integer in minor units`);
      }
    }
    const grace = options.graceMinutes ?? 0;
    if (!Number.isSafeInteger(grace) || grace < 0) {
      throw new ParkingError("INVALID_RATE", "graceMinutes must be a non-negative integer");
    }
    const cap = options.dailyCapHours;
    if (cap !== undefined && (!Number.isSafeInteger(cap) || cap < 1 || cap > 24)) {
      throw new ParkingError("INVALID_RATE", "dailyCapHours must be an integer from 1 to 24");
    }
    this.rates = { ...ratesPerHourMinor };
    this.graceMs = grace * MINUTE_MS;
    this.capHours = cap;
  }

  fee(vehicle: VehicleType, entryAt: number, exitAt: number): number {
    const stayMs = exitAt - entryAt;
    if (!Number.isFinite(stayMs) || stayMs < 0) {
      throw new ParkingError("INVALID_TIME", `exit time ${exitAt} is before entry time ${entryAt}`);
    }
    if (stayMs <= this.graceMs) return 0;
    const rate = this.rates[vehicle];
    if (this.capHours === undefined) return Math.ceil(stayMs / HOUR_MS) * rate;
    // Full days at the cap, then the started hours of the last part-day, capped too.
    const days = Math.floor(stayMs / DAY_MS);
    const restHours = Math.ceil((stayMs - days * DAY_MS) / HOUR_MS);
    return (days * this.capHours + Math.min(restHours, this.capHours)) * rate;
  }
}
