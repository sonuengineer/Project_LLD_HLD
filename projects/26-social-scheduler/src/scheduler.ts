// The scheduler core: schedule a post against N channels, fan out to one independent ChannelDelivery per channel,
// dispatch due ones from tick() with retry + backoff, dead-letter a channel that exhausts its attempts, cancel or
// edit a post/channel while it is still pending. See PLAN.md for the reasoning behind each rule.
//
// Stage 1 is fully synchronous on the SCHEDULING path: schedulePost() validates, builds the post and registers the
// idempotency key without ever awaiting anything. Because of that, a plain "check the map, then set it" is enough
// to make two back-to-back calls with the same clientRequestId safe -- JavaScript runs that whole function body as
// one synchronous turn, so a second call can only ever start after the first one has already returned. (Contrast
// with projects/22-messaging stage 2, where a REAL await before the commit meant the map check alone was not
// enough and a synchronous *claim* was needed first.) tick() is the only place this project ever awaits anything
// (a provider's send()), and `delivery.attempts` is incremented SYNCHRONOUSLY before that await, exactly so a
// racing editPost sees attempts > 0 immediately and refuses -- no extra guard needed there. cancelChannel/
// cancelPost have no such signal (status is still "pending" throughout the send), so they use an explicit
// `dispatching` guard (mirrors messenger.ts's claimOp) and refuse with DISPATCH_IN_PROGRESS instead.
import { randomUUID } from "node:crypto";
import { systemClock, type Clock } from "./clock.js";
import { SchedulerError } from "./errors.js";
import type { FakeChannelProvider } from "./providers.js";
import type { ChannelDelivery, ProviderResult, ScheduledPost } from "./types.js";

export const MAX_CONTENT_LENGTH = 2000;
export const MAX_CLIENT_REQUEST_ID_LENGTH = 255;
export const MAX_CHANNELS_PER_POST = 20;
export const DEFAULT_MAX_ATTEMPTS = 5;
export const DEFAULT_INITIAL_BACKOFF_MS = 60_000; // 1 minute
export const DEFAULT_MAX_BACKOFF_MS = 30 * 60_000; // 30 minutes

export interface SchedulerOptions {
  providers: Record<string, FakeChannelProvider>; // channel key -> fake provider; the only valid channel keys
  clock?: Clock;
  newId?: () => string;
  maxAttempts?: number;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
}

export interface SchedulePostRequest {
  clientRequestId: string;
  content: string;
  channels: string[];
  scheduledAt: number; // epoch ms
}

export interface EditPostRequest {
  content?: string;
  scheduledAt?: number;
}

// The internal record. `deliveries` is a plain object keyed by channel (not a Map) so clones round-trip through
// structuredClone the same way as the rest of this repo's record types.
interface PostRecord extends ScheduledPost {
  fingerprint: string; // derived from content + sorted-unique channels + scheduledAt, for idempotency comparison
}

function fingerprintOf(content: string, channels: readonly string[], scheduledAt: number): string {
  return JSON.stringify({ content, channels: [...new Set(channels)].sort(), scheduledAt });
}

function backoffMs(attempt: number, initialMs: number, maxMs: number): number {
  return Math.min(maxMs, initialMs * Math.pow(2, attempt - 1));
}

export class SocialScheduler {
  private readonly providers: Record<string, FakeChannelProvider>;
  private readonly clock: Clock;
  private readonly newId: () => string;
  private readonly maxAttempts: number;
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;

  private readonly posts = new Map<string, PostRecord>();
  private readonly idempotency = new Map<string, string>(); // clientRequestId -> postId
  private readonly dispatching = new Set<string>(); // "postId:channel" currently awaiting provider.send()

  constructor(options: SchedulerOptions) {
    if (!options.providers || Object.keys(options.providers).length === 0) {
      throw new RangeError("providers must have at least one channel registered");
    }
    this.providers = options.providers;
    this.clock = options.clock ?? systemClock;
    this.newId = options.newId ?? (() => randomUUID());
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.initialBackoffMs = options.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS;
    this.maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    if (!Number.isInteger(this.maxAttempts) || this.maxAttempts < 1) throw new RangeError("maxAttempts must be an integer >= 1");
    if (!Number.isFinite(this.initialBackoffMs) || this.initialBackoffMs < 0) throw new RangeError("initialBackoffMs must be >= 0");
    if (!Number.isFinite(this.maxBackoffMs) || this.maxBackoffMs < this.initialBackoffMs) {
      throw new RangeError("maxBackoffMs must be >= initialBackoffMs");
    }
  }

