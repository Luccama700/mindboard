// Pure logic for the capture_to_brain tool: input validation, filename
// sanitization, America/Vancouver stamping, frontmatter assembly, and the
// create-only GitHub Contents write with collision retry. No server imports
// (mirrors validate.ts) so it unit-tests directly; fetch is injectable. The
// server glue that resolves the owner + vault credentials lives in ./brain.ts.

import type { Result } from "./validate";

export const CAPTURE_TITLE_MAX = 80;
export const CAPTURE_SUMMARY_MAX = 20_000;
export const CAPTURE_MAX_ATTEMPTS = 10;

// Mirrors VaultNotConfiguredError ("vault not connected") with the fix hint.
export const VAULT_NOT_CONFIGURED_MESSAGE =
  "vault not connected; set it up in /settings";

export type CaptureInput = {
  title: string;
  summary: string;
  source: string;
  topics: string[];
};

// Structurally identical to VaultCredentials in app/lib/brain/vault.ts; local
// so this module stays free of server-only imports.
export type VaultWriteCredentials = {
  repo: string;
  branch: string;
  token: string;
};

export function validateCapture(raw: {
  title?: unknown;
  summary_markdown?: unknown;
  source?: unknown;
  topics?: unknown;
}): Result<CaptureInput> {
  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  if (!title) return { ok: false, error: "title is required" };
  if (title.length > CAPTURE_TITLE_MAX) {
    return {
      ok: false,
      error: `title must be at most ${CAPTURE_TITLE_MAX} characters (got ${title.length})`,
    };
  }

  const summary =
    typeof raw.summary_markdown === "string" ? raw.summary_markdown.trim() : "";
  if (!summary) return { ok: false, error: "summary_markdown is required" };
  if (summary.length > CAPTURE_SUMMARY_MAX) {
    return {
      ok: false,
      error: `summary_markdown must be at most ${CAPTURE_SUMMARY_MAX} characters (got ${summary.length})`,
    };
  }

  const source = typeof raw.source === "string" ? raw.source.trim() : "";
  if (!source) return { ok: false, error: "source is required" };

  let topics: string[] = [];
  if (raw.topics != null) {
    if (
      !Array.isArray(raw.topics) ||
      raw.topics.some((topic) => typeof topic !== "string")
    ) {
      return { ok: false, error: "topics must be an array of strings" };
    }
    topics = (raw.topics as string[])
      .map((topic) => topic.trim())
      .filter(Boolean);
  }

  return { ok: true, value: { title, summary, source, topics } };
}

// A ".." path segment anywhere in the raw title (before separators are
// stripped) is treated as a traversal attempt and rejected outright; plain
// ellipses ("wait...") are fine because their dots don't form a segment.
const TRAVERSAL_RE = /(^|[\\/])\.\.(?=[\\/]|$)/;

export function sanitizeCaptureTitle(title: string): Result<string> {
  if (TRAVERSAL_RE.test(title)) {
    return { ok: false, error: "title must not contain path traversal" };
  }
  const cleaned = title
    .replace(/[\\/]/g, " ")
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    // A leading dot would make the note a hidden file the vault reader skips.
    .replace(/^\.+/, "");
  if (!cleaned) {
    return { ok: false, error: "title has no filename-safe characters" };
  }
  return { ok: true, value: cleaned };
}

export type CaptureStamp = {
  dateKey: string; // YYYY-MM-DD
  timeKey: string; // HHmm
  created: string; // YYYY-MM-DD HH:mm
};

export function vancouverStamp(now: Date): CaptureStamp {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Vancouver",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts: Record<string, string> = {};
  for (const part of formatter.formatToParts(now)) parts[part.type] = part.value;
  const dateKey = `${parts.year}-${parts.month}-${parts.day}`;
  return {
    dateKey,
    timeKey: `${parts.hour}${parts.minute}`,
    created: `${dateKey} ${parts.hour}:${parts.minute}`,
  };
}

