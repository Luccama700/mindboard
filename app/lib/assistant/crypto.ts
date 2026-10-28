import "server-only";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

// AES-256-GCM for every secret Mindboard holds on a user's behalf: provider
// API keys, the Google OAuth tokens, the vault GitHub PAT. The key never
// leaves the server — values are encrypted with ASSISTANT_KEY_SECRET before
// they reach Postgres and decrypted only inside server code.
//
// Two formats exist on disk. `v2.` binds the ciphertext to its owner and
// column through AES-GCM's additional-authenticated-data field, so anyone who
// can WRITE the database still cannot move one user's ciphertext onto another
// user's row, or a low-value column's onto a high-value one: the auth tag stops
// verifying (audit 2026-10-26, L8). `v1.` predates the AAD and carries no such
// binding; it still decrypts so existing rows keep working, and is upgraded the
// next time the value is written. Every new encryption is `v2.`.

// Which row and column a ciphertext belongs to. Required on both functions, and
// deliberately not defaulted: an optional scope would silently re-open the
// swap the AAD exists to close.
export type SecretScope = {
  userId: string;
  table: string;
  column: string;
};

function secretKey(): Buffer {
  const secret = process.env.ASSISTANT_KEY_SECRET;
  if (!secret) throw new Error("ASSISTANT_KEY_SECRET is not configured");
  return createHash("sha256").update(secret).digest();
}

function additionalData(scope: SecretScope): Buffer {
  return Buffer.from(`${scope.userId}|${scope.table}.${scope.column}`, "utf8");
}

// Tells a value this module wrote apart from a legacy plaintext secret left in
// the column by an older release. Safe as a sniff because no secret stored here
// begins with "v1."/"v2." — Google tokens start `ya29.`/`1//`, GitHub PATs
// `github_pat_`/`ghp_`, provider keys `sk-`/`AIza`.
export function isEncryptedSecret(stored: string): boolean {
  return stored.startsWith("v1.") || stored.startsWith("v2.");
}

export function encryptSecret(plaintext: string, scope: SecretScope): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", secretKey(), iv);
  cipher.setAAD(additionalData(scope));
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return `v2.${iv.toString("base64")}.${tag.toString("base64")}.${encrypted.toString("base64")}`;
}

export function decryptSecret(stored: string, scope: SecretScope): string {
  const [version, ivB64, tagB64, dataB64] = stored.split(".");
  if ((version !== "v1" && version !== "v2") || !ivB64 || !tagB64 || !dataB64) {
    throw new Error("unrecognized secret format");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    secretKey(),
    Buffer.from(ivB64, "base64"),
  );
  if (version === "v2") decipher.setAAD(additionalData(scope));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}
