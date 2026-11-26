// One error class with a machine-readable code, so callers switch on `code` instead of parsing messages. Every
// error thrown by PasswordManager means "nothing happened": no vault or entry changed, except the one documented
// exception -- a failed unlock attempt is recorded on purpose, since that count is the whole point of lockout.

export type PasswordManagerErrorCode =
  | "INVALID_REQUEST" // bad shape: empty title, password too long, master password too short, etc.
  | "UNKNOWN_OWNER" // no vault exists for this ownerId
  | "VAULT_ALREADY_EXISTS"
  | "INVALID_MASTER_PASSWORD"
  | "LOCKED_OUT" // too many wrong attempts; cooldown has not elapsed yet
  | "VAULT_LOCKED" // the vault exists and the password was never wrong, but it is not unlocked right now
  | "UNKNOWN_ENTRY"
  | "DECRYPTION_FAILED"; // ciphertext failed AEAD authentication: wrong key or tampered data

export class PasswordManagerError extends Error {
  constructor(
    readonly code: PasswordManagerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PasswordManagerError";
  }
}
