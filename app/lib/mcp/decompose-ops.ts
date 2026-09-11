// Pure half of decompose_task: validate a proposed set of children against
// their parent's window, and render the receipt the user confirms. No
// fetching, no clock — `today` and the parent are inputs — so it unit-tests
// directly, like the other *-ops modules.
//
// A decomposition is opt-in and depth one: the parent keeps its due_date and
// estimate; each child gets its own title, minutes, energy cost (1..5) and a
// window [notBefore, dueDate] inside [today, parent.dueDate]. Windows the
// model overshoots by a day are CLAMPED rather than rejected — a whole batch
// should not die because one edge landed on the wrong side of a boundary —
// but a window that is empty after clamping, or a child outside the count
// bounds, is an error the caller phrases.

import type { Result } from "./validate";

export const MIN_CHILDREN = 2;
export const MAX_CHILDREN = 6;
export const CHILD_TITLE_MAX = 200;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export type ProposedChild = {
  title: string;
  estimatedMinutes: number;
  energyCost: number;
  notBefore: string;
  dueDate: string;
};

export type DecompositionParent = {
  id: string;
  title: string;
  dueDate: string; // the window end every child must respect
};

// Strict: a real integer, never a coerced boolean/string or a truncated
// fraction — the receipt must show exactly what the model (or client) said.
function positiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

// YYYY-MM-DD that names a day that exists (no 2026-02-30).
export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_DATE.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return (
    date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d
  );
}

export function validateDecomposition(
  raw: unknown,
  parent: DecompositionParent,
  today: string,
): Result<ProposedChild[]> {
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { children?: unknown })?.children)
      ? ((raw as { children: unknown[] }).children)
      : null;
  if (!list) return { ok: false, error: "children must be an array" };
  if (list.length < MIN_CHILDREN || list.length > MAX_CHILDREN) {
    return {
      ok: false,
      error: `a breakdown has ${MIN_CHILDREN} to ${MAX_CHILDREN} steps (got ${list.length})`,
    };
  }
  if (parent.dueDate < today) {
    return { ok: false, error: "the parent's due date has already passed" };
  }

  const out: ProposedChild[] = [];
  for (let i = 0; i < list.length; i++) {
    const c = (list[i] ?? {}) as Record<string, unknown>;
    const n = i + 1;
    const title = typeof c.title === "string" ? c.title.trim() : "";
    if (!title) return { ok: false, error: `step ${n}: title is required` };
    if (title.length > CHILD_TITLE_MAX) {
      return { ok: false, error: `step ${n}: title is too long` };
    }
    const estimatedMinutes = positiveInt(c.estimatedMinutes);
    if (estimatedMinutes === null) {
      return { ok: false, error: `step ${n}: estimatedMinutes must be a positive whole number` };
    }
    const energyCost = positiveInt(c.energyCost);
    if (energyCost === null || energyCost > 5) {
      return { ok: false, error: `step ${n}: energyCost must be 1-5` };
    }
    for (const key of ["notBefore", "dueDate"] as const) {
      if (!isCalendarDate(c[key])) {
        return { ok: false, error: `step ${n}: ${key} must be a real YYYY-MM-DD date` };
      }
    }
    // Clamp an edge that overshoots into the parent's window; a window that
    // lies wholly outside it (starts after the deadline, or ended before
    // today) is a real error, not an edge.
    const rawNotBefore = c.notBefore as string;
    const rawDueDate = c.dueDate as string;
    if (rawNotBefore > parent.dueDate || rawDueDate < today || rawNotBefore > rawDueDate) {
      return {
        ok: false,
        error: `step ${n}: window ${rawNotBefore}…${rawDueDate} does not fit between ${today} and ${parent.dueDate}`,
      };
    }
    const notBefore = clamp(rawNotBefore, today, parent.dueDate);
    const dueDate = clamp(rawDueDate, today, parent.dueDate);
    out.push({ title, estimatedMinutes, energyCost, notBefore, dueDate });
  }
  return { ok: true, value: out };
}

function clamp(value: string, lo: string, hi: string): string {
  if (value < lo) return lo;
  if (value > hi) return hi;
  return value;
}

function shortDate(key: string): string {
  const [, m, d] = key.split("-").map(Number);
  const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  return `${months[m - 1]} ${d}`;
}

function minutesLabel(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const h = Math.round((minutes / 60) * 10) / 10;
  return `${Number.isInteger(h) ? h : h.toFixed(1)}h`;
}

// One line per child: "1. Pull three quotes · 20m · energy 2 · sep 15–18".
export function renderDecompositionReceipt(
  parent: DecompositionParent,
  children: ProposedChild[],
): string {
  const lines = children.map((c, i) => {
    // "sep 15–18" inside a month, "sep 28–oct 2" across one.
    const sameMonth = c.notBefore.slice(0, 7) === c.dueDate.slice(0, 7);
    const window =
      c.notBefore === c.dueDate
        ? shortDate(c.dueDate)
        : sameMonth
          ? `${shortDate(c.notBefore)}–${Number(c.dueDate.slice(8, 10))}`
          : `${shortDate(c.notBefore)}–${shortDate(c.dueDate)}`;
    return `${i + 1}. ${c.title} · ${minutesLabel(c.estimatedMinutes)} · energy ${c.energyCost} · ${window}`;
  });
  const total = children.reduce((s, c) => s + c.estimatedMinutes, 0);
  return [
    `Break "${parent.title}" (due ${parent.dueDate}) into ${children.length} steps:`,
    ...lines,
    `≈ ${minutesLabel(total)} in total. The steps land in your stream on their planned days; "${parent.title}" stays as the thing owed and shows progress.`,
  ].join("\n");
}
