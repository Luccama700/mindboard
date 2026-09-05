import { zonedClock } from "@/app/lib/snapshots/zoned-time";

// The timeZone argument is REQUIRED on purpose: the process clock is UTC on
// Vercel, so an omitted zone silently produced the wrong day for every
// server-side caller. Pass an explicit `null` to mean "process clock,
// deliberately" — correct in client components, where the process clock IS the
// browser. On the server, resolve the user's stored zone first: `safeTimeZone`
// (below) or `todayKey(supabase, userId)` (app/lib/mcp/config.ts) are the only
// blessed resolvers.
export function todayISO(timeZone: string | null) {
  const d = new Date();
  if (timeZone) {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(d);
  }
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// The stored timezone is free text; a typo would make every Intl call throw.
// Null means "fall back to the process clock".
export function safeTimeZone(timeZone: string | null | undefined): string | null {
  if (!timeZone) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return timeZone;
  } catch {
    return null;
  }
}

// timeZone is required for the same reason todayISO's is — a wall-clock label
// rendered from a Server Component would otherwise silently read UTC.
export function formatClock12(date: Date, timeZone: string | null) {
  return date
    .toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZone: timeZone ?? undefined,
    })
    .toLowerCase()
    .replace(" ", "");
}

// `today` is required for the same reason todayISO's zone is: this label sits
// beside — and on the task chips, ON — controls that WRITE due_date, so the day
// it calls "today" has to be the day the server will classify against. Callers
// take it as a prop from their page; none of them may re-derive it.
export function formatDue(iso: string, today: string) {
  if (iso === today) return "today";
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

// "HH:MM" of an instant in the user's zone. Required for the same reason as
// todayISO's: the calendar's event labels must agree with the grid position,
// which is computed in the stored zone, not the device's.
export function formatClockTime(value: string, timeZone: string | null) {
  return zonedClock(Date.parse(value), timeZone);
}

export function formatHourLabel(hour: number) {
  return new Date(2000, 0, 1, hour).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    hourCycle: "h23",
  });
}

export function formatMonthYear(date: Date) {
  return date.toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  });
}

export function formatMonthDay(date: Date, includeMonth = true) {
  return date.toLocaleDateString("en-US", {
    month: includeMonth ? "short" : undefined,
    day: "numeric",
  });
}

export function formatWeekdayMonthDay(date: Date) {
  return date.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

export function formatLongWeekdayMonthDay(date: Date, timeZone: string | null) {
  return date.toLocaleDateString("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
    timeZone: timeZone ?? undefined,
  });
}

// "now", "in 45m", "in 2.5h", or "in 3d" relative to the current time.
export function formatRelativeToNow(iso: string): string {
  const diffMs = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(diffMs) || diffMs <= 0) return "now";
  const minutes = Math.round(diffMs / 60_000);
  if (minutes < 60) return `in ${minutes}m`;
  if (minutes < 24 * 60) return `in ${Math.round((minutes / 60) * 10) / 10}h`;
  return `in ${Math.round(minutes / (60 * 24))}d`;
}

const PRIORITY_RANK: Record<string, number> = { high: 0, med: 1, low: 2 };

export function priorityRank(p: string): number {
  return PRIORITY_RANK[p] ?? 1;
}
