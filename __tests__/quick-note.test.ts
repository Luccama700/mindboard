import { describe, expect, test } from "vitest";
import type { VaultWriteCredentials } from "@/app/lib/mcp/capture";
import {
  DEFAULT_QUICK_NOTE_SOURCE,
  QUICK_FILE_MAX_BYTES,
  QUICK_NOTE_SOURCE_MAX,
  QUICK_NOTE_TEXT_MAX,
  bearerAuthorized,
  buildQuickNoteDocument,
  createQuickNote,
  createRateLimiter,
  quickFilePath,
  quickNotePath,
  sniffExtension,
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
      value: {
        text: "pick up the parcel",
        source: DEFAULT_QUICK_NOTE_SOURCE,
        title: "Quick note",
        file: null,
      },
    });
  });

  test("uses a provided source, trimmed", () => {
    expect(
      validateQuickNote({ text: "note", source: " Drafts app " }),
    ).toEqual({
      ok: true,
      value: {
        text: "note",
        source: "Drafts app",
        title: "Quick note",
        file: null,
      },
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
    [{}, "text or a file is required"],
    [{ text: "   " }, "text or a file is required"],
    [{ text: 42 }, "text must be a string"],
    [{ text: "note", source: 42 }, "source must be a string"],
  ])("rejects %j", (raw, error) => {
    expect(validateQuickNote(raw)).toEqual({ ok: false, error });
  });

  test("accepts a file with no text, titling the note after it", () => {
    const result = validateQuickNote({
      file_name: "report.pdf",
      file_base64: "aGVsbG8=",
      source: "iOS share",
    });
    expect(result).toEqual({
      ok: true,
      value: {
        text: "",
        source: "iOS share",
        title: "report",
        file: { name: "report.pdf", base64: "aGVsbG8=" },
      },
    });
  });

  test("strips whitespace from Shortcuts-style base64", () => {
    const result = validateQuickNote({
      file_name: "a.bin",
      file_base64: "aGVs\nbG8=",
    });
    expect(result.ok && result.value.file?.base64).toBe("aGVsbG8=");
  });

  test.each([
    [
      { file_name: "report.pdf" },
      "file_name and file_base64 must be provided together",
    ],
    [
      { file_base64: "aGVsbG8=" },
      "file_name and file_base64 must be provided together",
    ],
    [
      { file_name: 42, file_base64: "aGVsbG8=" },
      "file_name and file_base64 must be strings",
    ],
    [
      { file_name: "  ", file_base64: "aGVsbG8=" },
      "file_name is required",
    ],
    [
      { file_name: "../../evil.sh", file_base64: "aGVsbG8=" },
      "title must not contain path traversal",
    ],
    [
      { file_name: "a.txt", file_base64: "not base64!!" },
      "file_base64 must be base64-encoded data",
    ],
  ])("rejects bad file input %j", (raw, error) => {
    expect(validateQuickNote(raw)).toEqual({ ok: false, error });
  });

  test("a textual share inlines into the note instead of attaching", () => {
    // An Instagram share arrives as an extension-less blob whose bytes are
    // just the link — it should become note text, not a .txt-in-.md sandwich.
    const result = validateQuickNote({
      file_name: "Instagram",
      file_base64: Buffer.from("https://instagram.com/p/abc").toString(
        "base64",
      ),
      source: "iOS share",
    });
    expect(result).toEqual({
      ok: true,
      value: {
        text: "https://instagram.com/p/abc",
        source: "iOS share",
        title: "Instagram",
        file: null,
      },
    });
  });

  test("a named .txt inlines too, after any provided text", () => {
    const result = validateQuickNote({
      text: "from the meeting",
      file_name: "notes.txt",
      file_base64: Buffer.from("agenda item one").toString("base64"),
    });
    expect(result.ok && result.value.text).toBe(
      "from the meeting\n\nagenda item one",
    );
    expect(result.ok && result.value.file).toBeNull();
    expect(result.ok && result.value.title).toBe("notes");
  });

  test("an oversized textual share stays an attachment", () => {
    const result = validateQuickNote({
      file_name: "huge.txt",
      file_base64: Buffer.from("x".repeat(QUICK_NOTE_TEXT_MAX + 1)).toString(
        "base64",
      ),
    });
    expect(result.ok && result.value.file?.name).toBe("huge.txt");
    expect(result.ok && result.value.text).toBe("");
  });

  test("a name that already has an extension is left alone", () => {
    const result = validateQuickNote({
      file_name: "photo.jpeg",
      file_base64: Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString("base64"),
    });
    expect(result.ok && result.value.file?.name).toBe("photo.jpeg");
  });

  test("rejects a file over the size cap", () => {
    const oversized = Buffer.alloc(QUICK_FILE_MAX_BYTES + 1).toString("base64");
    const result = validateQuickNote({
      file_name: "big.bin",
      file_base64: oversized,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("file must be at most");
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

  test("a custom title replaces Quick note", () => {
    expect(quickNotePath(stamp, 1, "report")).toBe(
      "Inbox/2026-07-06 1930 report.md",
    );
  });
});

describe("sniffExtension", () => {
  test.each([
    [Buffer.from("%PDF-1.7 rest"), ".pdf"],
    [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]), ".png"],
    [Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00]), ".jpg"],
    [Buffer.from("GIF89a"), ".gif"],
    [Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP")]), ".webp"],
    [Buffer.concat([Buffer.alloc(4), Buffer.from("ftypheic")]), ".heic"],
    [Buffer.concat([Buffer.alloc(4), Buffer.from("ftypisom")]), ".mp4"],
    [Buffer.from("PK\x03\x04zipdata"), ".zip"],
    [Buffer.from("plain shared text\nwith lines"), ".txt"],
    [Buffer.from([0x00, 0x01, 0x02, 0xfe, 0xff]), ".bin"],
  ])("case %#: sniffs %s", (bytes, ext) => {
    expect(sniffExtension(bytes)).toBe(ext);
  });
});

describe("quickFilePath", () => {
  const stamp: CaptureStamp = {
    dateKey: "2026-07-06",
    timeKey: "1930",
    created: "2026-07-06 19:30",
  };

  test("keeps the extension and stamps like notes", () => {
    expect(quickFilePath(stamp, "report.pdf", 1)).toBe(
      "Inbox/2026-07-06 1930 report.pdf",
    );
  });

  test("collision suffix lands before the extension", () => {
    expect(quickFilePath(stamp, "report.pdf", 2)).toBe(
      "Inbox/2026-07-06 1930 report -2.pdf",
    );
  });

  test("handles names without an extension", () => {
    expect(quickFilePath(stamp, "README", 2)).toBe(
      "Inbox/2026-07-06 1930 README -2",
    );
  });
});

describe("buildQuickNoteDocument", () => {
  test("frontmatter shape with an explicit empty topics list", () => {
    const doc = buildQuickNoteDocument(
      {
        text: 'remember to email "Sam"',
        source: DEFAULT_QUICK_NOTE_SOURCE,
        title: "Quick note",
        file: null,
      },
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

  test("embeds the attachment after the text", () => {
    const doc = buildQuickNoteDocument(
      {
        text: "the signed lease",
        source: "iOS share",
        title: "lease",
        file: { name: "lease.pdf", base64: "aGVsbG8=" },
      },
      "2026-07-06 19:30",
      "2026-07-06 1930 lease.pdf",
    );
    expect(doc).toContain(
      "the signed lease\n\n![[2026-07-06 1930 lease.pdf]]",
    );
  });

  test("an attachment with no text embeds alone", () => {
    const doc = buildQuickNoteDocument(
      {
        text: "",
        source: "iOS share",
        title: "lease",
        file: { name: "lease.pdf", base64: "aGVsbG8=" },
      },
      "2026-07-06 19:30",
      "2026-07-06 1930 lease.pdf",
    );
    expect(doc).toContain("---\n\n![[2026-07-06 1930 lease.pdf]]\n");
  });
});

describe("createQuickNote", () => {
  test("creates the file under Inbox/ with a create-only PUT", async () => {
    const { calls, fetchImpl } = fakeFetch([201]);
    const result = await createQuickNote(
      CREDENTIALS,
      {
        text: "buy new headphones",
        source: DEFAULT_QUICK_NOTE_SOURCE,
        title: "Quick note",
        file: null,
      },
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
      {
        text: "note",
        source: DEFAULT_QUICK_NOTE_SOURCE,
        title: "Quick note",
        file: null,
      },
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
      {
        text: "note",
        source: DEFAULT_QUICK_NOTE_SOURCE,
        title: "Quick note",
        file: null,
      },
      PDT_NOW,
      fetchImpl,
    );
    expect(result).toEqual({
      ok: false,
      error: "vault token was rejected by GitHub",
    });
  });

  test("a shared file commits the attachment, then a note embedding it", async () => {
    const { calls, fetchImpl } = fakeFetch([201, 201]);
    const result = await createQuickNote(
      CREDENTIALS,
      {
        text: "the signed lease",
        source: "iOS share",
        title: "lease",
        file: { name: "lease.pdf", base64: "aGVsbG8=" },
      },
      PDT_NOW,
      fetchImpl,
    );

    expect(result).toEqual({
      ok: true,
      value: {
        path: "Inbox/2026-07-06 1930 lease.md",
        filePath: "Inbox/2026-07-06 1930 lease.pdf",
      },
    });

    expect(calls).toHaveLength(2);
    expect(calls[0].url).toContain(
      encodeURIComponent("2026-07-06 1930 lease.pdf"),
    );
    const fileBody = JSON.parse(String(calls[0].init.body));
    // Binary passthrough: the client's base64 goes to GitHub untouched.
    expect(fileBody.content).toBe("aGVsbG8=");
    expect(fileBody.sha).toBeUndefined();
    expect(fileBody.message).toBe("Capture: lease.pdf (iOS share)");

    const noteBody = JSON.parse(String(calls[1].init.body));
    const document = Buffer.from(noteBody.content, "base64").toString("utf8");
    expect(document).toContain("the signed lease");
    expect(document).toContain("![[2026-07-06 1930 lease.pdf]]");
  });

  test("the note embeds the collision-suffixed attachment name", async () => {
    const { calls, fetchImpl } = fakeFetch([422, 201, 201]);
    const result = await createQuickNote(
      CREDENTIALS,
      {
        text: "",
        source: "iOS share",
        title: "lease",
        file: { name: "lease.pdf", base64: "aGVsbG8=" },
      },
      PDT_NOW,
      fetchImpl,
    );

    expect(result.ok && result.value.filePath).toBe(
      "Inbox/2026-07-06 1930 lease -2.pdf",
    );
    const noteBody = JSON.parse(String(calls[2].init.body));
    const document = Buffer.from(noteBody.content, "base64").toString("utf8");
    expect(document).toContain("![[2026-07-06 1930 lease -2.pdf]]");
  });

  test("a failed file write stops before the note", async () => {
    const { calls, fetchImpl } = fakeFetch([403]);
    const result = await createQuickNote(
      CREDENTIALS,
      {
        text: "",
        source: "iOS share",
        title: "lease",
        file: { name: "lease.pdf", base64: "aGVsbG8=" },
      },
      PDT_NOW,
      fetchImpl,
    );
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(1);
  });

  test("a failed note write reports the already-saved file", async () => {
    const { fetchImpl } = fakeFetch([201, 500]);
    const result = await createQuickNote(
      CREDENTIALS,
      {
        text: "",
        source: "iOS share",
        title: "lease",
        file: { name: "lease.pdf", base64: "aGVsbG8=" },
      },
      PDT_NOW,
      fetchImpl,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain(
        "the shared file itself was saved to Inbox/2026-07-06 1930 lease.pdf",
      );
    }
  });
});
