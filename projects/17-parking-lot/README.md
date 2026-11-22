# B1 Parking Lot (low-level design)

A parking lot as a small TypeScript library: levels of spots in three sizes, tickets, two allocation strategies,
hourly pricing with a grace period, and an availability board. No runtime dependencies, in memory.

Status (2026-11-22): **stage 1 done** -- 75 tests pass (Windows, Node 20), 18 deliberate breaks all caught. Stages 2
(concurrency, display boards) and 3 (payment, lost ticket, interview bank) are planned in [PLAN.md](PLAN.md), not built.

## Classes

```
                       +------------------------------------------+
                       | ParkingLot                               |
   caller ------------>|  park(plate, vehicle)    -> Ticket       |
   (gate, test, demo)  |  quote(ticketId)         -> fee (minor)  |
                       |  exit(ticketId)          -> Receipt      |
                       |  findByPlate / availability / snapshot   |
                       +------------------------------------------+
                         | owns 1..n        | uses 1        | uses 1          | uses 1
                         v                  v               v                 v
                 +---------------+  +--------------------+ +-----------------+ +-------+
                 | ParkingSpot   |  | AllocationStrategy | | PricingStrategy | | Clock |
                 |  id, level,   |  |  choose(vehicle,   | |  fee(vehicle,   | | now() |
                 |  position,    |  |   candidates)      | |   entry, exit)  | +-------+
                 |  size         |  +--------------------+ +-----------------+   ^    ^
                 |  occupy(t)    |     ^            ^              ^             |    |
                 |  release(t)   |     |            |              |      systemClock ManualClock
                 +---------------+ smallestFit  nearestFirst  HourlyPricing
                                   First (default)
```

`Ticket` and `Receipt` are frozen plain objects. `VehicleType` (`motorcycle | car | truck`) and `SpotSize`
(`small | compact | large`) are string unions.

## Rules

**What fits where.** Sizes are ordered small < compact < large; each vehicle has a smallest fit and fits that size
or bigger:

| | small | compact | large |
|---|---|---|---|
| motorcycle | yes | yes | yes |
| car | no | yes | yes |
| truck | no | no | yes |

**Which spot.** The lot passes the strategy every free spot that fits, nearest first (level 0 first, then position).

| Strategy | Picks | Trade-off |
|---|---|---|
| `smallestFitFirst` (default) | the smallest size that fits, nearest among those | keeps large spots for trucks; a car may walk further |
| `nearestFirst` | the first candidate | shortest walk; a car can take the last large spot |

A strategy that returns nothing, a non-candidate or an occupied spot gets `STRATEGY_BUG` and the lot is unchanged.

**How much.** `HourlyPricing(ratesPerHourMinor, { graceMinutes })`:
- rates are integers in minor units (5000 = 50.00), one per vehicle type, all required, none negative;
- a stay up to and including the grace period is free;
- above it, every started hour of the WHOLE stay is charged (70 min with 10 min grace = 2 hours, not 1);
- an exit time before the entry time is `INVALID_TIME` (the car stays parked; the ticket still works later).

**Plates** are upper-cased with spaces and `-` removed, then must be 1-12 letters or digits. `mh 12-ab 1234` and
`MH12AB1234` are the same car, so it cannot hold two tickets.

**Errors.** Every failure is a `ParkingError` with a `code`, and a failed call changes nothing:

| Code | When |
|---|---|
| `INVALID_LAYOUT` | no levels, an empty level, an unknown size |
| `INVALID_RATE` | negative, fractional, missing or NaN rate; negative grace |
| `INVALID_PLATE` / `INVALID_VEHICLE` | bad input to park |
| `ALREADY_PARKED` | that plate is inside |
| `LOT_FULL` | no free spot fits this vehicle (spots of other sizes may be free) |
| `TICKET_NOT_ACTIVE` | unknown ticket, or already used to exit |
| `INVALID_TIME` | exit before entry |
| `STRATEGY_BUG` | a plugged-in strategy returned something invalid |
| `SPOT_STATE` | occupying a taken spot / releasing with the wrong ticket (internal guard) |

