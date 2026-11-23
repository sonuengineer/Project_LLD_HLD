// The one shape every policy wraps: an async function that receives an AbortSignal and should stop its work (close
// the socket, cancel the query) when that signal is aborted. fetch(url, { signal }) is exactly this shape.
export type Operation<T> = (signal: AbortSignal) => Promise<T>;

// A policy runs an operation with some protection around it. `signal` is the caller's own cancel signal (for
// example the incoming HTTP request being closed); a policy must stop as soon as it is aborted.
export interface Policy {
  execute<T>(operation: Operation<T>, signal?: AbortSignal): Promise<T>;
}

// The signal policies hand to the operation when the caller gave none. ONE shared instance that never aborts, so a
// policy can recognise it and skip adding abort listeners to it: with many concurrent calls those listeners piled up
// on this one signal and Node printed a (false) MaxListenersExceededWarning (found while writing the interview bank;
// test in wrap.test.ts).
export const NEVER: AbortSignal = new AbortController().signal;

// The caller's signal, or undefined when there is nothing to listen to.
export function listenable(signal: AbortSignal | undefined): AbortSignal | undefined {
  return signal === NEVER ? undefined : signal;
}
