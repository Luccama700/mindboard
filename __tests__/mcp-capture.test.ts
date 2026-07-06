import { describe, expect, test } from "vitest";
import {
  CAPTURE_MAX_ATTEMPTS,
  CAPTURE_SUMMARY_MAX,
  CAPTURE_TITLE_MAX,
  VAULT_NOT_CONFIGURED_MESSAGE,
  buildCaptureDocument,
  captureFilePath,
  runCapture,
  sanitizeCaptureTitle,
  validateCapture,
  vancouverStamp,
  type CaptureStamp,
  type VaultWriteCredentials,
} from "@/app/lib/mcp/capture";

const CREDENTIALS: VaultWriteCredentials = {
  repo: "lucca/vault",
  branch: "main",
  token: "ghp_test",
};

const GOOD_INPUT = {
  title: "Career planning chat",
  summary_markdown: "We discussed the fall co-op search.",
  source: "claude.ai chat, 2026-07-06",
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

describe("validateCapture", () => {
  test("accepts a full input and trims fields", () => {
    const result = validateCapture({
      title: "  Career planning chat  ",
      summary_markdown: "  body  ",
      source: " claude.ai chat, 2026-07-06 ",
      topics: [" career ", "", "co-op"],
    });
    expect(result).toEqual({
      ok: true,
      value: {
        title: "Career planning chat",
        summary: "body",
        source: "claude.ai chat, 2026-07-06",
        topics: ["career", "co-op"],
      },
    });
  });

  test.each([
    [{ ...GOOD_INPUT, title: undefined }, "title is required"],
    [{ ...GOOD_INPUT, title: "   " }, "title is required"],
    [{ ...GOOD_INPUT, summary_markdown: "" }, "summary_markdown is required"],
    [{ ...GOOD_INPUT, source: undefined }, "source is required"],
    [{ ...GOOD_INPUT, topics: "career" }, "topics must be an array of strings"],
    [{ ...GOOD_INPUT, topics: ["ok", 3] }, "topics must be an array of strings"],
  ])("rejects bad input %#", (raw, error) => {
    expect(validateCapture(raw as Record<string, unknown>)).toEqual({
      ok: false,
      error,
    });
  });

  test("rejects an over-limit title with a clear error", () => {
    const result = validateCapture({
      ...GOOD_INPUT,
      title: "x".repeat(CAPTURE_TITLE_MAX + 1),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("at most 80 characters");
  });

  test("rejects an over-limit summary with a clear error", () => {
    const result = validateCapture({
      ...GOOD_INPUT,
      summary_markdown: "x".repeat(CAPTURE_SUMMARY_MAX + 1),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("at most 20000 characters");
  });

  test("topics are optional", () => {
    const result = validateCapture(GOOD_INPUT);
    expect(result.ok && result.value.topics).toEqual([]);
  });
});

describe("sanitizeCaptureTitle", () => {
  test("strips path separators and collapses whitespace", () => {
    expect(sanitizeCaptureTitle("notes / re:  q3\\plan")).toEqual({
      ok: true,
      value: "notes re: q3 plan",
    });
  });

  test("replaces control characters", () => {
    expect(sanitizeCaptureTitle("line\none\ttwo")).toEqual({
      ok: true,
      value: "line one two",
    });
  });

  test("strips leading dots so the file is not hidden", () => {
    expect(sanitizeCaptureTitle(".hidden note")).toEqual({
      ok: true,
      value: "hidden note",
    });
  });

  test.each(["../escape", "notes/../../etc/passwd", "..", "..\\windows"])(
    "rejects traversal in %j",
    (title) => {
      expect(sanitizeCaptureTitle(title)).toEqual({
        ok: false,
        error: "title must not contain path traversal",
      });
    },
  );

  test("allows ellipses", () => {
    expect(sanitizeCaptureTitle("wait... what")).toEqual({
      ok: true,
      value: "wait... what",
    });
  });

  test("rejects titles with nothing filename-safe left", () => {
    const result = sanitizeCaptureTitle("///");
    expect(result.ok).toBe(false);
  });
});

describe("vancouverStamp", () => {
  test("summer (PDT) crossing the UTC date line", () => {
    expect(vancouverStamp(PDT_NOW)).toEqual({
      dateKey: "2026-07-06",
      timeKey: "1930",
      created: "2026-07-06 19:30",
    });
  });

  test("winter (PST)", () => {
    expect(vancouverStamp(new Date("2026-01-15T01:05:00Z"))).toEqual({
      dateKey: "2026-01-14",
      timeKey: "1705",
      created: "2026-01-14 17:05",
    });
  });

  test("midnight renders as 00, not 24", () => {
    expect(vancouverStamp(new Date("2026-07-06T07:00:00Z")).timeKey).toBe(
      "0000",
    );
  });
});

describe("captureFilePath", () => {
  const stamp: CaptureStamp = {
    dateKey: "2026-07-06",
    timeKey: "1930",
    created: "2026-07-06 19:30",
  };

  test("first attempt has no suffix", () => {
    expect(captureFilePath(stamp, "Career chat", 1)).toBe(
      "Inbox/2026-07-06 1930 Career chat.md",
    );
  });

  test("collisions append -2, -3", () => {
    expect(captureFilePath(stamp, "Career chat", 2)).toBe(
      "Inbox/2026-07-06 1930 Career chat -2.md",
    );
    expect(captureFilePath(stamp, "Career chat", 3)).toBe(
      "Inbox/2026-07-06 1930 Career chat -3.md",
    );
  });
});

describe("buildCaptureDocument", () => {
  test("frontmatter shape with topics", () => {
    const doc = buildCaptureDocument(
      {
        title: "Career chat",
        summary: "We discussed things.",
        source: 'claude.ai "chat", 2026-07-06',
        topics: ["career", "co-op"],
      },
      "2026-07-06 19:30",
    );
    expect(doc).toBe(
      [
        "---",
        "type: capture",
        "created: 2026-07-06 19:30",
        'source: "claude.ai \\"chat\\", 2026-07-06"',
        'topics: ["career", "co-op"]',
        "---",
        "",
        "We discussed things.",
        "",
      ].join("\n"),
    );
  });

  test("omits the topics line when there are none", () => {
    const doc = buildCaptureDocument(
      { title: "t", summary: "body", source: "s", topics: [] },
      "2026-07-06 19:30",
    );
    expect(doc).not.toContain("topics:");
  });
});

describe("runCapture", () => {
  test("returns the not-configured message when the vault is not connected", async () => {
    const result = await runCapture(null, GOOD_INPUT, PDT_NOW);
    expect(result).toEqual({ ok: false, error: VAULT_NOT_CONFIGURED_MESSAGE });
  });

  test("creates the file under Inbox/ with a create-only PUT", async () => {
    const { calls, fetchImpl } = fakeFetch([201]);
    const result = await runCapture(
      CREDENTIALS,
      { ...GOOD_INPUT, topics: ["career"] },
      PDT_NOW,
      fetchImpl,
    );

    expect(result).toEqual({
      ok: true,
      value: {
        path: "Inbox/2026-07-06 1930 Career planning chat.md",
        message:
          'Captured "Career planning chat" to Inbox/2026-07-06 1930 Career planning chat.md for review.',
      },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].init.method).toBe("PUT");
    expect(calls[0].url).toBe(
      "https://api.github.com/repos/lucca/vault/contents/Inbox/" +
        encodeURIComponent("2026-07-06 1930 Career planning chat.md"),
    );

    const body = JSON.parse(String(calls[0].init.body));
    expect(body.sha).toBeUndefined();
    expect(body.branch).toBe("main");
    expect(body.message).toBe("Capture: Career planning chat (via MCP)");
    // No committer override — GitHub attributes the commit to the token owner.
    expect(body.committer).toBeUndefined();

    const document = Buffer.from(body.content, "base64").toString("utf8");
    expect(document).toContain("type: capture");
    expect(document).toContain("created: 2026-07-06 19:30");
    expect(document).toContain('source: "claude.ai chat, 2026-07-06"');
    expect(document).toContain('topics: ["career"]');
    expect(document).toContain("We discussed the fall co-op search.");
  });

  test("retries with the next suffix when the path already exists", async () => {
    const { calls, fetchImpl } = fakeFetch([422, 422, 201]);
    const result = await runCapture(CREDENTIALS, GOOD_INPUT, PDT_NOW, fetchImpl);

    expect(result.ok && result.value.path).toBe(
      "Inbox/2026-07-06 1930 Career planning chat -3.md",
    );
    // Create-only: every attempt is a sha-less PUT, never a GET for the
    // existing file's sha.
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.init.method).toBe("PUT");
      expect(JSON.parse(String(call.init.body)).sha).toBeUndefined();
    }
    expect(calls[1].url).toContain(encodeURIComponent("chat -2.md"));
    expect(calls[2].url).toContain(encodeURIComponent("chat -3.md"));
  });

  test("gives up after too many collisions", async () => {
    const { calls, fetchImpl } = fakeFetch([422]);
    const result = await runCapture(CREDENTIALS, GOOD_INPUT, PDT_NOW, fetchImpl);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("too many collisions");
    expect(calls).toHaveLength(CAPTURE_MAX_ATTEMPTS);
  });

  test.each([
    [401, "vault token was rejected by GitHub"],
    [403, "vault token lacks Contents write permission on that repo"],
    [404, "vault repo or branch not found (or the token lacks Contents write access)"],
    [500, "vault write failed (500)"],
  ])("maps GitHub %d to a clear error", async (status, error) => {
    const { fetchImpl } = fakeFetch([status]);
    const result = await runCapture(CREDENTIALS, GOOD_INPUT, PDT_NOW, fetchImpl);
    expect(result).toEqual({ ok: false, error });
  });

  test("rejects invalid input before any network call", async () => {
    const { calls, fetchImpl } = fakeFetch([201]);
    const result = await runCapture(
      CREDENTIALS,
      { ...GOOD_INPUT, title: "../escape" },
      PDT_NOW,
      fetchImpl,
    );
    expect(result).toEqual({
      ok: false,
      error: "title must not contain path traversal",
    });
    expect(calls).toHaveLength(0);
  });
});
