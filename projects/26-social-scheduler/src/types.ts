// The shared vocabulary. A "channel" is just a string key into the providers map passed to the scheduler -- it is
// never a real integration (see providers.ts): this project never calls a real social media API.

// Per-channel delivery status. There is deliberately no separate "failed" status: a failed attempt that still has
// retries left stays "pending" (it is awaiting its next attempt); only exhausting every attempt is terminal, and
// that terminal state is "dead_letter". See PLAN.md ("one status enum, not two").
export type ChannelStatus = "pending" | "sent" | "dead_letter" | "canceled";

export interface ChannelDelivery {
  readonly channel: string;
  status: ChannelStatus;
  attempts: number; // how many times a provider.send() was actually called for this channel
  readonly maxAttempts: number;
  nextAttemptAt: number; // not dispatched before this epoch ms; meaningless once status is no longer "pending"
  providerId?: string; // set once status is "sent"
  lastError?: string; // the most recent failure reason (kept even after dead_letter, for diagnostics)
  sentAt?: number;
  canceledAt?: number;
}

export interface ScheduledPost {
  readonly id: string;
  readonly clientRequestId: string;
  content: string;
  readonly channels: readonly string[]; // as given at schedule time, original order
  scheduledAt: number;
  readonly createdAt: number;
  readonly deliveries: Record<string, ChannelDelivery>; // keyed by channel
}

// What a provider is asked to deliver. `attempt` is 1 on the first try, 2 on the first retry, and so on.
export interface OutboundPost {
  readonly postId: string;
  readonly channel: string;
  readonly content: string;
  readonly attempt: number;
}

export type ProviderResult = { status: "sent"; providerId: string } | { status: "failed"; reason: string };
