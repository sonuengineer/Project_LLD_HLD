// The one shape every policy wraps: an async function that receives an AbortSignal and should stop its work (close
// the socket, cancel the query) when that signal is aborted. fetch(url, { signal }) is exactly this shape.
export type Operation<T> = (signal: AbortSignal) => Promise<T>;

// A policy runs an operation with some protection around it. `signal` is the caller's own cancel signal (for
// example the incoming HTTP request being closed); a policy must stop as soon as it is aborted.
export interface Policy {
  execute<T>(operation: Operation<T>, signal?: AbortSignal): Promise<T>;
}
