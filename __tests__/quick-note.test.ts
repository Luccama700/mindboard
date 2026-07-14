import { describe, expect, test } from "vitest";
import type { VaultWriteCredentials } from "@/app/lib/mcp/capture";
import {
  DEFAULT_QUICK_NOTE_SOURCE,
  QUICK_NOTE_SOURCE_MAX,
  QUICK_NOTE_TEXT_MAX,
  bearerAuthorized,
  buildQuickNoteDocument,
  createQuickNote,
  createRateLimiter,
  quickNotePath,
  validateQuickNote,
} from "@/app/lib/mcp/quick-note";
import type { CaptureStamp } from "@/app/lib/mcp/capture";

const CREDENTIALS: VaultWriteCredentials = {
  repo: "lucca/vault",
  branch: "main",
  token: "ghp_test",
};

// 2026-07-07T02:30Z is 2026-07-06 19:30 in Vancouver (PDT, UTC-7).
const PDT_NOW = new Date("2026-07-07T02:30:00Z");

function jsonResponse(status: number): Response {
  return new Response(JSON.stringify({}), { status });
}

type RecordedCall = { url: string; init: RequestInit };

function fakeFetch(statuses: number[]): {
  calls: RecordedCall[];
  fetchImpl: typeof fetch;
} {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (url: URL | RequestInfo, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const status = statuses[Math.min(calls.length - 1, statuses.length - 1)];
    return jsonResponse(status);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe("bearerAuthorized", () => {
  test("accepts the exact secret", () => {
    expect(bearerAuthorized("Bearer s3cret", "s3cret")).toBe(true);
  });

  test.each([
    ["Bearer wrong!", "wrong token"],
    ["Bearer s3cret-longer", "wrong length"],
    ["s3cret", "missing Bearer prefix"],
    ["bearer s3cret", "lowercase prefix"],
    [null, "missing header"],
    ["Bearer ", "empty token"],
  ])("rejects %j (%s)", (header) => {
    expect(bearerAuthorized(header, "s3cret")).toBe(false);
  });

  test("rejects everything when the secret is not configured", () => {
    expect(bearerAuthorized("Bearer ", undefined)).toBe(false);
    expect(bearerAuthorized("Bearer ", "")).toBe(false);
    expect(bearerAuthorized(null, undefined)).toBe(false);
  });
});

describe("createRateLimiter", () => {
  test("allows up to max within a window, then blocks", () => {
    const allow = createRateLimiter(2, 60_000);
    expect(allow(1_000)).toBe(true);
    expect(allow(2_000)).toBe(true);
    expect(allow(3_000)).toBe(false);
  });

  test("resets after the window elapses", () => {
    const allow = createRateLimiter(1, 60_000);
    expect(allow(1_000)).toBe(true);
    expect(allow(2_000)).toBe(false);
    expect(allow(61_000)).toBe(true);
  });
});

describe("validateQuickNote", () => {
  test("accepts text, trims it, and defaults the source", () => {
    expect(validateQuickNote({ text: "  pick up the parcel  " })).toEqual({
      ok: true,
      value: { text: "pick up the parcel", source: DEFAULT_QUICK_NOTE_SOURCE },
    });
  });

  test("uses a provided source, trimmed", () => {
    expect(
      validateQuickNote({ text: "note", source: " Drafts app " }),
    ).toEqual({
      ok: true,
      value: { text: "note", source: "Drafts app" },
    });
  });

  test("an empty source falls back to the default", () => {
    const result = validateQuickNote({ text: "note", source: "   " });
    expect(result.ok && result.value.source).toBe(DEFAULT_QUICK_NOTE_SOURCE);
  });

  test.each([
    [null, "body must be a JSON object"],
    ["note", "body must be a JSON object"],
    [["note"], "body must be a JSON object"],
    [{}, "text is required"],
    [{ text: "   " }, "text is required"],
    [{ text: 42 }, "text must be a string"],
    [{ text: "note", source: 42 }, "source must be a string"],
  ])("rejects %j", (raw, error) => {
    expect(validateQuickNote(raw)).toEqual({ ok: false, error });
  });

  test("rejects over-limit text with a clear error", () => {
    const result = validateQuickNote({
      text: "x".repeat(QUICK_NOTE_TEXT_MAX + 1),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("at most 20000 characters");
  });

  test("rejects an over-limit source", () => {
    const result = validateQuickNote({
      text: "note",
      source: "x".repeat(QUICK_NOTE_SOURCE_MAX + 1),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("source must be at most");
  });
});

describe("quickNotePath", () => {
  const stamp: CaptureStamp = {
    dateKey: "2026-07-06",
    timeKey: "1930",
    created: "2026-07-06 19:30",
  };

  test("first attempt is Inbox/YYYY-MM-DD HHMM Quick note.md", () => {
    expect(quickNotePath(stamp, 1)).toBe(
      "Inbox/2026-07-06 1930 Quick note.md",
    );
  });

  test("collisions append -2, -3", () => {
    expect(quickNotePath(stamp, 2)).toBe(
      "Inbox/2026-07-06 1930 Quick note -2.md",
    );
    expect(quickNotePath(stamp, 3)).toBe(
      "Inbox/2026-07-06 1930 Quick note -3.md",
    );
  });
});

describe("buildQuickNoteDocument", () => {
  test("frontmatter shape with an explicit empty topics list", () => {
    const doc = buildQuickNoteDocument(
      { text: "remember to email \"Sam\"", source: DEFAULT_QUICK_NOTE_SOURCE },
      "2026-07-06 19:30",
    );
    expect(doc).toBe(
      [
        "---",
        "type: capture",
        "created: 2026-07-06 19:30",
        'source: "Siri quick note"',
        "topics: []",
        "---",
        "",
        'remember to email "Sam"',
        "",
      ].join("\n"),
    );
  });
});

describe("createQuickNote", () => {
  test("creates the file under Inbox/ with a create-only PUT", async () => {
    const { calls, fetchImpl } = fakeFetch([201]);
    const result = await createQuickNote(
      CREDENTIALS,
      { text: "buy new headphones", source: DEFAULT_QUICK_NOTE_SOURCE },
      PDT_NOW,
      fetchImpl,
    );

    expect(result).toEqual({
      ok: true,
      value: { path: "Inbox/2026-07-06 1930 Quick note.md" },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].init.method).toBe("PUT");
    expect(calls[0].url).toBe(
      "https://api.github.com/repos/lucca/vault/contents/Inbox/" +
        encodeURIComponent("2026-07-06 1930 Quick note.md"),
    );

    const body = JSON.parse(String(calls[0].init.body));
    // Create-only invariant: a sha-less PUT can only ever create the path.
    expect(body.sha).toBeUndefined();
    expect(body.committer).toBeUndefined();
    expect(body.branch).toBe("main");
    expect(body.message).toBe("Capture: Quick note (Siri quick note)");

    const document = Buffer.from(body.content, "base64").toString("utf8");
    expect(document).toContain("type: capture");
    expect(document).toContain("created: 2026-07-06 19:30");
    expect(document).toContain('source: "Siri quick note"');
    expect(document).toContain("topics: []");
    expect(document).toContain("buy new headphones");
  });

  test("retries with the next suffix when the path already exists", async () => {
    const { calls, fetchImpl } = fakeFetch([422, 201]);
    const result = await createQuickNote(
      CREDENTIALS,
      { text: "note", source: DEFAULT_QUICK_NOTE_SOURCE },
      PDT_NOW,
      fetchImpl,
    );
    expect(result.ok && result.value.path).toBe(
      "Inbox/2026-07-06 1930 Quick note -2.md",
    );
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.init.method).toBe("PUT");
      expect(JSON.parse(String(call.init.body)).sha).toBeUndefined();
    }
  });

  test("maps GitHub failures to clear errors", async () => {
    const { fetchImpl } = fakeFetch([401]);
    const result = await createQuickNote(
      CREDENTIALS,
      { text: "note", source: DEFAULT_QUICK_NOTE_SOURCE },
      PDT_NOW,
      fetchImpl,
    );
    expect(result).toEqual({
      ok: false,
      error: "vault token was rejected by GitHub",
    });
  });
});
