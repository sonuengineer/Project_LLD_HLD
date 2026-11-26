// Races an async call against a deadline, same idiom as 17-parking-lot's device timeout. `run` gets an
// AbortSignal so a well-behaved store can stop its own work instead of leaving it dangling.
import { PasswordManagerError } from "./errors.js";

export async function withTimeout<T>(run: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    return await run(controller.signal);
  } catch (err) {
    if (timedOut) throw new PasswordManagerError("STORE_TIMEOUT", `the store did not respond within ${timeoutMs}ms`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