  // Validates everything up front ("an error means nothing happened"): a throw here changes no state and leaves
  // the idempotency key free. The idempotency check itself runs AFTER the cheap shape checks (bad clientRequestId
  // is always a 400-style error, replay or not) but BEFORE the deeper semantic checks (unknown channel, past
  // scheduledAt) -- a replay answers from the stored result, it does not re-validate the original request.
  schedulePost(request: SchedulePostRequest): ScheduledPost {
    const clientRequestId = this.requireClientRequestId(request.clientRequestId);

    const existingId = this.idempotency.get(clientRequestId);
    if (existingId !== undefined) {
      const existing = this.posts.get(existingId)!;
      const fingerprint = fingerprintOf(this.requireContent(request.content), this.requireChannelsShape(request.channels), this.requireScheduledAtShape(request.scheduledAt));
      if (fingerprint !== existing.fingerprint) {
        throw new SchedulerError("IDEMPOTENCY_CONFLICT", `clientRequestId ${clientRequestId} was used before with different content, channels or scheduledAt`);
      }
      return this.toPublicPost(existing);
    }

    const content = this.requireContent(request.content);
    const channels = this.requireValidChannels(request.channels);
    const scheduledAt = this.requireFutureScheduledAt(request.scheduledAt);
    // Nothing above changed any state. From here on, nothing throws.
    const now = this.clock.now();
    const deliveries: Record<string, ChannelDelivery> = {};
    for (const channel of channels) {
      deliveries[channel] = {
        channel,
        status: "pending",
        attempts: 0,
        maxAttempts: this.maxAttempts,
        nextAttemptAt: scheduledAt,
      };
    }
    const record: PostRecord = {
      id: this.newId(),
      clientRequestId,
      content,
      channels,
      scheduledAt,
      createdAt: now,
      deliveries,
      fingerprint: fingerprintOf(content, channels, scheduledAt),
    };
    this.posts.set(record.id, record);
    this.idempotency.set(clientRequestId, record.id);
    return this.toPublicPost(record);
  }

  getPost(postId: string): ScheduledPost | undefined {
    const record = this.posts.get(postId);
    return record ? this.toPublicPost(record) : undefined;
  }

  list(): ScheduledPost[] {
    return [...this.posts.values()].map((r) => this.toPublicPost(r));
  }

  // Cancels ONE still-pending channel of a post. A channel that is already sent, dead-lettered or canceled is a
  // clean validation error -- nothing changes. A channel currently mid-send (tick() is awaiting its provider right
  // now) is DISPATCH_IN_PROGRESS, not silently ignored and not silently overridden: ask again once tick() settles.
  cancelChannel(postId: string, channel: string): ScheduledPost {
    const record = this.requirePostRecord(postId);
    const delivery = this.requirePostChannel(record, channel);
    this.requireNotDispatching(postId, channel);
    if (delivery.status !== "pending") {
      throw new SchedulerError("CHANNEL_NOT_PENDING", `channel ${channel} of post ${postId} is already ${delivery.status}, it cannot be canceled`);
    }
    delivery.status = "canceled";
    delivery.canceledAt = this.clock.now();
    return this.toPublicPost(record);
  }

  // Cancels every channel of the post that is still pending. If every channel has already reached a terminal
  // state (sent, dead_letter or already canceled), there is nothing left to cancel and this is a clean error
  // rather than a silent no-op that looks like it worked.
  cancelPost(postId: string): ScheduledPost {
    const record = this.requirePostRecord(postId);
    const pending = Object.values(record.deliveries).filter((d) => d.status === "pending");
    if (pending.length === 0) {
      throw new SchedulerError("NOTHING_PENDING", `post ${postId} has no pending channel left to cancel`);
    }
    for (const delivery of pending) this.requireNotDispatching(postId, delivery.channel);
    const now = this.clock.now();
    for (const delivery of pending) {
      delivery.status = "canceled";
      delivery.canceledAt = now;
    }
    return this.toPublicPost(record);
  }

