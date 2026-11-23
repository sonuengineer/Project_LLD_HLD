// Run async work with a deadline. On timeout the AbortSignal given to the work is aborted (so a well-behaved device
// or gateway stops) and the returned promise rejects. A late answer after the timeout is ignored.
export async function withTimeout<T>(work: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`no answer within ${timeoutMs} ms`));
    }, timeoutMs);
  });
  try {
    // async wrapper: work that throws synchronously becomes a rejection like any other failure.
    return await Promise.race([(async () => work(controller.signal))(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
