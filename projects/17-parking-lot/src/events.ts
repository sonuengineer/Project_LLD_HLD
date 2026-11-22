// Observer with a delivery queue.
//
// Why a queue: if a listener reacts to event 1 by changing the lot (which emits event 2), plain nested delivery
// would hand event 2 to the remaining listeners BEFORE event 1. A display board would then end on event 1's stale
// count. With the queue, event 2 is delivered after event 1 has reached every listener, so all listeners see the
// events in the order the changes happened (tested in events.test.ts).

export type Listener<E> = (event: E) => void;

export class EventQueue<E> {
  private readonly listeners = new Set<Listener<E>>();
  private readonly queue: E[] = [];
  private delivering = false;

  constructor(private readonly onListenerError: (error: unknown, event: E) => void) {}

  subscribe(listener: Listener<E>): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // Called by the lot AFTER its state change is complete, so a listener that calls back into the lot sees a
  // consistent lot. A listener that throws is reported and skipped: it cannot undo the change that already
  // happened, and it must not stop the other listeners.
  emit(event: E): void {
    this.queue.push(event);
    if (this.delivering) return; // the outer emit() drains the queue
    this.delivering = true;
    try {
      for (let next = this.queue.shift(); next !== undefined; next = this.queue.shift()) {
        // A copy, so subscribing during delivery does not add a listener to THIS event; the has() check skips a
        // listener that was unsubscribed during delivery.
        for (const listener of [...this.listeners]) {
          if (!this.listeners.has(listener)) continue;
          try {
            listener(next);
          } catch (error) {
            try {
              this.onListenerError(error, next);
            } catch {
              // An error handler that throws must not break the lot either.
            }
          }
        }
      }
    } finally {
      this.delivering = false;
    }
  }
}