export function captureFilePath(
  stamp: CaptureStamp,
  safeTitle: string,
  attempt: number,
): string {
  const suffix = attempt > 1 ? ` -${attempt}` : "";
  return `Inbox/${stamp.dateKey} ${stamp.timeKey} ${safeTitle}${suffix}.md`;
}

export function yamlQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function buildCaptureDocument(
  input: CaptureInput,
  created: string,
): string {
  const lines = [
    "---",
    "type: capture",
    `created: ${created}`,
    `source: ${yamlQuote(input.source)}`,
  ];
  if (input.topics.length > 0) {
    lines.push(`topics: [${input.topics.map(yamlQuote).join(", ")}]`);
  }
  lines.push("---", "", input.summary, "");
  return lines.join("\n");
}

function encodeGitHubPath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

export type CaptureOutcome = { path: string; message: string };

// Generic create-only vault write with collision retry, shared by
// capture_to_brain (Inbox/) and the course-source writer (Courses/). The
// payload never carries a `sha`, so GitHub can only ever create the path —
// never update it. An existing path comes back 422 (409 on a ref race) and we
// retry with the caller's next " -N" suffixed path.
export async function createVaultFileWithRetry(
  credentials: VaultWriteCredentials,
  pathForAttempt: (attempt: number) => string,
  content: string,
  commitMessage: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Result<{ path: string }>> {
  const payload = {
    message: commitMessage,
    content: Buffer.from(content, "utf8").toString("base64"),
    // No committer override: GitHub attributes the commit to the owner of the
    // vault token (the user), matching their normal commits.
    branch: credentials.branch,
  };

  for (let attempt = 1; attempt <= CAPTURE_MAX_ATTEMPTS; attempt++) {
    const path = pathForAttempt(attempt);
    let response: Response;
    try {
      response = await fetchImpl(
        `https://api.github.com/repos/${credentials.repo}/contents/${encodeGitHubPath(path)}`,
        {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${credentials.token}`,
            "X-GitHub-Api-Version": "2022-11-28",
            Accept: "application/vnd.github+json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        },
      );
    } catch {
      return { ok: false, error: "could not reach GitHub" };
    }

    if (response.ok) return { ok: true, value: { path } };
    if (response.status === 409 || response.status === 422) continue;
    if (response.status === 401) {
      return { ok: false, error: "vault token was rejected by GitHub" };
    }
    if (response.status === 403) {
      return {
        ok: false,
        error: "vault token lacks Contents write permission on that repo",
      };
    }
    if (response.status === 404) {
      return {
        ok: false,
        error:
          "vault repo or branch not found (or the token lacks Contents write access)",
      };
    }
    return { ok: false, error: `vault write failed (${response.status})` };
  }

  return {
    ok: false,
    error: "could not find a free filename for this capture (too many collisions)",
  };
}

async function createCaptureFile(
  credentials: VaultWriteCredentials,
  input: CaptureInput,
  safeTitle: string,
  now: Date,
  fetchImpl: typeof fetch,
): Promise<Result<CaptureOutcome>> {
  const stamp = vancouverStamp(now);
  const written = await createVaultFileWithRetry(
    credentials,
    (attempt) => captureFilePath(stamp, safeTitle, attempt),
    buildCaptureDocument(input, stamp.created),
    `Capture: ${input.title} (via MCP)`,
    fetchImpl,
  );
  if (!written.ok) return written;
  return {
    ok: true,
    value: {
      path: written.value.path,
      message: `Captured "${input.title}" to ${written.value.path} for review.`,
    },
  };
}

export async function runCapture(
  credentials: VaultWriteCredentials | null,
  raw: unknown,
  now: Date,
  fetchImpl: typeof fetch = fetch,
): Promise<Result<CaptureOutcome>> {
  if (!credentials) return { ok: false, error: VAULT_NOT_CONFIGURED_MESSAGE };

  const parsed = validateCapture((raw ?? {}) as Record<string, unknown>);
  if (!parsed.ok) return parsed;

  const safeTitle = sanitizeCaptureTitle(parsed.value.title);
  if (!safeTitle.ok) return safeTitle;

  return createCaptureFile(credentials, parsed.value, safeTitle.value, now, fetchImpl);
}
