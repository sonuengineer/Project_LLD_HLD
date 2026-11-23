// A scripted day at a small lot, on a ManualClock, so the output is the same on every run.
// Run: npm run build && npm run demo
import {
  DisplayBoard,
  EntryGate,
  ExitGate,
  FakePaymentGateway,
  HOUR_MS,
  PayStation,
  HourlyPricing,
  MINUTE_MS,
  ManualClock,
  ParkingError,
  ParkingLot,
  type EntryDevice,
  type ExitDevice,
} from "./index.js";

const money = (minor: number) => (minor / 100).toFixed(2);
const why = (e: unknown) => (e instanceof ParkingError ? e.code : String(e));

const clock = new ManualClock(Date.UTC(2026, 10, 22, 9, 0));
const lot = new ParkingLot({
  layout: [
    ["small", "compact", "large"],
    ["compact", "large"],
  ],
  pricing: new HourlyPricing({ motorcycle: 2000, car: 5000, truck: 10000 }, { graceMinutes: 10, dailyCapHours: 8 }),
  clock,
  exitWindowMinutes: 15,
  lostTicketPenaltyMinor: 20000,
});
// A FAKE card provider: no real money. Its first charge goes through but the answer is "lost" on the way back.
const cards = new FakePaymentGateway(["lose-response"]);
const fast = { retryDelayMs: 0 };
const board = new DisplayBoard(lot);
lot.subscribe((row) => console.log(`  [board] L${row.level} ${row.size} -> ${row.free}/${row.total} free`));

// Printers and barriers that take a few milliseconds; the one at gate B jams once.
let jams = 1;
const printer = (gate: string): EntryDevice => ({
  issue: async (t) => {
    await new Promise((r) => setTimeout(r, 5));
    if (gate === "B" && jams-- > 0) throw new Error("paper jam");
    console.log(`  [gate ${gate}] ticket printed for ${t.plate}, spot ${t.spotId}`);
  },
});
const barrier: ExitDevice = { open: async (q) => console.log(`  [exit] barrier opens for ${q.ticket.plate} (bill ${money(q.feeMinor)})`) };
const gateA = new EntryGate(lot, printer("A"));
const gateB = new EntryGate(lot, printer("B"));
const exitGate = new ExitGate(lot, barrier, { gateway: cards, payment: fast });
const payStation = new PayStation(lot, cards, fast);

console.log("Opening board:\n" + board.render());

console.log("\nFive cars arrive at once at two gates; four spots fit a car; gate B's printer jams once:");
const arrivals = await Promise.allSettled([
  gateA.enter("MH12AB1111", "car"),
  gateB.enter("MH12AB2222", "car"),
  gateA.enter("MH12AB3333", "car"),
  gateB.enter("MH12AB4444", "car"),
  gateA.enter("MH12AB5555", "car"),
]);
arrivals.forEach((r, i) => console.log(`  car ${i + 1}: ${r.status === "fulfilled" ? `in at ${r.value.spotId}` : `refused (${why(r.reason)})`}`));

console.log("\nCar 1 tries to leave through two exits with a copied ticket, after 2 h 8 min:");
clock.advance(2 * HOUR_MS + 8 * MINUTE_MS);
const first = arrivals[0];
if (first.status === "fulfilled") {
  const [a, b] = await Promise.allSettled([exitGate.leave(first.value.id), exitGate.leave(first.value.id)]);
  console.log(`  exit 1: ${a.status === "fulfilled" ? `left, paid ${money(a.value.paidMinor)} by card` : why(a.reason)}`);
  console.log(`  exit 2: ${b.status === "fulfilled" ? "left" : `refused (${why(b.reason)})`}`);
  console.log(`  card provider: ${cards.calls} calls (the first answer was lost, the retry reused the key), ${cards.charges.length} charge of ${money(cards.totalChargedMinor())}`);
}

const third = arrivals[2];
if (third.status === "fulfilled") {
  console.log("\nCar 3 pays at the pay station, walks 10 minutes, then leaves:");
  const p = await payStation.pay(third.value.id);
  console.log(`  paid ${money(p.amountMinor)} at the station`);
  clock.advance(10 * MINUTE_MS);
  const r = await exitGate.leave(third.value.id);
  console.log(`  left within the 15 min window: owed nothing more (bill ${money(r.feeMinor)}, paid ${money(r.paidMinor)})`);
}

const fourth = arrivals[3];
if (fourth.status === "fulfilled") {
  console.log("\nCar 4 lost its ticket; the attendant issues a replacement:");
  const replacement = lot.reportLost(fourth.value.plate);
  console.log(`  bill now ${money(lot.quote(replacement.id))} (penalty included)`);
  try {
    await exitGate.leave(fourth.value.id);
  } catch (e) {
    console.log(`  someone tries the old ticket: ${why(e)}`);
  }
  const r = await exitGate.leave(replacement.id);
  console.log(`  left with the replacement, paid ${money(r.paidMinor)}`);
}

console.log("\nBoard now:\n" + board.render());
