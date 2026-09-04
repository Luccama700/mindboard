import { describe, expect, test } from "vitest";

import {
  captureTitleFromText,
  idempotentProposalId,
  parseWatchTokenMap,
  readIdempotencyKey,
  resolveWatchUserId,
  validateComplete,
  validateSpend,
} from "@/app/lib/watch/protocol";
import { CAPTURE_TITLE_MAX } from "@/app/lib/mcp/capture";

const OWNER = "8fd62772-a371-4d26-8a93-678b88c2b879";

describe("watch bearer tokens", () => {
  test("a plain WATCH_TOKEN maps to the deployment owner", () => {
    const tokens = parseWatchTokenMap("  secret-one  ", OWNER);
    expect(resolveWatchUserId("Bearer secret-one", tokens)).toBe(OWNER);
    expect(resolveWatchUserId("Bearer secret-two", tokens)).toBeNull();
  });

  test("a JSON map carries one token per tenant", () => {
    const tokens = parseWatchTokenMap(
      JSON.stringify({ "tok-a": OWNER, "tok-b": " friend-uuid " }),
      OWNER,
    );
    expect(resolveWatchUserId("Bearer tok-a", tokens)).toBe(OWNER);
    expect(resolveWatchUserId("Bearer tok-b", tokens)).toBe("friend-uuid");
    expect(resolveWatchUserId("Bearer tok-c", tokens)).toBeNull();
  });

  test("malformed or missing config authorizes nobody", () => {
    expect(resolveWatchUserId("Bearer x", parseWatchTokenMap("{not json", OWNER))).toBeNull();
    expect(resolveWatchUserId("Bearer x", parseWatchTokenMap(undefined, OWNER))).toBeNull();
    expect(resolveWatchUserId("Bearer x", parseWatchTokenMap('{"x": 5}', OWNER))).toBeNull();
    // No owner configured: a plain token has nobody to map to.
    expect(resolveWatchUserId("Bearer x", parseWatchTokenMap("x", undefined))).toBeNull();
  });

  test("non-bearer and empty authorization headers are rejected", () => {
    const tokens = parseWatchTokenMap("secret", OWNER);
    expect(resolveWatchUserId(null, tokens)).toBeNull();
    expect(resolveWatchUserId("Basic secret", tokens)).toBeNull();
    expect(resolveWatchUserId("Bearer ", tokens)).toBeNull();
  });
});

describe("idempotency", () => {
  test("keys are trimmed; blank or over-long keys count as absent", () => {
    expect(readIdempotencyKey(" abc ")).toBe("abc");
    expect(readIdempotencyKey(null)).toBeNull();
    expect(readIdempotencyKey("   ")).toBeNull();
    expect(readIdempotencyKey("k".repeat(201))).toBeNull();
  });

  test("proposal id is a stable uuid per (user, tool, key)", () => {
    const id = idempotentProposalId(OWNER, "log_spend", "key-1");
    expect(id).toBe(idempotentProposalId(OWNER, "log_spend", "key-1"));
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(id).not.toBe(idempotentProposalId(OWNER, "create_task", "key-1"));
    expect(id).not.toBe(idempotentProposalId("other-user", "log_spend", "key-1"));
    expect(id).not.toBe(idempotentProposalId(OWNER, "log_spend", "key-2"));
  });
});

describe("watch bodies", () => {
  test("complete needs a known type and an id", () => {
    expect(validateComplete({ type: "task", id: " t1 " })).toEqual({
      ok: true,
      value: { type: "task", id: "t1" },
    });
    expect(validateComplete({ type: "habit", id: "t1" }).ok).toBe(false);
    expect(validateComplete({ type: "recurring" }).ok).toBe(false);
  });

  test("spend rounds to cents and drops a blank note", () => {
    expect(validateSpend({ amount: "6.505", note: "  " })).toEqual({
      ok: true,
      value: { amount: 6.51, note: null },
    });
    expect(validateSpend({ amount: 0 }).ok).toBe(false);
    expect(validateSpend({ amount: "coffee" }).ok).toBe(false);
    expect(validateSpend({ amount: 3, note: 4 }).ok).toBe(false);
  });

  test("capture title is the first non-empty line, cut at a word boundary", () => {
    expect(captureTitleFromText("\n\n  idea: watch app  \nmore")).toBe("idea: watch app");
    const long = `${"word ".repeat(30)}tail`;
    const title = captureTitleFromText(long);
    expect(title.length).toBeLessThanOrEqual(CAPTURE_TITLE_MAX);
    expect(title.endsWith("…")).toBe(true);
    expect(title).not.toMatch(/ …$/);
  });
});
