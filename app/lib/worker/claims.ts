// Claim guards for the home worker (audit 2026-10-26, C1 + M7). Pure logic,
// unit-tested in __tests__/worker-claims.test.ts.
//
// The invariant: NOTHING a client can write may reach the PC as-is. `jobs`
// RLS let any signed-in session insert or update its own row with any payload
// (0056 closes that; this layer holds either way), so /api/worker re-derives
// every value it hands out — a reel URL from the canonicalizer, a PDF path
// from the job's own account prefix — rather than forwarding `jobs.payload`.

import { extractInstagramUrl, type ReelRef } from "@/app/lib/reels/detect";
import { clip } from "@/app/lib/notes";
import { PRIORITIES, type Priority, type Result } from "@/app/lib/mcp/validate";

// A reel payload is honoured only when its url IS the canonicalizer's own
// output. extractInstagramUrl finds the first Instagram link anywhere in a
// string, so equality — not "contains a match" — is what rejects a forged
// `https://www.instagram.com/reel/abc/ & powershell -enc …`, which the worker
// used to splice into a shell command line verbatim.
export function canonicalReelRef(rawUrl: unknown): Result<ReelRef> {
  const url = typeof rawUrl === "string" ? rawUrl.trim() : "";
  if (!url) return { ok: false, error: "reel job carries no url" };
  const ref = extractInstagramUrl(url);
  if (!ref || ref.url !== url) {
    return { ok: false, error: "reel url is not a canonical instagram link" };
  }
  return { ok: true, value: ref };
}

// attachSourceFile writes `{user_id}/{source_id}/…` and checks that prefix,
// but `course_sources` RLS lets the same user PATCH storage_path afterwards —
// so an allowlisted tenant who knows another tenant's object path could have
// the service role sign a download for it. Re-check before signing.
export function storagePathBelongsTo(
  userId: string,
  sourceId: string,
  path: unknown,
): boolean {
  return typeof path === "string" && path.startsWith(`${userId}/${sourceId}/`);
}

// ---------- follow-ups ----------
//
// The PC's follow-up run is a research sandbox: web tools only, no MCP, no
// credential, and no ids it could write through. It reports a result; the
// SERVER makes the one write. So the claim carries only fields the server read
// off the task row (never jobs.payload's copy of them), and the result that
// comes back is validated here before any row is touched.

export const FOLLOWUP_TITLE_MAX = 200;
export const FOLLOWUP_NOTES_MAX = 8000;
export const FOLLOWUP_INSTRUCTION_MAX = 4000;

const FOLLOWUP_SOURCES = ["apple watch", "mindboard app"] as const;

export type FollowupTaskRow = {
  title: string;
  notes: string | null;
  priority: string | null;
  due_date: string | null;
  due_time: string | null;
};

export type FollowupContext = {
  title: string;
  notes: string;
  group_name: string | null;
  due_date: string | null;
  due_time: string | null;
  priority: string;
  instruction: string;
  source: string;
};

// Everything here except `instruction` and `source` comes from the task row
// the server just re-read; the payload only ever supplies the task id.
export function followupContext(
  task: FollowupTaskRow,
  groupName: string | null,
  payload: Record<string, unknown>,
): FollowupContext {
  const source = FOLLOWUP_SOURCES.find((s) => s === payload.source) ?? "mindboard app";
  const priority = PRIORITIES.find((p) => p === task.priority) ?? "med";
  return {
    title: clip(task.title, FOLLOWUP_TITLE_MAX),
    notes: clip(task.notes ?? "", FOLLOWUP_NOTES_MAX),
    group_name: groupName,
    due_date: task.due_date,
    due_time: task.due_time,
    priority,
    instruction: clip(
      typeof payload.instruction === "string" ? payload.instruction : "",
      FOLLOWUP_INSTRUCTION_MAX,
    ),
    source,
  };
}

export type FollowupOriginalUpdate = {
  title?: string;
  notes_append?: string;
  due_date?: string;
  priority?: Priority;
};

export type FollowupResult = {
  title: string;
  notes: string;
  original_update: FollowupOriginalUpdate | null;
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// Regex-shaped AND a real calendar day: "2026-02-31" passes the pattern and
// would land in a date column as something Postgres rejects mid-write.
function isCalendarDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day));
  return (
    utc.getUTCFullYear() === year &&
    utc.getUTCMonth() === month - 1 &&
    utc.getUTCDate() === day
  );
}

function optionalText(value: unknown, max: number): Result<string | undefined> {
  if (value == null) return { ok: true, value: undefined };
  if (typeof value !== "string") return { ok: false, error: "must be a string" };
  const trimmed = value.trim();
  return { ok: true, value: trimmed ? clip(trimmed, max) : undefined };
}

// The agent's `FOLLOWUP_RESULT:` line, forwarded by the worker. Shape and
// enumerations are strict (a bad priority or date fails the job and retries);
// free text is capped by truncation, since losing a tail is better than
// discarding a run that already cost money.
export function parseFollowupResult(raw: unknown): Result<FollowupResult> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "followup_result must be a JSON object" };
  }
  const body = raw as Record<string, unknown>;

  if (typeof body.title !== "string" || !body.title.trim()) {
    return { ok: false, error: "followup_result.title is required" };
  }
  if (body.notes != null && typeof body.notes !== "string") {
    return { ok: false, error: "followup_result.notes must be a string" };
  }

  let update: FollowupOriginalUpdate | null = null;
  const rawUpdate = body.original_update;
  if (rawUpdate != null) {
    if (typeof rawUpdate !== "object" || Array.isArray(rawUpdate)) {
      return { ok: false, error: "followup_result.original_update must be an object or null" };
    }
    const u = rawUpdate as Record<string, unknown>;

    const title = optionalText(u.title, FOLLOWUP_TITLE_MAX);
    if (!title.ok) return { ok: false, error: `original_update.title ${title.error}` };
    const notesAppend = optionalText(u.notes_append, FOLLOWUP_NOTES_MAX);
    if (!notesAppend.ok) {
      return { ok: false, error: `original_update.notes_append ${notesAppend.error}` };
    }

    let dueDate: string | undefined;
    if (u.due_date != null) {
      if (typeof u.due_date !== "string" || !isCalendarDate(u.due_date)) {
        return { ok: false, error: "original_update.due_date must be a real YYYY-MM-DD date" };
      }
      dueDate = u.due_date;
    }

    let priority: Priority | undefined;
    if (u.priority != null) {
      const candidate = PRIORITIES.find((p) => p === u.priority);
      if (!candidate) {
        return { ok: false, error: "original_update.priority must be low, med, or high" };
      }
      priority = candidate;
    }

    const fields = {
      ...(title.value ? { title: title.value } : {}),
      ...(notesAppend.value ? { notes_append: notesAppend.value } : {}),
      ...(dueDate ? { due_date: dueDate } : {}),
      ...(priority ? { priority } : {}),
    };
    update = Object.keys(fields).length > 0 ? fields : null;
  }

  return {
    ok: true,
    value: {
      title: clip(body.title.trim(), FOLLOWUP_TITLE_MAX),
      notes: clip(typeof body.notes === "string" ? body.notes.trim() : "", FOLLOWUP_NOTES_MAX),
      original_update: update,
    },
  };
}
