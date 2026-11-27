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
  | "INVALID_CURSOR" // getMessages: a cursor this API did not return
  | "CONVERSATION_BUSY" // a membership change and a message op (or two membership changes) collided; retry
  | "SEND_IN_FLIGHT" // a send with this exact clientMessageId is already being committed; retry once it settles
  | "SENDER_REQUIRED" // only the original sender may edit or delete this message
  | "MESSAGE_DELETED" // the message was deleted and cannot be edited
  | "UNKNOWN_DEVICE"; // disconnectDevice: that device is not connected for that user

export class MessagingError extends Error {
  constructor(
    readonly code: MessagingErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "MessagingError";
  }
}
