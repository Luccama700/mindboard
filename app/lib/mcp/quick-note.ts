// Pure logic for the public /api/capture endpoint (Siri voice quick-notes and
// iOS share-sheet captures): static-bearer auth compare, payload validation,
// the "Quick note" / attachment filenames, and the frontmatter document. The
// vault writes reuse capture_to_brain's create-only Inbox/ writer
// (createVaultFileWithRetry / createVaultBase64FileWithRetry), so this path
// inherits its invariants: never update, never delete, Inbox/ only. No server
// imports (mirrors capture.ts) so it unit-tests directly.

import { timingSafeEqual } from "node:crypto";

import type { Result } from "./validate";
import {
  createVaultBase64FileWithRetry,
  createVaultFileWithRetry,
  sanitizeCaptureTitle,
  vancouverStamp,
  yamlQuote,
  type CaptureStamp,
  type VaultWriteCredentials,
} from "./capture";

export const QUICK_NOTE_TEXT_MAX = 20_000;
export const QUICK_NOTE_SOURCE_MAX = 200;
export const QUICK_FILE_NAME_MAX = 80;
// Vercel caps request bodies at 4.5 MB; 3 MB decoded leaves room for the
// base64 inflation (4/3) plus JSON overhead.
export const QUICK_FILE_MAX_BYTES = 3 * 1024 * 1024;
export const DEFAULT_QUICK_NOTE_SOURCE = "Siri quick note";

export function bearerAuthorized(
  header: string | null,
  secret: string | undefined,
): boolean {
  if (!secret) return false;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : "";
  const a = Buffer.from(token);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Single fixed window, global (not per-IP): the endpoint serves one user's
// Shortcuts, so a whole-endpoint cap is the right shape. Per-instance and
// best-effort under Fluid Compute — a brake, not a security boundary.
export function createRateLimiter(
  max: number,
  windowMs: number,
): (nowMs: number) => boolean {
  let windowStart = 0;
  let count = 0;
  return (nowMs: number) => {
    if (nowMs - windowStart >= windowMs) {
      windowStart = nowMs;
      count = 0;
    }
    count += 1;
    return count <= max;
  };
}

export type QuickFile = { name: string; base64: string };

export type QuickNoteInput = {
  text: string;
  source: string;
  file: QuickFile | null;
};

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

function validateQuickFile(
  rawName: unknown,
  rawBase64: unknown,
): Result<QuickFile | null> {
  if (rawName == null && rawBase64 == null) return { ok: true, value: null };
  if (rawName == null || rawBase64 == null) {
    return {
      ok: false,
      error: "file_name and file_base64 must be provided together",
    };
  }
  if (typeof rawName !== "string" || typeof rawBase64 !== "string") {
    return { ok: false, error: "file_name and file_base64 must be strings" };
  }

  const name = rawName.trim();
  if (!name) return { ok: false, error: "file_name is required" };
  if (name.length > QUICK_FILE_NAME_MAX) {
    return {
      ok: false,
      error: `file_name must be at most ${QUICK_FILE_NAME_MAX} characters (got ${name.length})`,
    };
  }
  const safeName = sanitizeCaptureTitle(name);
  if (!safeName.ok) return safeName;

  // Shortcuts' Base64 Encode can emit line breaks; strip whitespace first.
  const base64 = rawBase64.replace(/\s+/g, "");
  if (!base64 || !BASE64_RE.test(base64)) {
    return { ok: false, error: "file_base64 must be base64-encoded data" };
  }
  const byteLength = Buffer.from(base64, "base64").length;
  if (byteLength === 0) {
    return { ok: false, error: "file_base64 decoded to zero bytes" };
  }
  if (byteLength > QUICK_FILE_MAX_BYTES) {
    return {
      ok: false,
      error: `file must be at most ${QUICK_FILE_MAX_BYTES} bytes decoded (got ${byteLength})`,
    };
  }

  return { ok: true, value: { name: safeName.value, base64 } };
}

export function validateQuickNote(raw: unknown): Result<QuickNoteInput> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "body must be a JSON object" };
  }
  const record = raw as Record<string, unknown>;

  if (record.text != null && typeof record.text !== "string") {
    return { ok: false, error: "text must be a string" };
  }
  const text = typeof record.text === "string" ? record.text.trim() : "";
  if (text.length > QUICK_NOTE_TEXT_MAX) {
    return {
      ok: false,
      error: `text must be at most ${QUICK_NOTE_TEXT_MAX} characters (got ${text.length})`,
    };
  }

  const file = validateQuickFile(record.file_name, record.file_base64);
  if (!file.ok) return file;

  if (!text && !file.value) {
    return { ok: false, error: "text or a file is required" };
  }

  if (record.source != null && typeof record.source !== "string") {
    return { ok: false, error: "source must be a string" };
  }
  const source =
    (typeof record.source === "string" ? record.source.trim() : "") ||
    DEFAULT_QUICK_NOTE_SOURCE;
  if (source.length > QUICK_NOTE_SOURCE_MAX) {
    return {
      ok: false,
      error: `source must be at most ${QUICK_NOTE_SOURCE_MAX} characters (got ${source.length})`,
    };
  }

  return { ok: true, value: { text, source, file: file.value } };
}

