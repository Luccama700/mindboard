// Pure helpers for the home-app integration (taiga-home: Taiga feedings +
// household chores). No I/O here so it can be unit tested; the home app itself
// buckets everything in America/Vancouver, so these do too.

import type { Result } from "@/app/lib/mcp/validate";

export const HOME_TZ = "America/Vancouver";

export type HomeMember = {
  id: string;
  name: string;
  email: string;
  role: "resident" | "guest";
  sort_order: number;
  in_rotation: boolean;
};

export type HomeChore = {
  id: string;
  name: string;
  frequency: "daily" | "weekly" | "interval";
  interval_days: number;
  assigned_to: string | null;
  assignees: string[] | null;
  due_date: string;
};

export type ChoreRow = Omit<HomeChore, "id">;

const partsFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: HOME_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function vanParts(d: Date) {
  const p = Object.fromEntries(partsFmt.formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
}

export function vanToday(now: Date = new Date()): string {
  return vanParts(now).date;
}

export function vanTime(iso: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: HOME_TZ, hour: "numeric", minute: "2-digit" }).format(
    new Date(iso),
  );
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  const pad = (x: number) => String(x).padStart(2, "0");
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

export function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
}

function toMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

/** Same rule as the home app: morning until halfway between the two feeding times. */
export function feedingSlot(now: Date, morning: string, evening: string): "morning" | "evening" {
  const cutoff = (toMinutes(morning) + toMinutes(evening)) / 2;
  return vanParts(now).minutes < cutoff ? "morning" : "evening";
}

export function stepDays(c: Pick<HomeChore, "frequency" | "interval_days">): number {
  return c.frequency === "daily" ? 1 : c.frequency === "weekly" ? 7 : c.interval_days;
}

export function frequencyLabel(c: Pick<HomeChore, "frequency" | "interval_days">): string {
  if (c.frequency === "daily") return "daily";
  if (c.frequency === "weekly") return "weekly";
  return `every ${c.interval_days} days`;
}

/** Who takes turns on a chore, in order: its own assignees, else the default rotation. */
export function rotationFor(c: Pick<HomeChore, "assignees">, members: HomeMember[]): HomeMember[] {
  const sorted = [...members].sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name));
  const own = c.assignees?.length ? sorted.filter((m) => c.assignees!.includes(m.id)) : [];
  return own.length ? own : sorted.filter((m) => m.in_rotation);
}

/** Mirrors complete_chore_as: next after the doer if they're in the rotation, else after whoever was up. */
export function nextUpAfter(c: HomeChore, members: HomeMember[], actorId: string): HomeMember | null {
  const rot = rotationFor(c, members);
  if (!rot.length) return members.find((m) => m.id === c.assigned_to) ?? null;
  const base = rot.some((m) => m.id === actorId) ? actorId : c.assigned_to;
  const idx = rot.findIndex((m) => m.id === base);
  return idx < 0 ? rot[0] : rot[(idx + 1) % rot.length];
}

export function describeChore(c: HomeChore, members: HomeMember[], today: string) {
  const byId = (id: string | null) => members.find((m) => m.id === id)?.name ?? null;
  const diff = daysBetween(today, c.due_date);
  const own = c.assignees?.length ? rotationFor(c, members).map((m) => m.name) : null;
  return {
    id: c.id,
    name: c.name,
    frequency: frequencyLabel(c),
    upNext: byId(c.assigned_to),
    whoDoesIt: own ? (own.length === 1 ? `${own[0]} only` : own.join(" & ")) : "default rotation",
    rotation: rotationFor(c, members).map((m) => m.name),
    dueDate: c.due_date,
    status: diff < 0 ? `overdue by ${-diff} day${diff === -1 ? "" : "s"}` : diff === 0 ? "due today" : `due in ${diff} day${diff === 1 ? "" : "s"}`,
  };
}

/** Case-insensitive member names → ids (in rotation order). */
export function resolveNames(names: string[], members: HomeMember[]): Result<string[]> {
  const ids: string[] = [];
  for (const raw of names) {
    const m = members.find((x) => x.name.toLowerCase() === raw.trim().toLowerCase());
    if (!m) return { ok: false, error: `unknown member "${raw}" (members: ${members.map((x) => x.name).join(", ")})` };
    if (!ids.includes(m.id)) ids.push(m.id);
  }
  if (!ids.length) return { ok: true, value: [] };
  return { ok: true, value: rotationFor({ assignees: ids }, members).map((m) => m.id) };
}

export type ChoreUpsertInput = {
  choreId?: string;
  name?: string;
  frequency?: "daily" | "weekly" | "interval";
  intervalDays?: number;
  assignees?: string[];
  upNext?: string;
  dueDate?: string;
};

/**
 * Merge an upsert request onto the existing chore (if any) into the exact row to write.
 * Omitted fields keep their current value; assignees: [] means "use the default rotation".
 */
export function buildChoreRow(
  input: ChoreUpsertInput,
  existing: HomeChore | null,
  members: HomeMember[],
  today: string,
): Result<ChoreRow> {
  const name = (input.name ?? existing?.name ?? "").trim();
  if (!name) return { ok: false, error: "name is required for a new chore" };
  const frequency = input.frequency ?? existing?.frequency ?? "weekly";
  if (input.intervalDays !== undefined && frequency !== "interval") {
    return { ok: false, error: "intervalDays only applies when frequency is 'interval'" };
  }
  const switchingToInterval = frequency === "interval" && existing?.frequency !== "interval";
  const interval =
    frequency === "daily"
      ? 1
      : frequency === "weekly"
        ? 7
        : (input.intervalDays ?? (switchingToInterval ? 0 : (existing?.interval_days ?? 0)));
  if (!Number.isInteger(interval) || interval < 1 || interval > 365) {
    return { ok: false, error: "intervalDays (1-365) is required when frequency is 'interval'" };
  }

  let assignees = existing?.assignees ?? null;
  if (input.assignees) {
    const r = resolveNames(input.assignees, members);
    if (!r.ok) return r;
    assignees = r.value.length ? r.value : null;
  }

  const rot = rotationFor({ assignees }, members);
  let assignedTo = existing?.assigned_to ?? null;
  if (input.upNext) {
    const r = resolveNames([input.upNext], members);
    if (!r.ok) return r;
    assignedTo = r.value[0];
  }
  // Only re-pick who's up when this request touches who does it (or there's nobody up);
  // a rename-only edit must not quietly change whose turn it is.
  const touchesPeople = !existing || input.assignees !== undefined || input.upNext !== undefined || !assignedTo;
  if (touchesPeople && rot.length && !rot.some((m) => m.id === assignedTo)) assignedTo = rot[0].id;

  const dueDate = input.dueDate ?? existing?.due_date ?? today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) return { ok: false, error: "dueDate must be YYYY-MM-DD" };

  return {
    ok: true,
    value: { name, frequency, interval_days: interval, assigned_to: assignedTo, assignees, due_date: dueDate },
  };
}

export function summarizeChoreRow(row: ChoreRow, members: HomeMember[], isNew: boolean): string {
  const who = row.assignees?.length
    ? rotationFor({ assignees: row.assignees }, members).map((m) => m.name).join(" & ")
    : "the default rotation";
  const up = members.find((m) => m.id === row.assigned_to)?.name ?? "nobody";
  return `${isNew ? "Add" : "Update"} home chore "${row.name}": ${frequencyLabel(row)}, done by ${who}, ${up} up next, due ${row.due_date}.`;
}
