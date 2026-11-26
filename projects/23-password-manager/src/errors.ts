// One error class with a machine-readable code, so callers switch on `code` instead of parsing messages. Every
// error thrown by PasswordManager means "nothing happened": no vault or entry changed, except the one documented
// exception -- a failed unlock attempt is recorded on purpose, since that count is the whole point of lockout.

export type PasswordManagerErrorCode =
  | "INVALID_REQUEST" // bad shape: empty title, password too long, master password too short, etc.
  | "UNKNOWN_OWNER" // no vault exists for this ownerId
  | "VAULT_ALREADY_EXISTS"
  | "INVALID_MASTER_PASSWORD"
  | "LOCKED_OUT" // too many wrong attempts; cooldown has not elapsed yet
  | "UNKNOWN_ENTRY"
  | "DECRYPTION_FAILED" // ciphertext failed AEAD authentication: wrong key or tampered data
  | "UNKNOWN_SESSION" // this sessionId was never issued, or was lock()ed
  | "SESSION_INVALIDATED" // the master password changed since this session unlocked; unlock again
  | "VAULT_BUSY" // an entry operation and a master-password rotation are claiming the same vault right now
  | "ENTRY_CONFLICT" // another operation changed this entry first; this one's work was discarded
  | "STORE_TIMEOUT"; // the vault store did not respond in time

export class PasswordManagerError extends Error {
  constructor(
    readonly code: PasswordManagerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PasswordManagerError";
  }
}
