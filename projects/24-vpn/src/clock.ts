// Time is injected so rekey tests sit exactly on the threshold boundary without sleeping. Same shape as the
// other projects in this repo (see 22-messaging/src/clock.ts, 23-password-manager/src/clock.ts,
// 25-dns-sinkhole/src/clock.ts) -- stage 1 of this project had no notion of time at all; stage 2's rekey
// timers are the first thing here that needs one.

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
