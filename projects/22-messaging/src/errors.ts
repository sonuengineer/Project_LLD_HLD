// One error class with a machine-readable code, so callers switch on `code` instead of parsing messages. Every
// error thrown by the Messenger means "nothing happened": no conversation, member or message changed.

export type MessagingErrorCode =
  | "INVALID_REQUEST" // bad shape: empty body, empty id, duplicate member list, etc.
  | "UNKNOWN_USER"
  | "UNKNOWN_CONVERSATION"
  | "UNKNOWN_MESSAGE"
  | "NOT_A_MEMBER" // the caller is not (or no longer) a member of the conversation
  | "ALREADY_MEMBER"
  | "OWNER_REQUIRED" // only the owner may do this (add/remove members)
  | "CANNOT_REMOVE_OWNER"
  | "IDEMPOTENCY_CONFLICT" // the same clientMessageId was used before with a different body
  | "INVALID_CURSOR"; // getMessages: a cursor this API did not return

export class MessagingError extends Error {
  constructor(
    readonly code: MessagingErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "MessagingError";
  }
}
