import { afterEach, describe, expect, test } from "vitest";

import {
  PAT_PREFIX,
  generatePatToken,
  hashPatToken,
  looksLikePat,
} from "@/app/lib/mcp/pat";
import { workerAllowedUserIds } from "@/app/lib/mcp/config";

describe("mcp personal access tokens", () => {
  test("generated tokens carry the prefix and enough entropy", () => {
    const token = generatePatToken();
    expect(token.startsWith(PAT_PREFIX)).toBe(true);
    // 32 random bytes base64url ≈ 43 chars after the prefix.
    expect(token.length).toBeGreaterThanOrEqual(PAT_PREFIX.length + 43);
  });

  test("two generated tokens never collide", () => {
    expect(generatePatToken()).not.toBe(generatePatToken());
  });

  test("hash is deterministic sha-256 hex", () => {
    const token = generatePatToken();
    const hash = hashPatToken(token);
    expect(hash).toBe(hashPatToken(token));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashPatToken(generatePatToken())).not.toBe(hash);
  });

  test("looksLikePat separates PATs from other bearer shapes", () => {
    expect(looksLikePat(generatePatToken())).toBe(true);
    expect(looksLikePat("eyJhbGciOi.signature")).toBe(false);
    expect(looksLikePat("some-static-secret")).toBe(false);
    expect(looksLikePat("")).toBe(false);
  });
});

describe("worker allowlist", () => {
  const OWNER = "8fd62772-a371-4d26-8a93-678b88c2b879";
  const originalOwner = process.env.MINDBOARD_OWNER_USER_ID;
  const originalAllowed = process.env.WORKER_ALLOWED_USER_IDS;

  afterEach(() => {
    if (originalOwner === undefined) delete process.env.MINDBOARD_OWNER_USER_ID;
    else process.env.MINDBOARD_OWNER_USER_ID = originalOwner;
    if (originalAllowed === undefined) delete process.env.WORKER_ALLOWED_USER_IDS;
    else process.env.WORKER_ALLOWED_USER_IDS = originalAllowed;
  });

  test("owner is always allowed, even with no allowlist env", () => {
    process.env.MINDBOARD_OWNER_USER_ID = OWNER;
    delete process.env.WORKER_ALLOWED_USER_IDS;
    expect(workerAllowedUserIds()).toEqual([OWNER]);
  });

  test("comma-separated ids are trimmed, deduped, and appended to the owner", () => {
    process.env.MINDBOARD_OWNER_USER_ID = OWNER;
    process.env.WORKER_ALLOWED_USER_IDS = ` friend-1 , friend-2 ,, ${OWNER} `;
    expect(workerAllowedUserIds()).toEqual([OWNER, "friend-1", "friend-2"]);
  });

  test("throws when the owner env is missing", () => {
    delete process.env.MINDBOARD_OWNER_USER_ID;
    expect(() => workerAllowedUserIds()).toThrow();
  });
});
