// One event type for every policy, so ONE handler can feed logs and metrics:
//   onEvent: (e) => metrics.inc(`resilience_${e.type}`, { policy: e.policy })
// Every policy takes `name` (default: its kind) and `onEvent`. A handler that throws is ignored: telemetry must
// never change what the caller gets.
import type { GiveUpReason } from "./retry.js";

export type ResilienceEvent =
  | { readonly type: "timeout"; readonly policy: string; readonly timeoutMs: number }
  | { readonly type: "retry"; readonly policy: string; readonly attempt: number; readonly delayMs: number; readonly error: unknown }
  | { readonly type: "give-up"; readonly policy: string; readonly attempts: number; readonly reason: GiveUpReason; readonly error: unknown }
  | { readonly type: "breaker-state"; readonly policy: string; readonly from: string; readonly to: string }
  | { readonly type: "breaker-rejected"; readonly policy: string; readonly state: "open" | "half-open" }
  | { readonly type: "bulkhead-rejected"; readonly policy: string; readonly running: number; readonly queued: number };

export type ResilienceEventHandler = (event: ResilienceEvent) => void;

export interface Observable {
  name?: string;
  onEvent?: ResilienceEventHandler;
}

export function emit(handler: ResilienceEventHandler | undefined, event: ResilienceEvent): void {
  if (handler === undefined) return;
  try {
    handler(event);
  } catch {
    // ignored on purpose, see above
  }
}
