import "server-only";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

// AES-256-GCM for the per-user Anthropic API key. The key never leaves the
// server: it is encrypted with ASSISTANT_KEY_SECRET before hitting Postgres
// and decrypted only inside the assistant route handler.

function secretKey(): Buffer {
  const secret = process.env.ASSISTANT_KEY_SECRET;
  if (!secret) throw new Error("ASSISTANT_KEY_SECRET is not configured");
  return createHash("sha256").update(secret).digest();
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", secretKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString("base64")}.${tag.toString("base64")}.${encrypted.toString("base64")}`;
}

// Sniff for the encrypted-at-rest format. No real upstream secret collides
// with the prefix: GitHub PATs are ghp_/github_pat_, Google tokens ya29./1//.
export function isEncryptedSecret(value: string): boolean {
  return value.startsWith("v1.");
}

// Read a stored secret that may predate encryption-at-rest: encrypted values
// decrypt, legacy plaintext passes through, and an encrypted value that fails
// to decrypt (e.g. a rotated ASSISTANT_KEY_SECRET) yields null so the caller
// treats the credential as absent rather than sending garbage upstream.
export function revealSecret(stored: string): string | null {
  if (!isEncryptedSecret(stored)) return stored;
  try {
    return decryptSecret(stored);
  } catch {
    return null;
  }
}

// Encrypt for storage without letting a missing ASSISTANT_KEY_SECRET take down
// the write path that carries it (the login callback, the vault connect form).
// Falling back to plaintext is the pre-encryption status quo; breaking sign-in
// is worse. The failure is loud in the server log either way.
export function sealSecret(plaintext: string): string {
  try {
    return encryptSecret(plaintext);
  } catch (error) {
    console.warn("secret encryption unavailable — storing unencrypted", error);
    return plaintext;
  }
}

export function decryptSecret(stored: string): string {
  const [version, ivB64, tagB64, dataB64] = stored.split(".");
  if (version !== "v1" || !ivB64 || !tagB64 || !dataB64) {
    throw new Error("unrecognized secret format");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    secretKey(),
    Buffer.from(ivB64, "base64"),
  );
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}
