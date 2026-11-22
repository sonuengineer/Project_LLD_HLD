import { describe, expect, it } from "vitest";
import { DisplayBoard } from "../src/display-board.js";
import { EventQueue } from "../src/events.js";
import { ParkingLot } from "../src/parking-lot.js";
import { HourlyPricing } from "../src/pricing.js";

const noErrors = (e: unknown) => {
  throw e;
};

describe("EventQueue", () => {
  it("delivers to every listener in subscription order", () => {
    const q = new EventQueue<number>(noErrors);
    const log: string[] = [];
    q.subscribe((n) => log.push(`a${n}`));
    q.subscribe((n) => log.push(`b${n}`));
    q.emit(1);
    expect(log).toEqual(["a1", "b1"]);
  });

  it("an event emitted by a listener is delivered after the current one reached everyone", () => {
    const q = new EventQueue<number>(noErrors);
    const log: string[] = [];
    q.subscribe((n) => {
      log.push(`a${n}`);
      if (n === 1) q.emit(2);
    });
    q.subscribe((n) => log.push(`b${n}`));
    q.emit(1);
    // Nested delivery would give a1 a2 b2 b1: b would end on the stale event 1.
    expect(log).toEqual(["a1", "b1", "a2", "b2"]);
  });

  it("unsubscribing during delivery stops delivery to that listener at once", () => {
    const q = new EventQueue<number>(noErrors);
    const log: string[] = [];
    let offB = () => {};
    q.subscribe(() => offB());
    offB = q.subscribe((n) => log.push(`b${n}`));
    q.emit(1);
    expect(log).toEqual([]);
  });

  it("a listener subscribed during delivery gets the next event, not the current one", () => {
    const q = new EventQueue<number>(noErrors);
    const log: number[] = [];
    let added = false;
    q.subscribe(() => {
      if (!added) {
        added = true;
        q.subscribe((n) => log.push(n));
      }
    });
    q.emit(1);
    q.emit(2);
    expect(log).toEqual([2]);
  });

  it("unsubscribe is idempotent", () => {
    const q = new EventQueue<number>(noErrors);
    const log: number[] = [];
    const off = q.subscribe((n) => log.push(n));
    off();
    off();
    q.emit(1);
    expect(log).toEqual([]);
  });
});

describe("re-entrant listener on the lot", () => {
  it("a listener that parks a car in reaction to an event leaves every board correct", () => {
    const lot = new ParkingLot({
      layout: [["compact", "compact", "compact"]],
      pricing: new HourlyPricing({ motorcycle: 1, car: 1, truck: 1 }),
      onListenerError: noErrors,
    });
    // The valet listener subscribes FIRST, so the board's listener runs after the nested park.
    let parkedByValet = false;
    lot.subscribe(() => {
      if (!parkedByValet) {
        parkedByValet = true;
        lot.park("VALET1", "car");
      }
    });
    const board = new DisplayBoard(lot);
    lot.park("A1", "car");
    expect(lot.availability()[0]!.free).toBe(1);
    expect(board.rows()).toEqual(lot.availability());
  });
});

describe("DisplayBoard", () => {
  it("starts from availability() and follows every change; close() stops it", () => {
    const lot = new ParkingLot({
      layout: [["small", "compact"], ["large"]],
      pricing: new HourlyPricing({ motorcycle: 1, car: 1, truck: 1 }),
    });
    lot.park("M1", "motorcycle");
    const board = new DisplayBoard(lot);
    expect(board.render()).toBe("L0 small   FULL\nL0 compact 1 free\nL1 large   1 free");
    const t = lot.park("T1", "truck");
    expect(board.rows()).toEqual(lot.availability());
    board.close();
    lot.exit(t.id);
    expect(board.rows()[2]!.free).toBe(0); // no longer updated
    expect(lot.availability()[2]!.free).toBe(1);
  });
});