  // Edits the post's content and/or scheduledAt. Allowed ONLY before the post has begun dispatching at all: every
  // channel that is not already canceled must have zero attempts. (A channel that already sent, or is mid-retry
  // after a real attempt, has a result an edit could not take back -- the content a provider already saw cannot
  // be unsent.) This is deliberately stricter than cancelChannel's plain "still pending" rule; see PLAN.md.
  editPost(postId: string, updates: EditPostRequest): ScheduledPost {
    if (updates.content === undefined && updates.scheduledAt === undefined) {
      throw new SchedulerError("INVALID_REQUEST", "editPost needs at least one of content or scheduledAt");
    }
    const record = this.requirePostRecord(postId);
    for (const delivery of Object.values(record.deliveries)) {
      if (delivery.status === "canceled") continue;
      if (delivery.attempts > 0) {
        throw new SchedulerError("POST_ALREADY_DISPATCHED", `post ${postId} has already been attempted on channel ${delivery.channel}, it can no longer be edited`);
      }
    }
    const content = updates.content === undefined ? record.content : this.requireContent(updates.content);
    const scheduledAt = updates.scheduledAt === undefined ? record.scheduledAt : this.requireFutureScheduledAt(updates.scheduledAt);
    // Nothing above changed any state. From here on, nothing throws.
    record.content = content;
    record.scheduledAt = scheduledAt;
    record.fingerprint = fingerprintOf(content, record.channels, scheduledAt);
    for (const delivery of Object.values(record.deliveries)) {
      if (delivery.status === "pending") delivery.nextAttemptAt = scheduledAt;
    }
    return this.toPublicPost(record);
  }

  // Dispatches every channel, of every post, that is still pending and due (scheduledAt/backoff <= now). Each
  // dispatch is independent: one channel's provider failing or throwing never affects another channel, of this
  // post or any other. Returns how many channel-attempts were made this call.
  async tick(): Promise<number> {
    const now = this.clock.now();
    const due: { record: PostRecord; delivery: ChannelDelivery }[] = [];
    for (const record of this.posts.values()) {
      for (const delivery of Object.values(record.deliveries)) {
        const key = `${record.id}:${delivery.channel}`;
        if (delivery.status === "pending" && delivery.nextAttemptAt <= now && !this.dispatching.has(key)) {
          due.push({ record, delivery });
        }
      }
    }
    for (const { record, delivery } of due) this.dispatching.add(`${record.id}:${delivery.channel}`);
    await Promise.all(due.map(({ record, delivery }) => this.dispatchChannel(record, delivery)));
    return due.length;
  }

  private async dispatchChannel(record: PostRecord, delivery: ChannelDelivery): Promise<void> {
    const key = `${record.id}:${delivery.channel}`;
    try {
      delivery.attempts += 1;
      const provider = this.providers[delivery.channel]!;
      let result: ProviderResult;
      try {
        result = await provider.send({ postId: record.id, channel: delivery.channel, content: record.content, attempt: delivery.attempts });
      } catch (err) {
        result = { status: "failed", reason: `provider threw: ${err instanceof Error ? err.message : String(err)}` };
      }
      const now = this.clock.now();
      if (result.status === "sent") {
        delivery.status = "sent";
        delivery.providerId = result.providerId;
        delivery.sentAt = now;
      } else {
        delivery.lastError = result.reason;
        // `attempts` was already incremented above, the same way for every failure: a permanent failure is still
        // one real attempt that genuinely happened, it just will never be followed by another one. A permanent
        // failure (retryable === false) skips the remaining backoff/retry schedule entirely and dead-letters this
        // channel right now, even on attempt 1 -- see PLAN.md Stage 2 decisions.
        const permanent = result.retryable === false;
        if (permanent || delivery.attempts >= delivery.maxAttempts) {
          delivery.status = "dead_letter";
        } else {
          delivery.nextAttemptAt = now + backoffMs(delivery.attempts, this.initialBackoffMs, this.maxBackoffMs);
        }
      }
    } finally {
      this.dispatching.delete(key);
    }
  }

