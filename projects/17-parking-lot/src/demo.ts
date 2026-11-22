// A scripted day at a small lot, on a ManualClock, so the output is the same on every run.
// Run: npm run build && npm run demo
import { HOUR_MS, HourlyPricing, MINUTE_MS, ManualClock, ParkingError, ParkingLot, type Availability } from "./index.js";

const money = (minor: number) => (minor / 100).toFixed(2);
const board = (rows: Availability[]) =>
  rows.map((r) => `  level ${r.level} ${r.size.padEnd(7)} ${r.free}/${r.total} free`).join("\n");

const clock = new ManualClock(Date.UTC(2026, 10, 22, 9, 0));
const lot = new ParkingLot({
  layout: [
    ["small", "compact", "compact", "large"],
    ["compact", "large"],
  ],
  pricing: new HourlyPricing({ motorcycle: 2000, car: 5000, truck: 10000 }, { graceMinutes: 10 }),
  clock,
});

console.log("Opening:\n" + board(lot.availability()));

const bike = lot.park("KA01 AB 1111", "motorcycle");
const car = lot.park("mh-12-cd-2222", "car");
const truck = lot.park("DL3C EF 3333", "truck");
console.log(`\nParked: ${bike.plate} -> ${bike.spotId}, ${car.plate} -> ${car.spotId}, ${truck.plate} -> ${truck.spotId}`);

try {
  lot.park("MH12CD2222", "car");
} catch (e) {
  if (e instanceof ParkingError) console.log(`Same car again: ${e.code}`);
}

clock.advance(8 * MINUTE_MS);
const r1 = lot.exit(bike.id);
console.log(`\n${r1.ticket.plate} leaves after 8 min (grace is 10): fee ${money(r1.feeMinor)}`);

clock.advance(2 * HOUR_MS);
const r2 = lot.exit(car.id);
console.log(`${r2.ticket.plate} leaves after 2 h 8 min: 3 started hours x 50.00 = ${money(r2.feeMinor)}`);

try {
  lot.exit(car.id);
} catch (e) {
  if (e instanceof ParkingError) console.log(`Same ticket again: ${e.code}`);
}

console.log(`\nStill inside: ${lot.activeTickets.map((t) => `${t.plate} (${t.spotId})`).join(", ")}`);
console.log("Board now:\n" + board(lot.availability()));
