# B1 Parking Lot (low-level design): plan

Status (2026-11-22): stage 1 DONE (domain model, allocation and pricing strategies, park / exit / quote,
availability; 75 tests, 18 mutation checks all caught). Stages 2 and 3 not started.

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
- **Unguessable ticket ids (`crypto.randomUUID`).** A ticket id is what lets a car out; a counter would let anyone
  guess another car's ticket (and a counter based on the active count even repeats -- mutation M18).

## Stages

| Stage | What | Status |
|---|---|---|
| 1 | Spots, vehicles, layout, two allocation strategies, hourly pricing with grace period, park / quote / exit, availability board, plate normalisation, error codes, demo | DONE 2026-11-22 |
| 2 | Concurrency: async entry and exit gates; show the check-then-act race (two gates, one free spot) with a test that fails, then fix it (reserve the spot synchronously before the first await, or a per-lot lock); Observer for display boards; a free-spot index per size instead of scanning every spot | not started |
| 3 | Payment and edge cases: pay-then-exit window (ticket paid, must leave within N minutes), lost ticket (flat fee, find by plate), a fake payment gateway that can fail (no real money, no real credentials), daily cap pricing; class diagram on the portfolio page; interview bank of about 100 questions | not started |

## Not in scope

A database, an HTTP API, a UI, real payment, reservations in advance, EV charging spots, multiple entrances with
"nearest to THIS entrance" distances (stage 2 may revisit the distance model if gates get positions).
