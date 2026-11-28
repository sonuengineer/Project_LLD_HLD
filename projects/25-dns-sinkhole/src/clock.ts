// Time is injected so cache TTL tests sit exactly on boundaries and never sleep for real. Same shape as the other
// projects in this repo (see 22-messaging/src/clock.ts). Network timeouts (upstream UDP/TCP) are NOT governed by
// this clock -- they are real wall-clock waits via setTimeout, because a socket timeout is an event-loop concern,
// not cache business time. See PLAN.md.

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