export function quickNotePath(
  stamp: CaptureStamp,
  attempt: number,
  title = "Quick note",
): string {
  const suffix = attempt > 1 ? ` -${attempt}` : "";
  return `Inbox/${stamp.dateKey} ${stamp.timeKey} ${title}${suffix}.md`;
}

function splitExtension(name: string): { base: string; ext: string } {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return { base: name, ext: "" };
  return { base: name.slice(0, dot), ext: name.slice(dot) };
}

// Collision suffix goes before the extension so the file stays openable:
// "report.pdf" → "report -2.pdf".
export function quickFilePath(
  stamp: CaptureStamp,
  safeName: string,
  attempt: number,
): string {
  const { base, ext } = splitExtension(safeName);
  const suffix = attempt > 1 ? ` -${attempt}` : "";
  return `Inbox/${stamp.dateKey} ${stamp.timeKey} ${base}${suffix}${ext}`;
}

export function buildQuickNoteDocument(
  input: QuickNoteInput,
  created: string,
  attachmentFileName?: string,
): string {
  // topics stays an explicit empty list (capture_to_brain omits it when empty):
  // a quick note never arrives pre-tagged, and the empty slot is the reviewer's
  // cue to file it during the vault's distill pass.
  const body = [
    input.text,
    attachmentFileName ? `![[${attachmentFileName}]]` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  return [
    "---",
    "type: capture",
    `created: ${created}`,
    `source: ${yamlQuote(input.source)}`,
    "topics: []",
    "---",
    "",
    body,
    "",
  ].join("\n");
}

export type QuickNoteOutcome = { path: string; filePath?: string };

export async function createQuickNote(
  credentials: VaultWriteCredentials,
  input: QuickNoteInput,
  now: Date,
  fetchImpl: typeof fetch = fetch,
): Promise<Result<QuickNoteOutcome>> {
  const stamp = vancouverStamp(now);

  let attachment: { path: string; fileName: string } | null = null;
  if (input.file) {
    const written = await createVaultBase64FileWithRetry(
      credentials,
      (attempt) => quickFilePath(stamp, input.file!.name, attempt),
      input.file.base64,
      `Capture: ${input.file.name} (${input.source})`,
      fetchImpl,
    );
    if (!written.ok) return written;
    attachment = {
      path: written.value.path,
      fileName: written.value.path.slice("Inbox/".length),
    };
  }

  const noteTitle = input.file
    ? splitExtension(input.file.name).base
    : "Quick note";
  const note = await createVaultFileWithRetry(
    credentials,
    (attempt) => quickNotePath(stamp, attempt, noteTitle),
    buildQuickNoteDocument(input, stamp.created, attachment?.fileName),
    `Capture: ${noteTitle} (${input.source})`,
    fetchImpl,
  );
  if (!note.ok) {
    return attachment
      ? {
          ok: false,
          error: `${note.error} (the shared file itself was saved to ${attachment.path})`,
        }
      : note;
  }

  return {
    ok: true,
    value: {
      path: note.value.path,
      ...(attachment ? { filePath: attachment.path } : {}),
    },
  };
}
