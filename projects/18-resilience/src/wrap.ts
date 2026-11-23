import type { Operation, Policy } from "./types.js";

// Compose policies, OUTERMOST FIRST: wrap(a, b, c).execute(op) runs a( b( c( op ) ) ).
//
// Recommended order: wrap(retry, breaker, bulkhead, timeout) -- why each one sits where it does is tested in
// test/wrap.test.ts:
//   retry outermost      every attempt goes through the breaker, so the breaker sees every failure, and an open
//                        breaker's BrokenCircuitError reaches the retry, which (with isRetryableHttp) stops at once;
//   breaker before bulkhead  calls the breaker rejects never take a bulkhead slot;
//   bulkhead outside timeout a slot is held at most for one attempt's timeout, never during the retry's backoff
//                        sleep (bulkhead outside retry WOULD hold the slot while sleeping);
//   timeout innermost    each attempt gets its own deadline; outside retry it would be one deadline for all attempts
//                        and waits (that is what RetryPolicy's deadlineMs is for).
export function wrap(...policies: Policy[]): Policy {
  if (policies.length === 0) throw new RangeError("wrap needs at least one policy");
  return {
    execute<T>(operation: Operation<T>, signal?: AbortSignal): Promise<T> {
      let run: (s?: AbortSignal) => Promise<T> = (s) => operation(s ?? NEVER);
      for (let i = policies.length - 1; i >= 0; i--) {
        const policy = policies[i]!;
        const inner = run;
        run = (s) => policy.execute((innerSignal) => inner(innerSignal), s);
      }
      return run(signal);
    },
  };
}

const NEVER = new AbortController().signal;
