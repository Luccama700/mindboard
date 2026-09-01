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

export function formatClockTime(value: string) {
  return new Date(value).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
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

// End of a timed block: start clock + duration, rolling past midnight into the
// next day instead of clamping at 23:59 (a 23:30 block with 60min used to
// silently truncate to 23:59). Pure calendar-key math, zone-agnostic — the
// caller pairs the result with an explicit timeZone when building event stamps.
export function endOfBlock(
  dateKey: string,
  time: string,
  minutes: number,
): { date: string; time: string } {
  const [h, m] = time.split(":").map(Number);
  const total = h * 60 + m + minutes;
  const dayOffset = Math.floor(total / 1440);
  const clock = total % 1440;
  const hh = String(Math.floor(clock / 60)).padStart(2, "0");
  const mm = String(clock % 60).padStart(2, "0");
  let date = dateKey;
  if (dayOffset > 0) {
    const [y, mo, d] = dateKey.split("-").map(Number);
    const next = new Date(Date.UTC(y, mo - 1, d + dayOffset));
    date = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}-${String(next.getUTCDate()).padStart(2, "0")}`;
  }
  return { date, time: `${hh}:${mm}:00` };
}

const PRIORITY_RANK: Record<string, number> = { high: 0, med: 1, low: 2 };

export function priorityRank(p: string): number {
  return PRIORITY_RANK[p] ?? 1;
}
