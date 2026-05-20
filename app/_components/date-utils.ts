export function todayISO() {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
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

export function formatLongWeekdayMonthDay(date: Date) {
  return date.toLocaleDateString("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
  });
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
