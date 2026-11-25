// Channels are a Strategy: the notifier knows ChannelSender, not SES / Twilio / FCM. Stage 1 ships fakes only; a real
// provider is one more class implementing this interface (and is never called from this project's tests).
import type { Channel, OutboundMessage, SendResult } from "./types.js";

export interface ChannelSender {
  readonly channel: Channel;
  // Must not throw for a provider's "no"; return failed. A throw is still handled (treated as retryable: the outcome
  // is unknown, the provider may have sent it). `signal` aborts when the caller stops waiting (stage 2's timeout).
  send(message: OutboundMessage, signal?: AbortSignal): Promise<SendResult>;
}

export type FakeOutcome =
  | SendResult
  | "throw"
  | ((message: OutboundMessage, signal?: AbortSignal) => Promise<SendResult> | SendResult);

// A fake provider: records what it was asked to send and answers from a script (default: sent).
export class FakeSender implements ChannelSender {
  readonly sent: OutboundMessage[] = []; // successful sends only
  readonly attempts: OutboundMessage[] = []; // every call
  private readonly script: FakeOutcome[] = [];
  private counter = 0;

  constructor(readonly channel: Channel) {}

  // Outcomes for the next calls, in order; after the script runs out, every call succeeds.
  willAnswer(...outcomes: FakeOutcome[]): this {
    this.script.push(...outcomes);
    return this;
  }

  async send(message: OutboundMessage, signal?: AbortSignal): Promise<SendResult> {
    this.attempts.push({ ...message });
    const next = this.script.shift();
    let result: SendResult;
    if (next === undefined) result = { status: "sent", providerId: `${this.channel}-${++this.counter}` };
    else if (next === "throw") throw new Error(`${this.channel} provider exploded`);
    else if (typeof next === "function") result = await next(message, signal);
    else result = next;
    if (result.status === "sent") this.sent.push({ ...message });
    return result;
  }
}
