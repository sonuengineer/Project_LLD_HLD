// One error class with a machine-readable code, so callers (an HTTP layer in stage 3) switch on `code` instead of
// parsing messages. Every error thrown by notify() means "nothing happened": no record, no send, key still free.

export type NotificationErrorCode =
  | "INVALID_TYPE" // catalog: bad id, category, mode, empty / duplicate / unknown channel, missing template
  | "DUPLICATE_TYPE" // catalog: a type with this id is already registered
  | "UNKNOWN_TYPE" // notify: no type with this id
  | "UNKNOWN_USER" // notify: the user directory has no such user
  | "INVALID_REQUEST" // notify: empty idempotency key, data not a plain object
  | "INVALID_PREFERENCES" // preferences: bad quiet hours or offset, unknown channel or category
  | "TEMPLATE_VARIABLE_MISSING" // a {{placeholder}} has no value in the request data
  | "NO_SENDER" // a channel the request would use has no sender configured
  | "IDEMPOTENCY_CONFLICT"; // the key was used before with a different request

export class NotificationError extends Error {
  constructor(
    readonly code: NotificationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "NotificationError";
  }
}
