// @vitest-environment node
import { beforeAll, describe, expect, test } from "vitest";

// crypto.ts reads ASSISTANT_KEY_SECRET lazily (per call), so setting it before
// the calls — not before the import — is sufficient.
import {
  encryptSecret,
  decryptSecret,
  isEncryptedSecret,
  revealSecret,
  sealSecret,
} from "@/app/lib/assistant/crypto";

describe("secret encryption round-trips", () => {
  beforeAll(() => {
    process.env.ASSISTANT_KEY_SECRET = "test-secret-for-vitest";
  });

  test("encrypt → decrypt round-trips", () => {
    const stored = encryptSecret("ghp_example_token_1234");
    expect(stored.startsWith("v1.")).toBe(true);
    expect(decryptSecret(stored)).toBe("ghp_example_token_1234");
  });

  test("isEncryptedSecret sniffs the v1. format and nothing else", () => {
    expect(isEncryptedSecret(encryptSecret("x"))).toBe(true);
    // Real upstream secret shapes never collide with the prefix.
    expect(isEncryptedSecret("ghp_abc123")).toBe(false);
    expect(isEncryptedSecret("github_pat_abc")).toBe(false);
    expect(isEncryptedSecret("ya29.a0AfH6")).toBe(false);
    expect(isEncryptedSecret("1//0gExampleRefresh")).toBe(false);
  });

  test("revealSecret decrypts sealed values and passes legacy plaintext through", () => {
    expect(revealSecret(sealSecret("ya29.access"))).toBe("ya29.access");
    expect(revealSecret("ghp_legacy_plaintext")).toBe("ghp_legacy_plaintext");
  });

  test("revealSecret yields null for an undecryptable v1. value, never garbage", () => {
    expect(revealSecret("v1.not.real.payload")).toBeNull();
    const sealed = sealSecret("secret-under-old-key");
    process.env.ASSISTANT_KEY_SECRET = "a-rotated-secret";
    expect(revealSecret(sealed)).toBeNull();
    process.env.ASSISTANT_KEY_SECRET = "test-secret-for-vitest";
  });

  test("sealSecret falls back to plaintext when no key is configured (login must not break)", () => {
    const saved = process.env.ASSISTANT_KEY_SECRET;
    delete process.env.ASSISTANT_KEY_SECRET;
    expect(sealSecret("ya29.token")).toBe("ya29.token");
    process.env.ASSISTANT_KEY_SECRET = saved;
  });

  test("double-sealing cannot happen through the reveal-then-seal flow", () => {
    const once = sealSecret("1//refresh-token");
    const revealed = revealSecret(once);
    expect(revealed).toBe("1//refresh-token");
    // Sealing the *revealed* value (the only flow the write paths use) is
    // stable — decrypting once always yields the original.
    expect(revealSecret(sealSecret(revealed as string))).toBe("1//refresh-token");
  });
});