## Design choices

Why Strategy for allocation and pricing, and why State, Factory, Singleton and a Level class were NOT used, is in
[PLAN.md](PLAN.md) "Decisions". In short: a pattern is used where a real variation exists (two allocation policies,
pricing that differs per lot), not by default.

## Tests

`npm test` -- 75 tests in `test/`:

| File | Proves |
|---|---|
| `types.test.ts` | the full fits table, written out by hand (9) |
| `spot.test.ts` | occupy / release, double occupy, release with the wrong ticket or of a free spot (4) |
| `allocation.test.ts` | both strategies: size preference, tie on the nearest, empty list (6) |
| `pricing.test.ts` | started hours (1 ms, exactly 1 h, 1 h + 1 ms), per-type rates, grace boundary, whole-stay charge, invalid rates, rates copied (14) |
| `parking-lot.test.ts` | layout and spot ids, park / exit / quote, both strategies through the lot, LOT_FULL per size, duplicate plate in any spelling, clock backwards, bad strategies, frozen tickets; every error case compares the whole lot before and after (32) |
| `invariants.test.ts` | 500 random park / exit steps for 5 seeds x 2 strategies, checked against an independent model after every step: tickets = occupied spots, each ticket holds its own spot and fits it, no plate twice, the board adds up, LOT_FULL only when no fitting spot is free (10) |

### Mutation checks (2026-11-22)

Each row is one deliberate bug, applied alone, full suite run, then reverted (runner script kept outside the repo).
All 18 were caught; the number is how many of the 75 tests failed.

| # | Break | Failed |
|---|---|---|
| M1 | `fits` uses `>` instead of `>=` | 23 |
| M2 | a car fits a small spot | 2 |
| M3 | smallest-fit tie picks the farthest spot | 2 |
| M4 | no duplicate-plate check | 11 |
| M5 | occupied spots offered as candidates | 13 |
| M6 | strategy result not checked against the candidates | 2 |
| M7 | plate not normalised | 4 |
| M8 | exit forgets the ticket before pricing (clock-backwards case loses the car) | 4 |
| M9 | exit keeps the plate index | 11 |
| M10 | hours rounded down | 4 |
| M11 | grace boundary exclusive | 2 |
| M12 | grace subtracted from the stay | 3 |
| M13 | rates not copied (caller can change prices later) | 1 |
| M14 | pricing result not validated | 3 |
| M15 | ticket not frozen | 1 |
| M16 | release ignores which ticket holds the spot | 2 |
| M17 | availability ignores the level | 11 |
| M18 | ticket ids from a counter of active tickets (ids repeat) | 11 |

M13 and M15 are each caught by exactly one test; deleting that test would hide them.

## NOT implemented (stage 1)

- Concurrency. Node runs one call at a time and park() has no `await`, so two parks cannot interleave today. The race
  appears as soon as a step becomes async (a database, a payment call); that is stage 2, with a failing test first.
- Payment, pay-then-exit window, lost ticket, daily cap: stage 3. No real money or credentials will be used.
- Persistence: everything is lost when the process ends.
- Spot search is a scan of every spot per park (O(spots)); fine for hundreds of spots, an index is stage 2.
- Distances: "nearest" means lowest level, then lowest position; there is one entrance.

## Run it

```bash
cd projects/17-parking-lot
npm ci
npm test
npm run build && npm run demo     # a scripted day on a manual clock, same output every run
```

## Files

| File | What |
|---|---|
| `src/types.ts` | vehicle types, spot sizes, `fits` |
| `src/spot.ts` | `ParkingSpot` with guarded occupy / release |
| `src/allocation.ts` | `AllocationStrategy`, `smallestFitFirst`, `nearestFirst` |
| `src/pricing.ts` | `PricingStrategy`, `HourlyPricing` |
| `src/clock.ts` | `Clock`, `systemClock`, `ManualClock` |
| `src/errors.ts` | `ParkingError` and its codes |
| `src/parking-lot.ts` | `ParkingLot`, `normalizePlate`, `Ticket`, `Receipt` |
| `src/demo.ts` | the demo |
