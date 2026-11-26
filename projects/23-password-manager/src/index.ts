export { ManualClock, systemClock, type Clock } from "./clock.js";
export { PasswordManagerError, type PasswordManagerErrorCode } from "./errors.js";
export { decrypt, deriveKey, encrypt, newSalt, KEY_LENGTH, SALT_LENGTH, type EncryptedBlob } from "./crypto.js";
export { InMemoryVaultStore, type PersistedEntry, type PersistedVault, type VaultStore } from "./store.js";
export { withTimeout } from "./timeout.js";
export {
  DEFAULT_GENERATED_LENGTH,
  MAX_GENERATED_LENGTH,
  MIN_GENERATED_LENGTH,
  generatePassword,
  type GeneratePasswordOptions,
} from "./generator.js";
export {
  DEFAULT_COMMIT_TIMEOUT_MS,
  LOCKOUT_MS,
  MAX_FAILED_ATTEMPTS,
  MAX_MASTER_PASSWORD_LENGTH,
  MAX_NOTES_LENGTH,
  MAX_OWNER_ID_LENGTH,
  MAX_PASSWORD_LENGTH,
  MAX_TITLE_LENGTH,
  MAX_USERNAME_LENGTH,
  MIN_MASTER_PASSWORD_LENGTH,
  PasswordManager,
  type PasswordManagerOptions,
} from "./manager.js";
export * from "./types.js";
