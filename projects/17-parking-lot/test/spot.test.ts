import { describe, expect, it } from "vitest";
import { ParkingSpot } from "../src/spot.js";

const spot = () => new ParkingSpot("L0-1", 0, 0, "compact");
const err = { code: "SPOT_STATE" };

describe("ParkingSpot", () => {
  it("free -> reserved -> occupied -> free", () => {
    const s = spot();
    expect(s.state).toBe("free");
    s.reserve("t1");
    expect([s.state, s.heldBy, s.isFree]).toEqual(["reserved", "t1", false]);
    s.confirm("t1");
    expect([s.state, s.heldBy]).toEqual(["occupied", "t1"]);
    s.release("t1");
    expect([s.state, s.heldBy, s.isFree]).toEqual(["free", null, true]);
  });

  it("reserved -> free (cancel)", () => {
    const s = spot();
    s.reserve("t1");
    s.release("t1");
    expect(s.state).toBe("free");
  });

  it("refuses to reserve a reserved or occupied spot and keeps the holder", () => {
    const s = spot();
    s.reserve("t1");
    expect(() => s.reserve("t2")).toThrow(expect.objectContaining(err));
    s.confirm("t1");
    expect(() => s.reserve("t2")).toThrow(expect.objectContaining(err));
    expect([s.state, s.heldBy]).toEqual(["occupied", "t1"]);
  });

  it("refuses confirm when free, already occupied, or with the wrong ticket", () => {
    const s = spot();
    expect(() => s.confirm("t1")).toThrow(expect.objectContaining(err));
    s.reserve("t1");
    expect(() => s.confirm("t2")).toThrow(expect.objectContaining(err));
    expect(s.state).toBe("reserved");
    s.confirm("t1");
    expect(() => s.confirm("t1")).toThrow(expect.objectContaining(err));
  });

  it("transfer moves an occupied spot to a new ticket, only from its holder", () => {
    const s = spot();
    expect(() => s.transfer("t1", "t2")).toThrow(expect.objectContaining(err)); // free
    s.reserve("t1");
    expect(() => s.transfer("t1", "t2")).toThrow(expect.objectContaining(err)); // only reserved
    s.confirm("t1");
    expect(() => s.transfer("x", "t2")).toThrow(expect.objectContaining(err)); // not the holder
    expect(s.heldBy).toBe("t1");
    s.transfer("t1", "t2");
    expect([s.state, s.heldBy]).toEqual(["occupied", "t2"]);
  });

  it("refuses release when free or with the wrong ticket, and stays held", () => {
    const s = spot();
    expect(() => s.release("t1")).toThrow(expect.objectContaining(err));
    s.reserve("t1");
    s.confirm("t1");
    expect(() => s.release("t2")).toThrow(expect.objectContaining(err));
    expect([s.state, s.heldBy]).toEqual(["occupied", "t1"]);
  });
});