  // ---- validation helpers: throw before anything is stored ----

  private requireClientRequestId(clientRequestId: unknown): string {
    if (typeof clientRequestId !== "string" || clientRequestId.trim() === "" || clientRequestId.length > MAX_CLIENT_REQUEST_ID_LENGTH) {
      throw new SchedulerError("INVALID_REQUEST", `clientRequestId must be a non-empty string of at most ${MAX_CLIENT_REQUEST_ID_LENGTH} characters`);
    }
    return clientRequestId;
  }

  private requireContent(content: unknown): string {
    if (typeof content !== "string" || content.trim() === "") {
      throw new SchedulerError("INVALID_REQUEST", "content must be a non-empty string");
    }
    if (content.length > MAX_CONTENT_LENGTH) {
      throw new SchedulerError("INVALID_REQUEST", `content must be at most ${MAX_CONTENT_LENGTH} characters`);
    }
    return content;
  }

  // Shape-only check (used to compute a replay's fingerprint before we know whether it IS a replay): array of
  // non-empty strings, no duplicates, within the count bound. Whether the keys are known channels is NOT checked
  // here -- a replay of a request that was valid when it was first accepted must not re-run that check.
  private requireChannelsShape(channels: unknown): string[] {
    if (!Array.isArray(channels) || channels.length === 0) {
      throw new SchedulerError("INVALID_REQUEST", "channels must be a non-empty array");
    }
    if (channels.length > MAX_CHANNELS_PER_POST) {
      throw new SchedulerError("INVALID_REQUEST", `channels must have at most ${MAX_CHANNELS_PER_POST} entries`);
    }
    if (!channels.every((c): c is string => typeof c === "string" && c.trim() !== "")) {
      throw new SchedulerError("INVALID_REQUEST", "every channel must be a non-empty string");
    }
    if (new Set(channels).size !== channels.length) {
      throw new SchedulerError("INVALID_REQUEST", "channels has a duplicate entry");
    }
    return channels;
  }

  private requireValidChannels(channels: unknown): string[] {
    const shaped = this.requireChannelsShape(channels);
    for (const channel of shaped) {
      if (!this.providers[channel]) throw new SchedulerError("UNKNOWN_CHANNEL", `no provider registered for channel "${channel}"`);
    }
    return shaped;
  }

  private requireScheduledAtShape(scheduledAt: unknown): number {
    if (typeof scheduledAt !== "number" || !Number.isInteger(scheduledAt) || !Number.isFinite(scheduledAt)) {
      throw new SchedulerError("INVALID_REQUEST", "scheduledAt must be an integer epoch-ms timestamp");
    }
    return scheduledAt;
  }

  private requireFutureScheduledAt(scheduledAt: unknown): number {
    const shaped = this.requireScheduledAtShape(scheduledAt);
    if (shaped < this.clock.now()) throw new SchedulerError("SCHEDULED_AT_IN_PAST", "scheduledAt must not be in the past");
    return shaped;
  }

  private requirePostRecord(postId: string): PostRecord {
    const record = this.posts.get(postId);
    if (!record) throw new SchedulerError("UNKNOWN_POST", `no post ${String(postId)}`);
    return record;
  }

  private requirePostChannel(record: PostRecord, channel: string): ChannelDelivery {
    const delivery = record.deliveries[channel];
    if (!delivery) throw new SchedulerError("UNKNOWN_POST_CHANNEL", `post ${record.id} was never scheduled on channel ${String(channel)}`);
    return delivery;
  }

  private requireNotDispatching(postId: string, channel: string): void {
    if (this.dispatching.has(`${postId}:${channel}`)) {
      throw new SchedulerError("DISPATCH_IN_PROGRESS", `channel ${channel} of post ${postId} is being dispatched right now, try again`);
    }
  }

  private toPublicPost(record: PostRecord): ScheduledPost {
    const { fingerprint, ...rest } = record;
    void fingerprint;
    return structuredClone(rest);
  }
}
