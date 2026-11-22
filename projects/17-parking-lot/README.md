# B1 Parking Lot (low-level design)

A parking lot as a small TypeScript library: levels of spots in three sizes, tickets, two allocation strategies,
hourly pricing with a grace period, async entry and exit gates that are safe when they run at the same time, and
display boards that follow the lot through events. No runtime dependencies, in memory.

Status (2026-11-22): **stages 1 and 2 done** -- 125 tests pass (Windows, Node 20), 37 deliberate breaks all caught.
Stage 3 (payment, lost ticket, interview bank, portfolio page) is planned in [PLAN.md](PLAN.md), not built.

## Classes

```
  EntryGate ---- EntryDevice (printer + barrier, async)        DisplayBoard (Observer)
  ExitGate  ---- ExitDevice  (fee display + barrier, async)         ^ subscribe(): availability events
      |                                                            |
      | reserve / confirm / cancel                                 |
      | beginExit / commitExit / abortExit                         |
      v                                                            |
  +--------------------------------------------------------------------+
  | ParkingLot   (all methods synchronous; check everything, then change)|
  |   park / exit (one-step), quote, statusOf, findByPlate, availability |
  +--------------------------------------------------------------------+
      | owns 1..n       | owns 1         | uses 1              | uses 1          | uses 1
      v                 v                v                     v                 v
  ParkingSpot      FreeSpotIndex    AllocationStrategy     PricingStrategy     Clock
  free/reserved/   min-heap per     choose(vehicle, free)  fee(vehicle,        now()
  occupied         size, lazy       smallestFitFirst       entry, exit)       systemClock
                   deletion         nearestFirst           HourlyPricing      ManualClock
```

`Ticket`, `ExitQuote`, `Receipt` and events are frozen plain objects. `VehicleType` (`motorcycle | car | truck`)
and `SpotSize` (`small | compact | large`) are string unions.

## Concurrency (stage 2)

**The bug.** A gate has a slow, async step: print the ticket and open the barrier. Written the obvious way --
check there is a spot, `await` the printer, then park -- two gates can both pass the check for the last spot while
both printers run. Both barriers open; the second car is inside with no spot. The same on exit: two gates accept a
copied ticket, both barriers open. Both bugs are reproduced in `test/gates.test.ts` with naive gates written in the
test file (they are not part of the library).

**The fix: claim synchronously, then do the slow part.** Every lot method is synchronous, and JavaScript never runs
other code in the middle of a synchronous block, so a check and its change inside one lot method cannot be split.
The gates hold a claim across their `await`:

```
EntryGate.enter:  lot.reserve()  --await device-->  lot.confirm()      (device fails / times out: lot.cancel())
ExitGate.leave:   lot.beginExit() --await device--> lot.commitExit()   (device fails / times out: lot.abortExit())
```

- `reserve` takes the spot (state `reserved`) and the plate. The next gate does not see that spot as free, and the
  same plate at another gate gets `ALREADY_PARKED`. Its printer never runs.
- `beginExit` locks the ticket (`TICKET_BUSY` for a copy) and fixes the fee, so a slow barrier does not change the
  price.
- A device that fails, throws, or does not answer within `timeoutMs` (default 10 s) rolls the claim back; the
  `AbortSignal` it was given is aborted. A late answer after the timeout changes nothing (tested).
- The randomized test runs 3 entry and 2 exit gates with devices that answer in random order and fail 15% of the
  time, and checks after every step that every outstanding device call is backed by a claim.

This is safe inside ONE Node process. Several processes sharing a database would need the claim in the database (a
conditional UPDATE or a unique constraint on the spot) -- the same idea, moved to where the state lives. Not built.

## Rules

**What fits where.** Sizes are ordered small < compact < large; each vehicle has a smallest fit and fits that size
or bigger:

| | small | compact | large |
|---|---|---|---|
| motorcycle | yes | yes | yes |
| car | no | yes | yes |
| truck | no | no | yes |

**Which spot.** A strategy asks the index `free.nearest(size)` (nearest = lowest level, then lowest position) and
decides which size to take:

| Strategy | Picks | Trade-off |
|---|---|---|
| `smallestFitFirst` (default) | the smallest size that fits, nearest among those | keeps large spots for trucks; a car may walk further |
| `nearestFirst` | the nearest fitting spot of any size | shortest walk; a car can take the last large spot |

The lot checks `LOT_FULL` itself before asking the strategy. A strategy that then returns nothing, a taken spot, a
spot that does not fit or a spot of another lot gets `STRATEGY_BUG`, and the lot is unchanged.

**Free-spot index.** One min-heap per size with lazy deletion: taking a spot does not touch the heap; `nearest()`
pops entries that are no longer free; a freed spot is pushed back only if its old entry is not still there (so a
heap never holds more entries than spots, tested). park() is O(sizes x log spots) instead of a scan of every spot.
Checked against the stage 1 full scan on every park in the randomized tests. Not benchmarked.

