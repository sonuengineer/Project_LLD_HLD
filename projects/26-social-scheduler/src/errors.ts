// One error class with a machine-readable code, so callers switch on `code` instead of parsing messages. Every
// error thrown by the scheduler means "nothing happened": no post, delivery or status changed.

export type SchedulerErrorCode =
  | "INVALID_REQUEST" // bad shape: empty content, content over the limit, empty/duplicate channel list, bad ids
  | "UNKNOWN_CHANNEL" // a channel key with no registered provider
  | "SCHEDULED_AT_IN_PAST" // scheduledAt is before the clock's current time
  | "IDEMPOTENCY_CONFLICT" // the same clientRequestId was used before with different content/channels/time
  | "UNKNOWN_POST" // no post with this id
  | "UNKNOWN_POST_CHANNEL" // the post exists but was never scheduled on this channel
  | "CHANNEL_NOT_PENDING" // cancel/edit asked for a channel that is already sent, dead-lettered or canceled
  | "NOTHING_PENDING" // cancelPost: every channel is already terminal, there is nothing left to cancel
  | "POST_ALREADY_DISPATCHED" // editPost: at least one channel has already been attempted (or is terminal)
  | "DISPATCH_IN_PROGRESS"; // cancel/edit raced a tick() that is mid-send for this exact channel; retry

export class SchedulerError extends Error {
  constructor(
    readonly code: SchedulerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SchedulerError";
  }
}
