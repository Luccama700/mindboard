import "server-only";
import {
  decryptSecret,
  encryptSecret,
  isEncryptedSecret,
  type SecretScope,
} from "@/app/lib/assistant/crypto";

// google_tokens.access_token / refresh_token at rest (audit 2026-10-26, H4).
// Both were plaintext: a database export, a SQL-log leak or a stolen session
// handed over lasting Google Calendar read/write for every account.
//
// The two columns get DISTINCT scopes on purpose. The refresh token is the
// durable credential and the access token expires in an hour, so binding each
// to its own column means a database writer cannot promote one into the other.

export const GOOGLE_TOKENS_TABLE = "google_tokens";

export type GoogleTokenColumn = "access_token" | "refresh_token";

function scope(userId: string, column: GoogleTokenColumn): SecretScope {
  return { userId, table: GOOGLE_TOKENS_TABLE, column };
}

export function encryptGoogleToken(
  userId: string,
  column: GoogleTokenColumn,
  value: string,
): string {
  return encryptSecret(value, scope(userId, column));
}

// A stored value is either ciphertext this app wrote or a plaintext token from
// before the column was encrypted; `legacy` says which, so the caller can
// schedule the re-write. A value that CARRIES the version prefix but will not
// decrypt (a rotated ASSISTANT_KEY_SECRET, a tampered row) throws — it is a
// broken connection, never something to hand to Google as a bearer token.
export function readGoogleToken(
  userId: string,
  column: GoogleTokenColumn,
  stored: string,
): { value: string; legacy: boolean } {
  if (!isEncryptedSecret(stored)) return { value: stored, legacy: true };
  return { value: decryptSecret(stored, scope(userId, column)), legacy: false };
}
