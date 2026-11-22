import type { ParkingSpot } from "./spot.js";
import type { SpotSize } from "./types.js";

// What an allocation strategy may ask: "the nearest free spot of this size". Nearest = lowest level, then lowest
// position, which is the order the lot lists its spots in.
export interface FreeSpots {
  nearest(size: SpotSize): ParkingSpot | undefined;
}

// Binary min-heap of numbers. Small and local instead of a dependency.
class MinHeap {
  private readonly a: number[] = [];

  get size(): number {
    return this.a.length;
  }

  peek(): number | undefined {
    return this.a[0];
  }

  push(x: number): void {
    const a = this.a;
    a.push(x);
    let i = a.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (a[parent]! <= a[i]!) break;
      [a[parent], a[i]] = [a[i]!, a[parent]!];
      i = parent;
    }
  }

  pop(): number | undefined {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length > 0 && last !== undefined) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l]! < a[m]!) m = l;
        if (r < a.length && a[r]! < a[m]!) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i]!, a[m]!];
        i = m;
      }
    }
    return top;
  }
}

// One heap per size, holding spot numbers (index in the lot's nearest-first list).
//
// Lazy deletion: taking a spot does NOT touch the heap. nearest() pops entries whose spot is no longer free until
// the top is free. A freed spot is pushed back only if it is not still in the heap (inHeap), so each heap holds at
// most one entry per spot. Cost: nearest() is O(log n) amortised, release is O(log n), reserve is O(1).
export class FreeSpotIndex implements FreeSpots {
  private readonly heaps = new Map<SpotSize, MinHeap>();
  private readonly inHeap: boolean[];
  private readonly numberOf = new Map<ParkingSpot, number>();

  constructor(private readonly spots: readonly ParkingSpot[]) {
    this.inHeap = spots.map(() => false);
    spots.forEach((spot, i) => {
      this.numberOf.set(spot, i);
      if (spot.isFree) this.push(spot.size, i);
    });
  }

  nearest(size: SpotSize): ParkingSpot | undefined {
    const heap = this.heaps.get(size);
    if (heap === undefined) return undefined;
    for (;;) {
      const i = heap.peek();
      if (i === undefined) return undefined;
      const spot = this.spots[i]!;
      if (spot.isFree) return spot;
      heap.pop();
      this.inHeap[i] = false;
    }
  }

  // The lot calls this every time a spot becomes free again.
  released(spot: ParkingSpot): void {
    const i = this.numberOf.get(spot);
    if (i === undefined || this.inHeap[i]) return;
    this.push(spot.size, i);
  }

  // Heap entries over all sizes, stale ones included. Never more than the number of spots (tested).
  entryCount(): number {
    let n = 0;
    for (const heap of this.heaps.values()) n += heap.size;
    return n;
  }

  private push(size: SpotSize, i: number): void {
    let heap = this.heaps.get(size);
    if (heap === undefined) {
      heap = new MinHeap();
      this.heaps.set(size, heap);
    }
    heap.push(i);
    this.inHeap[i] = true;
  }
}
