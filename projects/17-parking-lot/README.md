# B1 Parking Lot (low-level design)

A parking lot as a small TypeScript library: levels of spots in three sizes, tickets, two allocation strategies,
hourly pricing with a grace period and a daily cap, async entry and exit gates that are safe when they run at the
same time, payments through a (fake) card provider with idempotent retries, pay-then-exit, lost tickets, and display
boards that follow the lot through events. No runtime dependencies, in memory.

Status (2026-11-23): **stages 1-3 done** -- 171 tests pass (Windows, Node 20). Stage 3 mutation run: 63 deliberate
breaks, 61 caught at first; the 2 survivors were test gaps, closed, and both are caught now. No real payment
provider, no real money, no credentials anywhere.

## Classes

```
  EntryGate ---- EntryDevice (printer + barrier, async)        DisplayBoard (Observer)
  ExitGate  ---- ExitDevice  (fee display + barrier, async)         ^ subscribe(): availability events
      |     \--- PaymentGateway (card reader, optional)            |
  PayStation --- PaymentGateway  <-- FakePaymentGateway (tests, demo)
      |                                                            |
      | reserve / confirm / cancel                                 |
      | beginPayment / recordPayment / abortPayment                |
      | beginExit / [recordPayment] / commitExit / abortExit       |
      v                                                            |
  +--------------------------------------------------------------------+
  | ParkingLot   (all methods synchronous; check everything, then change)|
  |   park / exit (one-step), quote, billFor, reportLost, statusOf,      |
  |   findByPlate, paymentsFor, availability                             |
  +--------------------------------------------------------------------+
      | owns 1..n       | owns 1         | uses 1              | uses 1          | uses 1
      v                 v                v                     v                 v
  ParkingSpot      FreeSpotIndex    AllocationStrategy     PricingStrategy     Clock
  free/reserved/   min-heap per     choose(vehicle, free)  fee(vehicle,        now()
  occupied         size, lazy       smallestFitFirst       entry, exit)       systemClock
                   deletion         nearestFirst           HourlyPricing      ManualClock
```

`Ticket`, `PaymentQuote`, `ExitQuote`, `Payment`, `Receipt` and events are frozen plain objects. `VehicleType` (`motorcycle | car | truck`)
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

## Payments (stage 3)

No real payment provider is integrated. `PaymentGateway` is an interface; the only implementation is
`FakePaymentGateway`, an in-memory stand-in that can be scripted to approve, decline, fail, hang, or **charge and
then lose the answer**. No money moves, no credentials exist.

**Same shape as the gates: lock, slow part, record or roll back.**

```
PayStation.pay:   lot.beginPayment()  --charge-->  lot.recordPayment()          (failure: lot.abortPayment())
ExitGate.leave:   lot.beginExit() --charge if due--> lot.recordPayment() --barrier--> lot.commitExit()
                                                                       (any failure: lot.abortExit())
```

- `beginPayment` / `beginExit` lock the ticket (`TICKET_BUSY` for a second station or gate) and fix the amount. The
  amount recorded is always the locked one, never a number passed in by the caller.
- **The barrier rule is in the lot:** `commitExit` refuses with `PAYMENT_REQUIRED` while anything is due. A gate
  without a card reader cannot let an unpaid car out even if its code is wrong (mutation P24).
- **Idempotency key.** Each lock gets a fresh random `paymentKey`; every retry of that payment sends the SAME key.
  If the provider charged but the answer was lost, the retry gets the first payment back instead of a second
  charge (tested with `lose-response`, and in the randomized test: total charged by the provider == total recorded
  by the lot, for its 5 fixed seeds).
