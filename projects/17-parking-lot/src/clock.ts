// The lot asks a Clock for the time instead of calling Date.now() itself, so tests and the demo can move time
// forward (or backwards, to test that case) without waiting.

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

  // Any value, including the past: used to test a clock that goes backwards.
  set(time: number): void {
    this.time = time;
  }
}
