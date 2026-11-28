// Anti-replay for a single session's receive direction, the same sliding-bitmap idea real WireGuard uses
// (RFC 6479-style). A per-session monotonically increasing counter is the AEAD nonce (see session.ts); this
// window is what stops an attacker who captured a valid ciphertext from simply resending it later. It must:
//   - accept a brand new (higher than anything seen) counter
//   - accept an out-of-order counter that is still within `size` of the highest one seen, as long as THAT
//     exact counter has not been accepted before
//   - reject an exact repeat of an already-accepted counter ("REPLAY")
//   - reject a counter so far behind the highest one seen that it could not possibly still be in the window
//     ("TOO_OLD") -- this also covers 0 or a negative/non-integer counter when nothing has moved the window yet
//
// This is the single most important invariant in the whole project: get it wrong and either legitimate
// reordered packets get dropped, or a captured packet can be replayed. It is deliberately a pure, dependency-
// free data structure so it can be tested exhaustively on its own, independent of any crypto or networking.
const BITS_PER_BYTE = 8;

export type ReplayCheck = "ACCEPT" | "REPLAY" | "TOO_OLD";

export class AntiReplayWindow {
  private highest = -1; // -1: nothing accepted yet -- every non-negative counter is then a new high
  private readonly bitmap: Uint8Array;

  constructor(readonly size = 2048) {
    if (!Number.isInteger(size) || size <= 0 || size % BITS_PER_BYTE !== 0) {
      throw new RangeError("window size must be a positive multiple of 8");
    }
    this.bitmap = new Uint8Array(size / BITS_PER_BYTE);
  }

  // Pure check: does NOT mutate state. Call this before attempting to decrypt -- it is a cheap way to drop an
  // obviously-replayed or too-old packet without paying for an AEAD decrypt. See record()'s doc comment for
  // why marking a counter as seen must wait until AFTER the packet authenticates.
  check(counter: number): ReplayCheck {
    if (!Number.isInteger(counter) || counter < 0) return "TOO_OLD"; // malformed counter: never acceptable
    if (counter <= this.highest - this.size) return "TOO_OLD";
    if (counter > this.highest) return "ACCEPT"; // new high water mark: cannot have been seen before
    return this.isSet(counter) ? "REPLAY" : "ACCEPT";
  }

  // Marks `counter` as seen. Callers MUST call this only after check() returned "ACCEPT" for the same counter
  // AND the packet's AEAD tag has verified. Recording an unauthenticated counter would let an attacker burn a
  // legitimate counter value just by guessing it and sending garbage with that counter in the header -- the
  // real sender's later, genuine packet with that counter would then be rejected as a "replay" it never was.
  record(counter: number): void {
    if (counter > this.highest) {
      // The window is sliding forward from `highest` to `counter`. Every slot that will hold one of the newly
      // in-window counters must be cleared first, because that slot's bit may still be set from a much older
      // counter that mapped to the same slot (slots repeat every `size` counters) and is now out of the window.
      // Bounding the loop at `size` iterations keeps this O(size) even if `counter` jumps far ahead at once.
      const from = Math.max(this.highest + 1, counter - this.size + 1);
      for (let c = from; c <= counter; c++) this.clear(c);
      this.highest = counter;
    }
    this.set(counter);
  }

  private slot(counter: number): number {
    return counter % this.size;
  }

  private isSet(counter: number): boolean {
    const bit = this.slot(counter);
    return (this.bitmap[bit >> 3]! & (1 << (bit & 7))) !== 0;
  }

  private set(counter: number): void {
    const bit = this.slot(counter);
    this.bitmap[bit >> 3]! |= 1 << (bit & 7);
  }

  private clear(counter: number): void {
    const bit = this.slot(counter);
    this.bitmap[bit >> 3]! &= ~(1 << (bit & 7));
  }
}
