export function todayISO(timeZone?: string | null) {
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

export function formatClock12(date: Date, timeZone?: string | null) {
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

export function formatDue(iso: string) {
  if (iso === todayISO()) return "today";
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

export function formatLongWeekdayMonthDay(date: Date, timeZone?: string | null) {
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

// Negative = overdue, 0 = today, positive = future.
export function daysFromToday(iso: string): number {
  const today = new Date(todayISO() + "T00:00:00");
  const date = new Date(iso + "T00:00:00");
  const diffMs = date.getTime() - today.getTime();
  return Math.round(diffMs / (1000 * 60 * 60 * 24));
}

const PRIORITY_RANK: Record<string, number> = { high: 0, med: 1, low: 2 };

export function priorityRank(p: string): number {
  return PRIORITY_RANK[p] ?? 1;
}
