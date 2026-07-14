// Pure logic for the public /api/capture endpoint (Siri voice quick-notes):
// static-bearer auth compare, payload validation, the fixed "Quick note"
// filename, and the frontmatter document. The vault write itself reuses
// capture_to_brain's create-only Inbox/ writer (createVaultFileWithRetry), so
// this path inherits its invariants: never update, never delete, Inbox/ only.
// No server imports (mirrors capture.ts) so it unit-tests directly.

import { timingSafeEqual } from "node:crypto";

import type { Result } from "./validate";
import {
  createVaultFileWithRetry,
  vancouverStamp,
  yamlQuote,
  type CaptureStamp,
  type VaultWriteCredentials,
} from "./capture";

export const QUICK_NOTE_TEXT_MAX = 20_000;
export const QUICK_NOTE_SOURCE_MAX = 200;
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
// Shortcut, so a whole-endpoint cap is the right shape. Per-instance and
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

export type QuickNoteInput = { text: string; source: string };

export function validateQuickNote(raw: unknown): Result<QuickNoteInput> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "body must be a JSON object" };
  }
  const record = raw as Record<string, unknown>;

  if (record.text != null && typeof record.text !== "string") {
    return { ok: false, error: "text must be a string" };
  }
  const text = typeof record.text === "string" ? record.text.trim() : "";
  if (!text) return { ok: false, error: "text is required" };
  if (text.length > QUICK_NOTE_TEXT_MAX) {
    return {
      ok: false,
      error: `text must be at most ${QUICK_NOTE_TEXT_MAX} characters (got ${text.length})`,
    };
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

  return { ok: true, value: { text, source } };
}

export function quickNotePath(stamp: CaptureStamp, attempt: number): string {
  const suffix = attempt > 1 ? ` -${attempt}` : "";
  return `Inbox/${stamp.dateKey} ${stamp.timeKey} Quick note${suffix}.md`;
}

export function buildQuickNoteDocument(
  input: QuickNoteInput,
  created: string,
): string {
  // topics stays an explicit empty list (capture_to_brain omits it when empty):
  // a quick note never arrives pre-tagged, and the empty slot is the reviewer's
  // cue to file it during the vault's distill pass.
  return [
    "---",
    "type: capture",
    `created: ${created}`,
    `source: ${yamlQuote(input.source)}`,
    "topics: []",
    "---",
    "",
    input.text,
    "",
  ].join("\n");
}

export async function createQuickNote(
  credentials: VaultWriteCredentials,
  input: QuickNoteInput,
  now: Date,
  fetchImpl: typeof fetch = fetch,
): Promise<Result<{ path: string }>> {
  const stamp = vancouverStamp(now);
  return createVaultFileWithRetry(
    credentials,
    (attempt) => quickNotePath(stamp, attempt),
    buildQuickNoteDocument(input, stamp.created),
    `Capture: Quick note (${input.source})`,
    fetchImpl,
  );
}