- **Decline vs unknown.** A decline is final (`PAYMENT_DECLINED`, no retry). Any other error is "outcome unknown":
  retried up to 3 times with a timeout each; still failing -> `PAYMENT_UNKNOWN`, the lock is released and nothing is
  recorded. The money MAY have been taken in that case; finding out needs the provider's records (reconciliation),
  which is NOT built. **Known double-charge path:** if the attempts go fail, fail, lose-response, the provider has
  charged but the lot recorded nothing; the next payment try gets a new lock and a NEW key, so the customer is
  charged again. Only reconciliation (or keeping the unresolved key and asking the provider about it first) closes
  this. Not built; the randomized test's 5 seeds never produce that sequence.
- **Paid at the gate, then the barrier failed:** the exit is aborted but the payment stays recorded, so the next try
  owes nothing (tested: one charge across both tries).

**Pay, then leave within the window.** After a payment, the stay is priced as of that payment for
`exitWindowMinutes` (default 15). After the window, the bill is fee(now) - paid: only the extra time, never the first
part again. This relies on the fee never going down for a longer stay (tested every 7 minutes over 3 days, with and
without a cap).

**Lost ticket.** `reportLost(plate)` (the attendant has checked ownership -- not modelled) issues a REPLACEMENT
ticket for the same stay and spot, adds `lostTicketPenaltyMinor`, keeps earlier payments, and kills the old ticket
id: whoever holds the "lost" ticket gets `TICKET_REPLACED` (it may have been stolen).

**Attendant booth.** The one-step `exit()` collects whatever is due as a cash payment (`cash-...` id) and lets the
car out, so the receipt always shows how the fee was paid.

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

**How much.** `HourlyPricing(ratesPerHourMinor, { graceMinutes, dailyCapHours })`:
- rates are integers in minor units (5000 = 50.00), one per vehicle type, all required, none negative;
- a stay up to and including the grace period is free;
- above it, every started hour of the WHOLE stay is charged (70 min with 10 min grace = 2 hours, not 1);
- with `dailyCapHours` (1-24), at most that many hours are charged per started 24 h counted from entry
  (cap 8: 25 h = 8 + 1 = 9 hours);
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
| `INVALID_RATE` | negative, fractional, missing or NaN rate; negative grace; daily cap outside 1-24 |
| `INVALID_OPTION` | exit window or lost-ticket penalty not a non-negative integer |
| `INVALID_PLATE` / `INVALID_VEHICLE` | bad input to reserve / park |
| `ALREADY_PARKED` | that plate is inside or entering at another gate |
| `LOT_FULL` | no free spot fits this vehicle (spots of other sizes may be free) |
| `RESERVATION_NOT_FOUND` | confirm / cancel of something that is not a pending reservation |
| `TICKET_NOT_ACTIVE` | unknown ticket, already used, or the car is not in yet |
| `TICKET_BUSY` | a payment or exit with this ticket is already in progress |
| `TICKET_REPLACED` | the ticket was reported lost and replaced |
| `EXIT_NOT_STARTED` | commitExit / abortExit without beginExit |
| `NOTHING_DUE` | beginPayment with nothing to pay; recordPayment when the locked amount is already paid |
| `PAYMENT_NOT_STARTED` | recordPayment / abortPayment without a matching lock |
| `INVALID_PAYMENT_ID` | empty or already recorded payment id |
| `PAYMENT_REQUIRED` | commitExit while money is due; an exit gate without a card reader and an unpaid ticket |
| `PAYMENT_DECLINED` | the provider said no; nothing charged |
| `PAYMENT_UNKNOWN` | all attempts failed without a clear answer; the charge may have happened (see Payments) |
| `INVALID_TIME` | exit before entry |
| `DEVICE_FAILED` | a gate's device failed or timed out; the claim was rolled back (`cause` has the device error) |
| `STRATEGY_BUG` | a plugged-in strategy returned something invalid |
| `SPOT_STATE` | invalid spot transition (internal guard) |

## Design choices

Why Strategy for allocation and pricing, why State, Factory, Singleton and a Level class were NOT used, and why
claims instead of a mutex, are in [PLAN.md](PLAN.md) "Decisions".

## Tests

