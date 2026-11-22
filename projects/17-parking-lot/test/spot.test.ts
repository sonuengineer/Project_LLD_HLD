import { describe, expect, it } from "vitest";
import { ParkingSpot } from "../src/spot.js";

describe("ParkingSpot", () => {
  it("starts free, is held after occupy, free after release", () => {
    const s = new ParkingSpot("L0-1", 0, 0, "compact");
    expect(s.isFree).toBe(true);
    s.occupy("t1");
    expect(s.isFree).toBe(false);
    expect(s.heldBy).toBe("t1");
    s.release("t1");
    expect(s.isFree).toBe(true);
    expect(s.heldBy).toBeNull();
  });

  it("refuses to be occupied twice and keeps the first ticket", () => {
    const s = new ParkingSpot("L0-1", 0, 0, "compact");
    s.occupy("t1");
    expect(() => s.occupy("t2")).toThrow(expect.objectContaining({ code: "SPOT_STATE" }));
    expect(s.heldBy).toBe("t1");
  });

  it("refuses a release with the wrong ticket and stays held", () => {
    const s = new ParkingSpot("L0-1", 0, 0, "compact");
    s.occupy("t1");
    expect(() => s.release("t2")).toThrow(expect.objectContaining({ code: "SPOT_STATE" }));
    expect(s.heldBy).toBe("t1");
  });

  it("refuses to release a free spot", () => {
    const s = new ParkingSpot("L0-1", 0, 0, "compact");
    expect(() => s.release("t1")).toThrow(expect.objectContaining({ code: "SPOT_STATE" }));
  });
});