**How much.** `HourlyPricing(ratesPerHourMinor, { graceMinutes })`:
- rates are integers in minor units (5000 = 50.00), one per vehicle type, all required, none negative;
- a stay up to and including the grace period is free;
- above it, every started hour of the WHOLE stay is charged (70 min with 10 min grace = 2 hours, not 1);
- the entry time is the reservation time (what the printed ticket shows); the exit time is `beginExit`;
- an exit time before the entry time is `INVALID_TIME` (the car stays parked; the ticket still works later).

**Plates** are upper-cased with spaces and `-` removed, then must be 1-12 letters or digits. `mh 12-ab 1234` and
`MH12AB1234` are the same car, so it cannot hold two tickets.

**Display boards (Observer).** `lot.subscribe(listener)` gets one event per changed (level, size) row, with the new
count, after the change is complete: on reserve, cancel and exit (confirm and beginExit change no count).
- Events are queued: if a listener changes the lot inside its handler, the new event is delivered after the current
  one reached every listener, so no board ends on a stale count (tested with a re-entrant "valet" listener).
- A listener that throws is reported through `onListenerError` (default `console.error`) and skipped; the change
  stands and the other listeners still run. An error handler that throws is ignored.
- Unsubscribing during delivery takes effect at once; subscribing during delivery starts with the next event.
- `DisplayBoard` starts from `availability()` and then only applies events; the randomized tests compare it with
  `availability()` after every step.

**Errors.** Every failure is a `ParkingError` with a `code`, and a failed call changes nothing:

| Code | When |
|---|---|
| `INVALID_LAYOUT` | no levels, an empty level, an unknown size |
| `INVALID_RATE` | negative, fractional, missing or NaN rate; negative grace |
| `INVALID_PLATE` / `INVALID_VEHICLE` | bad input to reserve / park |
| `ALREADY_PARKED` | that plate is inside or entering at another gate |
| `LOT_FULL` | no free spot fits this vehicle (spots of other sizes may be free) |
| `RESERVATION_NOT_FOUND` | confirm / cancel of something that is not a pending reservation |
| `TICKET_NOT_ACTIVE` | unknown ticket, already used, or the car is not in yet |
| `TICKET_BUSY` | an exit with this ticket is already in progress |
| `EXIT_NOT_STARTED` | commitExit / abortExit without beginExit |
| `INVALID_TIME` | exit before entry |
| `DEVICE_FAILED` | a gate's device failed or timed out; the claim was rolled back (`cause` has the device error) |
| `STRATEGY_BUG` | a plugged-in strategy returned something invalid |
| `SPOT_STATE` | invalid spot transition (internal guard) |

## Design choices

Why Strategy for allocation and pricing, why State, Factory, Singleton and a Level class were NOT used, and why
claims instead of a mutex, are in [PLAN.md](PLAN.md) "Decisions".

## Tests

`npm test` -- 125 tests in `test/`:

