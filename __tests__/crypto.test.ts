import { describe, expect, it } from "vitest";
import { createCipheriv, createHash, randomBytes } from "node:crypto";

// secretKey() reads this at call time, so setting it before the import is not
// required — but it must exist before the first encrypt/decrypt.
process.env.ASSISTANT_KEY_SECRET = "test-assistant-key-secret-32-bytes!!";

import {
  decryptSecret,
  encryptSecret,
  isEncryptedSecret,
  type SecretScope,
} from "@/app/lib/assistant/crypto";

const SCOPE: SecretScope = {
  userId: "11111111-1111-4111-8111-111111111111",
  table: "user_settings",
  column: "anthropic_api_key",
};

// The pre-L8 format, rebuilt here rather than kept as a legacy exported
// encryptor: nothing in the app may write v1 again, but rows on disk are v1.
function legacyV1(plaintext: string): string {
  const key = createHash("sha256")
    .update(process.env.ASSISTANT_KEY_SECRET as string)
    .digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  return [
    "v1",
    iv.toString("base64"),
    cipher.getAuthTag().toString("base64"),
    encrypted.toString("base64"),
  ].join(".");
}

describe("encryptSecret / decryptSecret", () => {
  it("round-trips a value under its own scope", () => {
    const stored = encryptSecret("sk-ant-secret-value", SCOPE);
    expect(stored.startsWith("v2.")).toBe(true);
    expect(stored).not.toContain("sk-ant-secret-value");
    expect(decryptSecret(stored, SCOPE)).toBe("sk-ant-secret-value");
  });

  it("produces a different ciphertext every time (random iv)", () => {
    const a = encryptSecret("same", SCOPE);
    const b = encryptSecret("same", SCOPE);
    expect(a).not.toBe(b);
    expect(decryptSecret(a, SCOPE)).toBe(decryptSecret(b, SCOPE));
  });

  it("refuses a ciphertext moved to another user's row", () => {
    const stored = encryptSecret("sk-ant-secret-value", SCOPE);
    expect(() =>
      decryptSecret(stored, {
        ...SCOPE,
        userId: "22222222-2222-4222-8222-222222222222",
      }),
    ).toThrow();
  });

  it("refuses a ciphertext moved to another column", () => {
    const stored = encryptSecret("sk-ant-secret-value", SCOPE);
    expect(() =>
      decryptSecret(stored, { ...SCOPE, column: "openai_api_key" }),
    ).toThrow();
    expect(() =>
      decryptSecret(stored, { ...SCOPE, table: "vault_settings" }),
    ).toThrow();
  });

  it("still decrypts legacy v1 values, which carry no scope binding", () => {
    const stored = legacyV1("sk-ant-legacy-value");
    expect(decryptSecret(stored, SCOPE)).toBe("sk-ant-legacy-value");
    // v1 has no AAD, so any scope opens it — that is precisely the hole v2
    // closes, and why nothing writes v1 any more.
    expect(decryptSecret(stored, { ...SCOPE, column: "openai_api_key" })).toBe(
      "sk-ant-legacy-value",
    );
  });

  it("rejects unknown formats and tampered ciphertext", () => {
    expect(() => decryptSecret("v3.a.b.c", SCOPE)).toThrow();
    expect(() => decryptSecret("not-encrypted-at-all", SCOPE)).toThrow();
    expect(() => decryptSecret("v2.only.three", SCOPE)).toThrow();
    const stored = encryptSecret("sk-ant-secret-value", SCOPE);
    const parts = stored.split(".");
    parts[3] = Buffer.from("tampered").toString("base64");
    expect(() => decryptSecret(parts.join("."), SCOPE)).toThrow();
  });
});

describe("isEncryptedSecret", () => {
  it("recognises both stored formats", () => {
    expect(isEncryptedSecret(encryptSecret("x", SCOPE))).toBe(true);
    expect(isEncryptedSecret(legacyV1("x"))).toBe(true);
  });

  it("treats real plaintext secrets as legacy", () => {
    for (const plaintext of [
      "ya29.a0AfH6SMB-google-access-token",
      "1//04refresh-token",
      "github_pat_11ABCDEFG",
      "ghp_classictoken",
      "sk-ant-api03-key",
      "",
    ]) {
      expect(isEncryptedSecret(plaintext)).toBe(false);
    }
  });
});
