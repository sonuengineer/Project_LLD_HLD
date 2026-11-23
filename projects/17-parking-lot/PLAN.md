# B1 Parking Lot (low-level design): plan

Status (2026-11-22): stage 1 DONE (domain model, allocation and pricing strategies, park / exit / quote,
availability; 75 tests, 18 mutation checks all caught). Stage 2 DONE (two-phase reserve / confirm and begin / commit
exit, async gates with timeout, the race shown with naive gates and fixed, Observer with a delivery queue, free-spot
index; 125 tests, 37 mutation checks all caught). Stage 3 DONE 2026-11-23 (payments through a fake provider with
idempotent retries, pay-then-exit window, lost ticket, daily cap; 171 tests; 63 mutation checks, 2 survivors were
test gaps and are closed).

## Why this project

The earlier projects here are system design (H1-H14) and "build your own" tools (A1, A3, A6). None of them is a
classic low-level design (LLD) round: "design the classes for X, then extend it". Parking Lot is the usual first one.
It is small, but the follow-up questions are where interviews go: change the allocation rule, change the pricing,
two gates at once, lost ticket, payment fails. The goal is code where each of those is a small, local change, and
tests that prove the rules.

## Decisions (one recommendation each)

- **TypeScript, a library with no runtime dependencies, in memory.** An LLD round is about classes and
  responsibilities, not storage or HTTP. Same toolchain as the other TS projects (tsc + vitest, Node 20).
- **Strategy for the two policies that change between lots: which spot (AllocationStrategy) and how much
  (PricingStrategy).** The lot only enforces the rules that never change (spot free, vehicle fits, one ticket per
  plate). Two allocation strategies exist so the interface is not hypothetical: `smallestFitFirst` (default, keeps
  large spots for trucks) and `nearestFirst` (shortest walk). They give different answers for the same lot (tested).
- **Spot sizes are ordered (small < compact < large) and each vehicle has a smallest fit.** "Fits" is one
  comparison, not a 3x3 table to keep in sync. Adding a size in between is one array entry.
- **Money is an integer in minor units (paise, cents).** No floating point anywhere money is computed. The lot
  rejects a pricing strategy that returns a fraction, a negative number or NaN.
- **Time comes from an injected Clock.** Tests move time without waiting, and can make it go backwards.
- **Check everything, then change state.** park() and exit() do every check that can throw before the first
  mutation, so an error always means "nothing happened". Each error case is tested with a before/after comparison of
  the whole lot.
- **Patterns NOT used, on purpose:**
  - State pattern for a spot: a spot has two states and two transitions; guarded `occupy` / `release` methods do the
    same job without a class per state.
  - Factory for vehicles: a vehicle is a plate and a type; there is no behaviour per type to construct.
  - Singleton for the lot: it would make tests share one global lot and block "two lots in one process". The lot is
    an ordinary object the caller creates and passes around.
  - A Level class: it would only wrap an array; a spot knows its level.
- **Stage 2: concurrency by a synchronous claim, not a lock.** The lot's methods stay synchronous; JavaScript runs one
  synchronous block at a time, so a check and the change it guards cannot be split by other code. Gates do the slow,
  async device work BETWEEN two lot calls while holding a claim: `reserve` (spot reserved, plate taken) ... `confirm`
  or `cancel`; `beginExit` (ticket locked, fee fixed) ... `commitExit` or `abortExit`. Recommended over a mutex around
  the whole gate operation because a mutex would serialise every gate behind the slowest printer, and over
  "check, await, act" because that is the bug (reproduced in `test/gates.test.ts` with naive gates). This only holds
  inside one Node process; several processes sharing a database would need the claim in the database (a conditional
  UPDATE or a unique constraint), which is the same idea moved to where the state lives.
- **Stage 2: the spot gets a third state, `reserved`.** Still guarded methods, not the State pattern (no state has
  behaviour of its own).
- **Stage 2: Observer with a queue.** Events are queued and delivered in order, after the lot's change is complete;
  a throwing listener is reported and skipped. Without the queue, a listener that changes the lot inside its handler
  makes later listeners receive the newer event first and end on a stale count (tested).
- **Stage 2: strategies ask an index, not a list.** `choose(vehicle, free)` where `free.nearest(size)` is a min-heap
  per size with lazy deletion. park() goes from O(spots) to O(sizes x log spots). The interface change was worth it:
  a strategy now says only WHICH SIZE it prefers, and the randomized test checks every choice against the stage 1
  full scan. Not measured on large lots; the claim is the complexity, not a benchmark.
- **Stage 3: payment is one more lock, and the barrier rule lives in the lot.** beginPayment / beginExit fix the
  amount; recordPayment records exactly that amount; commitExit refuses while anything is due. Recommended over
  "the gate checks the payment" because then every gate (and every bug in one) would be a way out without paying.
- **Stage 3: one idempotency key per lock, reused on every retry.** Lost answers are the normal failure of a
  network call; a new key per retry is the classic double charge (mutation P2). Decline = final, anything else =
  unknown and retried; after the last attempt the outcome is reported as unknown, not as "failed", because it may
  have succeeded.
- **Stage 3: only a fake provider.** The interface is what a real one would plug into; nothing here talks to a
  real payment service, and no credentials exist. Reconciliation of unknown outcomes is out of scope.
- **Stage 3: pay-then-exit prices the stay as of the payment for a window, then charges only the difference.**
  Simpler than a separate "paid until" state, and correct because the fee never goes down for a longer stay
  (tested over 3 days with and without a cap).
- **Stage 3: a lost ticket gets a replacement and the old id is killed.** "Lost" may mean stolen; keeping the old id
  valid would let the thief drive out on it.
- **Unguessable ticket ids (`crypto.randomUUID`).** A ticket id is what lets a car out; a counter would let anyone
  guess another car's ticket (and a counter based on the active count even repeats -- mutation M18).

## Stages

| Stage | What | Status |
|---|---|---|
| 1 | Spots, vehicles, layout, two allocation strategies, hourly pricing with grace period, park / quote / exit, availability board, plate normalisation, error codes, demo | DONE 2026-11-22 |
| 2 | Concurrency: async entry and exit gates; the check-then-act race (two gates, one free spot; one ticket, two exits) reproduced with naive gates, fixed with synchronous claims; device timeout with AbortSignal; Observer for display boards; a free-spot index per size instead of scanning every spot | DONE 2026-11-22 |
| 3 | Payment and edge cases: fake payment gateway with idempotent retries (no real money, no credentials), pay station, card reader at the exit, barrier rule in the lot, pay-then-exit window, lost ticket (replacement + penalty, old id dead), daily cap pricing; interview bank and portfolio page | DONE 2026-11-23 |

## Not in scope

A database, an HTTP API, a UI, real payment, reservations in advance, EV charging spots, multiple entrances with
"nearest to THIS entrance" distances (stage 2 may revisit the distance model if gates get positions).