`npm test` -- 171 tests in `test/`:

| File | Proves |
|---|---|
| `types.test.ts` | the full fits table, written out by hand (9) |
| `spot.test.ts` | free -> reserved -> occupied -> free, cancel, transfer only from the holder, every refused transition keeps the holder (6) |
| `allocation.test.ts` | fitting sizes; both strategies against a hand-made index: size preference, level then position, never a size that does not fit (9) |
| `free-index.test.ts` | nearest per size, lazy deletion, no duplicate entries, 3000 random steps against a brute-force scan (4) |
| `pricing.test.ts` | started hours, per-type rates, grace boundary, whole-stay charge, daily cap within and across days, fee never decreases over 3 days, invalid rates and caps, rates copied (20) |
| `payment.test.ts` | fake gateway (idempotent replay, reused key with another amount refused, lose-response); chargeWithRetry: same key on retry, decline not retried, unknown after N failures with the cause, hang -> timeout -> retry, retry delay, missing payment id (13) |
| `money.test.ts` | payment lock and its refusals, exit window boundary, only extra time after the window, second payment's own window, PAYMENT_REQUIRED, cash at the booth, PayStation (lost response, decline, unknown, two stations at once, nothing due), exit gate with and without a card reader, paid then barrier failed -> no second charge, lost ticket (replacement, penalty, old id dead, payments kept, refusals) (26) |
| `parking-lot.test.ts` | layout, park / exit / quote, both strategies through the lot, LOT_FULL per size, duplicate plate, clock backwards, bad strategies (incl. another lot's spot), frozen tickets; every error compares the whole lot before and after (35) |
| `two-phase.test.ts` | reserve / confirm / cancel, beginExit / commitExit / abortExit, fixed fee while exiting, event counts per operation, no events on failure, throwing listeners and error handlers (15) |
| `events.test.ts` | queue order with a re-entrant emit, unsubscribe / subscribe during delivery, a re-entrant listener on the real lot, DisplayBoard (7) |
| `gates.test.ts` | the race with naive gates (2 barriers for 1 spot, 2 barriers for 1 ticket), then the real gates: one ticket printed, same plate at two gates, reserved while the device runs, device failure / sync throw / timeout with abort and a late answer, no timer left behind, TICKET_BUSY at the second exit, barrier failure keeps the ticket valid (12) |
| `invariants.test.ts` | 500 random synchronous steps x 5 seeds x 2 strategies, every park compared with the stage 1 full scan; 400 random steps x 5 seeds with 3 entry + 2 exit gates and devices answering in random order (15% failures); after every step: spot states match ticket statuses, tickets hold their own fitting spot, no plate twice, board = availability(), every pending device call is backed by a claim; exit gates pay through a fake provider that declines, fails or loses answers at random, and at the end the provider's total charged == the lot's total recorded, payment ids are unique, and every car that left paid its full fee (15) |

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

Caught by exactly one test at stage 2 (deleting that test would hide them): S3, S5, S6, S7, S14, S19, S20, S22, S24,
M15, M16.

Stage 3 (2026-11-23, against the 170 tests, then 171): 24 new payment breaks, plus the stage 2 and stage 1 breaks
re-run on the new code (S4 and S17 no longer apply as written: the exit gate and the lock were rewritten; S26 is
new). 63 in total, **61 caught at first**:

| # | Break | Failed |
|---|---|---|
| P1 | commitExit lets a car out with money due | 2 |
| P2 | retries use a new idempotency key | 7 |
| P3 | a decline is retried | 8 |
| P4 | exit window boundary exclusive | 1 |
| P5 | exit window ignored | 3 |
| P6 | payments not subtracted from the fee | 12 |
| P7 | lost-ticket penalty not added | 2 |
| P8 | old ticket still valid after a lost-ticket report | 1 |
| P9 | replacement ticket forgets earlier payments | 1 |
| P10 | replaced ticket ids not remembered (TICKET_NOT_ACTIVE instead of TICKET_REPLACED) | 1 |
| P11 | abortExit drops recorded payments | 6 |
| P12 | pay station does not abort on failure | 2 |
| P13 | beginPayment / beginExit do not lock the ticket | 47 |
| P14 | no NOTHING_DUE check | 2 |
| P15 | a payment id can be recorded twice | 1 |
| P16 | fake gateway not idempotent | 5 |
| P17 | daily cap not applied to the last part-day | 2 |
| P18 | full days charged at 24 h instead of the cap | 2 |
| P19 | exit gate charges even when nothing is due | 4 |
| P20 | exit gate reports payment errors as DEVICE_FAILED | 7 |
| P21 | a recorded station payment keeps the ticket locked | 8 |
| P22 | the same payment key for every lock of a ticket | 3 |
| P23 | the full fee recorded instead of the locked due amount | 6 |
| P24 | exit gate without a card reader lets an unpaid car out | 1 |

Stage 2 re-run: S1 9, S2 4, S3 4, S5 1, S6 1, S7 1, S8 12, S9 11, S10 2, S11 7, S12 2, S13 2, S14 1, S15 1, S16 1,
S18 9, S19 10, S20 1, S21 20, S22 1, S23 7, S25 1. Stage 1 re-run: fits boundary 83, car fits small 7, duplicate
plate 18, plate not normalised 6, locked before pricing 2, plate index kept 18, hours rounded down 7, grace boundary
2, fee unchecked 3, ticket not frozen 1, release ignores the holder 1, counter ids 16.

**Correction (2026-11-23).** The first stage 3 run started vitest from a lowercase drive path (`h:\...`). Found
later in the resilience library (`projects/18-resilience/README.md`, "A test-environment finding"): from such a path
vitest can intermittently load a module twice, so `instanceof` fails against the other copy and EXTRA tests fail. The
whole stage 3 list was re-run from `H:\...`: every break is still caught, but 13 counts were inflated and the tables
above now show the re-run values (e.g. P6 was 23, is 12; S16 was 12, is 1; grace boundary was 12, is 2). The stage 1
and stage 2 tables further up came from the same kind of run on code that no longer exists, so their counts are as
recorded then and were not re-verified.

**The 2 that survived, and the fix:**
- **S24** ("nearer" compares only the level) -- 0 failures. The "same level" allocation test put the compact spot
  BEFORE the large one, so taking sizes in order gave the right answer by luck. The test now puts the large spot
  nearer; S24 is caught (1).
- **S26** (`spot.transfer` does not check the holder) -- 0 failures. Nothing called transfer with the wrong ticket.
  New spot test; S26 is caught (1).

## NOT implemented (after stage 3)

- A real payment provider, refunds, and reconciliation of `PAYMENT_UNKNOWN` (asking the provider whether the
  charge with that idempotency key happened). The fake declines are not remembered per key, unlike most real
  providers.
- Ownership checks for a lost ticket (documents, plate photo): the attendant's job, not modelled.
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
npm run build && npm run demo     # two gates, a printer jam, a copied ticket, a lost card answer, pay station, lost ticket
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
| `src/parking-lot.ts` | `ParkingLot`, `normalizePlate`, `Ticket`, `Bill`, `Payment`, `PaymentQuote`, `ExitQuote`, `Receipt` |
| `src/gates.ts` | `EntryGate`, `ExitGate` (with an optional card reader), device interfaces |
| `src/payment.ts` | `PaymentGateway`, `PaymentDeclinedError`, `chargeWithRetry` |
| `src/fake-gateway.ts` | `FakePaymentGateway` (scripted outcomes, idempotent by key; moves no money) |
| `src/pay-station.ts` | `PayStation` |
| `src/timeout.ts` | `withTimeout` (AbortSignal on timeout), `sleep` |
| `src/display-board.ts` | `DisplayBoard` |
| `src/demo.ts` | the demo |
