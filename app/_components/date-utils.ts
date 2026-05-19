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
  return d.toLocaleDateString(undefined, {
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
