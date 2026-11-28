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

// `retryable` is OPTIONAL and defaults to true (retryable) when omitted -- this is stage 1's original behavior,
// kept so the three stage-1 fake providers do not have to change just because this field exists. Set it to
// `false` to mean "this will never succeed no matter how many times it is retried" (e.g. account disconnected,
// invalid credentials): dispatchChannel dead-letters that channel immediately instead of scheduling a retry.
// Mirrors project 21 (notification)'s `SendResult.retryable` in name and meaning; optional here (instead of
// required there) specifically so stage 1's existing ProviderResult-returning code needs no changes -- see
// PLAN.md Stage 2 decisions.
export type ProviderResult = { status: "sent"; providerId: string } | { status: "failed"; reason: string; retryable?: boolean };
