// The notifier asks a Clock for the time instead of calling Date.now() itself, so tests can put the user inside or
// outside quiet hours and move time forward without waiting.

export interface Clock {
  now(): number; // epoch milliseconds
}

export const systemClock: Clock = { now: () => Date.now() };

export class ManualClock implements Clock {
  constructor(private time = 0) {}

  now(): number {
    return this.time;
  }

  advance(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) throw new RangeError("advance() takes a non-negative number of ms");
    this.time += ms;
  }

  set(time: number): void {
    this.time = time;
  }
}
