import type { CacheEvent } from "../src/index.js";

// A clock the test moves by hand: TTL tests never wait on real time.
export function manualClock(start = 1000) {
  const clock = {
    t: start,
    now: () => clock.t,
    advance(ms: number) {
      clock.t += ms;
    },
  };
  return clock;
}

// A promise the test settles by hand, to hold a loader "in flight" for as long as the test needs.
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export function recorder<K>() {
  const events: CacheEvent<K>[] = [];
  return { events, onEvent: (e: CacheEvent<K>) => void events.push(e) };
}

// Lets every pending promise reaction run (several hops, for chains through async functions).
export async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}