| File | Proves |
|---|---|
| `types.test.ts` | the full fits table, written out by hand (9) |
| `spot.test.ts` | free -> reserved -> occupied -> free, cancel, every refused transition keeps the holder (5) |
| `allocation.test.ts` | fitting sizes; both strategies against a hand-made index: size preference, level then position, never a size that does not fit (9) |
| `free-index.test.ts` | nearest per size, lazy deletion, no duplicate entries, 3000 random steps against a brute-force scan (4) |
| `pricing.test.ts` | started hours, per-type rates, grace boundary, whole-stay charge, invalid rates, rates copied (14) |
| `parking-lot.test.ts` | layout, park / exit / quote, both strategies through the lot, LOT_FULL per size, duplicate plate, clock backwards, bad strategies (incl. another lot's spot), frozen tickets; every error compares the whole lot before and after (35) |
| `two-phase.test.ts` | reserve / confirm / cancel, beginExit / commitExit / abortExit, fixed fee while exiting, event counts per operation, no events on failure, throwing listeners and error handlers (15) |
| `events.test.ts` | queue order with a re-entrant emit, unsubscribe / subscribe during delivery, a re-entrant listener on the real lot, DisplayBoard (7) |
| `gates.test.ts` | the race with naive gates (2 barriers for 1 spot, 2 barriers for 1 ticket), then the real gates: one ticket printed, same plate at two gates, reserved while the device runs, device failure / sync throw / timeout with abort and a late answer, no timer left behind, TICKET_BUSY at the second exit, barrier failure keeps the ticket valid (12) |
| `invariants.test.ts` | 500 random synchronous steps x 5 seeds x 2 strategies, every park compared with the stage 1 full scan; 400 random steps x 5 seeds with 3 entry + 2 exit gates and devices answering in random order (15% failures); after every step: spot states match ticket statuses, tickets hold their own fitting spot, no plate twice, board = availability(), every pending device call is backed by a claim (15) |

### Mutation checks (2026-11-22)

Each row is one deliberate bug, applied alone, full suite run, then reverted (runner scripts kept outside the repo).
All caught; the number is how many tests failed.

Stage 1 (run against the 75 stage 1 tests): 18 of 18 caught -- `fits` boundary 23, car fits small 2, size tie 2, no
duplicate-plate check 11, occupied spots offered 13, strategy result unchecked 2, plate not normalised 4, exit
forgets the ticket before pricing 4, plate index kept 11, hours rounded down 4, grace boundary 2, grace subtracted 3,
rates not copied 1, fee unchecked 3, ticket not frozen 1, release ignores the ticket 2, availability ignores the
level 11, counter ticket ids 11.

Stage 2 (against the 125 tests):

| # | Break | Failed |
|---|---|---|
| S1 | entry gate checks, awaits the device, then acts (the naive gate) | 9 |
| S2 | entry gate does not cancel on device failure | 3 |
| S3 | exit gate does not abort on device failure | 1 |
| S4 | exit gate without the lock (quote, await, exit) | 16 |
| S5 | timeout does not abort the device signal | 1 |
| S6 | timer not cleared after a fast device | 1 |
| S7 | no timeout race | 1 |
| S8 | index offers reserved spots | 11 |
| S9 | freed spot not given back to the index | 10 |
| S10 | index pushes a spot that is still in the heap | 2 |
| S11 | heap sift-down ignores the right child | 7 |
| S12 | nested event delivery instead of the queue | 2 |
| S13 | a throwing listener is not caught | 2 |
| S14 | listener set not copied per event | 1 |
| S15 | unsubscribed listener still gets the current event | 12 |
| S16 | reserve emits before the spot is taken | 11 |
| S17 | beginExit does not lock the ticket | 28 |
| S18 | no TICKET_BUSY check | 7 |
| S19 | commitExit re-prices instead of using the fixed fee | 1 |
| S20 | findByPlate returns reservations | 1 |
| S21 | no LOT_FULL pre-check | 20 |
| S22 | spot of another lot accepted | 1 |
| S23 | fitting sizes largest first | 16 |
| S24 | "nearer" compares only the level | 1 |
| S25 | spot.confirm does not check the holder | 2 |

Stage 1 checks re-run on the stage 2 code (12 that still apply): all caught -- fits boundary 68, car fits small 7,
no duplicate-plate check 18, plate not normalised 5, ticket locked before pricing 2, plate index kept 16, hours
rounded down 4, grace boundary 2, fee unchecked 3, ticket not frozen 1, release ignores the ticket 1, counter ticket
ids 16.

Caught by exactly one test (deleting that test would hide them): S3, S5, S6, S7, S14, S19, S20, S22, S24, M15, M16.

## NOT implemented (after stage 2)

- Payment, pay-then-exit window, lost ticket, daily cap: stage 3. No real money or credentials will be used.
- Persistence and more than one process: everything is in memory in one Node process (see "Concurrency").
- A reservation whose gate process dies is never cleaned up (there is no expiry sweep); the device timeout covers a
  hung device, not a crashed gate.
- The device must honour the `AbortSignal` (not open the barrier after a timeout); the fakes in the tests do, real
  hardware is not part of this project.
- Distances: "nearest" means lowest level, then lowest position; one entrance.

## Run it

```bash
cd projects/17-parking-lot
npm ci
npm test
npm run build && npm run demo     # five cars at two gates, a printer jam, a copied ticket at two exits
```

## Files

| File | What |
|---|---|
| `src/types.ts` | vehicle types, spot sizes, `fits` |
| `src/spot.ts` | `ParkingSpot`: free / reserved / occupied with guarded transitions |
| `src/free-index.ts` | `FreeSpots`, `FreeSpotIndex` (min-heap per size) |
| `src/allocation.ts` | `AllocationStrategy`, `smallestFitFirst`, `nearestFirst` |
| `src/pricing.ts` | `PricingStrategy`, `HourlyPricing` |
| `src/clock.ts` | `Clock`, `systemClock`, `ManualClock` |
| `src/events.ts` | `EventQueue` (Observer with a delivery queue) |
| `src/errors.ts` | `ParkingError` and its codes |
| `src/parking-lot.ts` | `ParkingLot`, `normalizePlate`, `Ticket`, `ExitQuote`, `Receipt` |
| `src/gates.ts` | `EntryGate`, `ExitGate`, device interfaces, timeout |
| `src/display-board.ts` | `DisplayBoard` |
| `src/demo.ts` | the demo |
