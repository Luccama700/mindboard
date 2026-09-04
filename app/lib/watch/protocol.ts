// Pure protocol helpers for the Apple Watch API (/api/watch/*): bearer-token
// map parsing + constant-time resolution, Idempotency-Key reading, request
// body validation, and the capture title derivation. No server imports
// (mirrors app/lib/mcp/validate.ts) so it unit-tests directly.

import { createHash, timingSafeEqual } from "node:crypto";

import type { Result } from "@/app/lib/mcp/validate";
import { CAPTURE_SUMMARY_MAX, CAPTURE_TITLE_MAX } from "@/app/lib/mcp/capture";

export const WATCH_CAPTURE_SOURCE = "apple watch";
export const IDEMPOTENCY_KEY_MAX = 200;
export const WATCH_TITLE_MAX = 500;

export type WatchTokenMap = ReadonlyMap<string, string>;

// WATCH_TOKEN is either one opaque secret — mapped to the deployment owner,
// like the legacy static MCP token — or a JSON object {token: supabaseUserId}
// so a second tenant carries their own token. Malformed JSON yields an empty
// map (every request 401s) rather than silently mapping to the owner.
export function parseWatchTokenMap(
  raw: string | undefined,
  ownerId: string | undefined,
): WatchTokenMap {
  const map = new Map<string, string>();
  const value = raw?.trim();
  if (!value) return map;
  if (value.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      return map;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return map;
    for (const [token, userId] of Object.entries(parsed as Record<string, unknown>)) {
      if (token && typeof userId === "string" && userId.trim()) {
        map.set(token, userId.trim());
      }
    }
    return map;
  }
  if (ownerId) map.set(value, ownerId);
  return map;
}

export function resolveWatchUserId(
  authorization: string | null,
  tokens: WatchTokenMap,
): string | null {
  const bearer = authorization?.startsWith("Bearer ")
    ? authorization.slice(7).trim()
    : "";
  if (!bearer) return null;
  const presented = Buffer.from(bearer);
  for (const [token, userId] of tokens) {
    const expected = Buffer.from(token);
    if (expected.length === presented.length && timingSafeEqual(expected, presented)) {
      return userId;
    }
  }
  return null;
}

// An over-long or blank key is treated as absent rather than rejected: the
// write still happens, it just isn't deduplicated.
export function readIdempotencyKey(header: string | null): string | null {
  const key = header?.trim() ?? "";
  if (!key || key.length > IDEMPOTENCY_KEY_MAX) return null;
  return key;
}

// Deterministic ai_audit_log id for (user, tool, key): a retried request
// collides on the primary key instead of recording a second proposal, which is
// what makes the writes idempotent without a new table. Formatted as a v5-style
// UUID from a SHA-256 so Postgres accepts it as a uuid.
export function idempotentProposalId(
  userId: string,
  toolName: string,
  key: string,
): string {
  const digest = createHash("sha256")
    .update(`${userId}\n${toolName}\n${key}`, "utf8")
    .digest();
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export type WatchCompleteInput = { type: "task" | "recurring"; id: string };

export function validateComplete(raw: unknown): Result<WatchCompleteInput> {
  const body = (raw ?? {}) as { type?: unknown; id?: unknown };
  if (body.type !== "task" && body.type !== "recurring") {
    return { ok: false, error: 'type must be "task" or "recurring"' };
  }
  if (typeof body.id !== "string" || !body.id.trim()) {
    return { ok: false, error: "id is required" };
  }
  return { ok: true, value: { type: body.type, id: body.id.trim() } };
}

export function validateTaskTitle(raw: unknown): Result<{ title: string }> {
  const body = (raw ?? {}) as { title?: unknown };
  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!title) return { ok: false, error: "title is required" };
  if (title.length > WATCH_TITLE_MAX) {
    return { ok: false, error: `title must be at most ${WATCH_TITLE_MAX} characters` };
  }
  return { ok: true, value: { title } };
}

export function validateSpend(
  raw: unknown,
): Result<{ amount: number; note: string | null }> {
  const body = (raw ?? {}) as { amount?: unknown; note?: unknown };
  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, error: "amount must be a positive number" };
  }
  if (body.note != null && typeof body.note !== "string") {
    return { ok: false, error: "note must be a string" };
  }
  const note = typeof body.note === "string" ? body.note.trim() || null : null;
  return { ok: true, value: { amount: Math.round(amount * 100) / 100, note } };
}

export function validateCaptureText(raw: unknown): Result<{ text: string }> {
  const body = (raw ?? {}) as { text?: unknown };
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) return { ok: false, error: "text is required" };
  if (text.length > CAPTURE_SUMMARY_MAX) {
    return { ok: false, error: `text must be at most ${CAPTURE_SUMMARY_MAX} characters` };
  }
  return { ok: true, value: { text } };
}

// The capture's note title is its first line, cut at a word boundary to fit
// capture_to_brain's title limit; the full text stays in the body.
export function captureTitleFromText(text: string): string {
  const firstLine = text.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "";
  if (firstLine.length <= CAPTURE_TITLE_MAX) return firstLine;
  const cut = firstLine.slice(0, CAPTURE_TITLE_MAX - 1);
  const atWord = cut.lastIndexOf(" ");
  return `${(atWord > CAPTURE_TITLE_MAX / 2 ? cut.slice(0, atWord) : cut).trim()}…`;
}
