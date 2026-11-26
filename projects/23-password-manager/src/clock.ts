// Time is injected so lockout tests sit exactly on the cooldown boundary without sleeping. Same shape as the
// other projects in this repo.

export interface Clock {
  now(): number; // epoch ms
}

export const systemClock: Clock = { now: () => Date.now() };

export class ManualClock implements Clock {
  constructor(private time: number) {}

  now(): number {
    return this.time;
  }

  set(time: number): void {
    this.time = time;
  }

  advance(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) throw new RangeError("advance() takes a non-negative number of ms");
    this.time += ms;
  }
}
