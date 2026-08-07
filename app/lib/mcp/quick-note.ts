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

type ParsedQuickFile = QuickFile & { asText: string | null };

export type QuickNoteInput = {
  text: string;
  source: string;
  // The note's filename word: "Quick note" for bare text, the shared file's
  // base name when a file came along (inlined or attached).
  title: string;
  file: QuickFile | null;
  // The attachment's decoded UTF-8 text when it couldn't inline (too big):
  // link detection must scan here too, since share sheets can deliver a page
  // dump whose URL never reaches `text`.
  fileText?: string | null;
};

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

// An extension-less attachment is a hazard: its companion note embeds it as
// ![[<name>]], and a wikilink without an extension resolves to the .md note of
// the same basename first — the note embeds itself, recursively. So when the
// shared name has no extension (Photos and odd share-sheet items often don't),
// sniff one from the magic bytes; UTF-8 text falls back to .txt, anything
// unrecognized to .bin.
export function sniffExtension(bytes: Buffer): string {
  if (bytes.subarray(0, 4).toString("latin1") === "%PDF") return ".pdf";
  if (bytes.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) {
    return ".png";
  }
  if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) {
    return ".jpg";
  }
  if (bytes.subarray(0, 4).toString("latin1") === "GIF8") return ".gif";
  if (
    bytes.subarray(0, 4).toString("latin1") === "RIFF" &&
    bytes.subarray(8, 12).toString("latin1") === "WEBP"
  ) {
    return ".webp";
  }
  if (bytes.subarray(4, 8).toString("latin1") === "ftyp") {
    const brand = bytes.subarray(8, 12).toString("latin1");
    if (brand.startsWith("hei") || brand.startsWith("mif")) return ".heic";
    if (brand.startsWith("qt")) return ".mov";
    return ".mp4";
  }
  if (bytes.subarray(0, 2).toString("latin1") === "PK") return ".zip";
  return decodeUtf8Text(bytes) != null ? ".txt" : ".bin";
}

function decodeUtf8Text(bytes: Buffer): string | null {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    // eslint-disable-next-line no-control-regex
    if (!/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) return text;
  } catch {
    // not text
  }
  return null;
}

function validateQuickFile(
  rawName: unknown,
  rawBase64: unknown,
): Result<ParsedQuickFile | null> {
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
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length === 0) {
    return { ok: false, error: "file_base64 decoded to zero bytes" };
  }
  if (bytes.length > QUICK_FILE_MAX_BYTES) {
    return {
      ok: false,
      error: `file must be at most ${QUICK_FILE_MAX_BYTES} bytes decoded (got ${bytes.length})`,
    };
  }

  const named = splitExtension(safeName.value).ext
    ? safeName.value
    : safeName.value + sniffExtension(bytes);
  return {
    ok: true,
    value: { name: named, base64, asText: decodeUtf8Text(bytes) },
  };
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

  const parsedFile = validateQuickFile(record.file_name, record.file_base64);
  if (!parsedFile.ok) return parsedFile;

  if (!text && !parsedFile.value) {
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

  // A textual share (a .txt name, or an extension-less blob that sniffed as
  // text — how share sheets deliver links and selections) inlines into the
  // note body instead of becoming a .txt attachment embedded in an .md note.
  let title = "Quick note";
  let file: QuickFile | null = null;
  let fileText: string | null = null;
  let noteText = text;
  if (parsedFile.value) {
    const shared = parsedFile.value;
    title = splitExtension(shared.name).base;
    const inlined =
      shared.name.toLowerCase().endsWith(".txt") && shared.asText != null
        ? [text, shared.asText.trim()].filter(Boolean).join("\n\n")
        : "";
    if (inlined && inlined.length <= QUICK_NOTE_TEXT_MAX) {
      noteText = inlined;
    } else {
      file = { name: shared.name, base64: shared.base64 };
      fileText = shared.asText;
    }
  }

  return { ok: true, value: { text: noteText, source, title, file, fileText } };
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

  const note = await createVaultFileWithRetry(
    credentials,
    (attempt) => quickNotePath(stamp, attempt, input.title),
    buildQuickNoteDocument(input, stamp.created, attachment?.fileName),
    `Capture: ${input.title} (${input.source})`,
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
