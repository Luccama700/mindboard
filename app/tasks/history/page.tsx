import Link from "next/link";
import { redirect } from "next/navigation";

import { createClient } from "@/utils/supabase/server";
import { TASK_COLUMNS } from "@/app/_components/types";
import { safeTimeZone, todayISO } from "@/app/_components/date-utils";
import { getUserPreferences } from "@/app/lib/data/settings";
import { historyRollup, type HistoryRow } from "@/app/lib/snapshots/history";
import { zonedWallTimeToUtcMs } from "@/app/lib/snapshots/zoned-time";
import { HistoryClient } from "./history-client";

const MONTHS = [
  "jan", "feb", "mar", "apr", "may", "jun",
  "jul", "aug", "sep", "oct", "nov", "dec",
];

function shiftKey(key: string, days: number): string {
  const [y, m, d] = key.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

function weekLabel(key: string): string {
  const [, m, d] = key.split("-").map(Number);
  return `${MONTHS[m - 1]} ${d}`;
}

type TaskHistoryRow = {
  id: string;
  title: string;
  status: HistoryRow["status"];
  completed_at: string | null;
  missed_at: string | null;
  groups: { name: string; color: string } | { name: string; color: string }[] | null;
};

export default async function TasksHistoryPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const prefs = await getUserPreferences(user.id);
  const timeZone = safeTimeZone(prefs.timezone);
  const today = todayISO(timeZone);
  // ~28-day window, anchored to local midnight of the window's first day.
  const cutoffMs = zonedWallTimeToUtcMs(shiftKey(today, -28), 0, 0, timeZone);
  const cutoffIso = new Date(cutoffMs).toISOString();

  const { data } = await supabase
    .from("tasks")
    .select(`${TASK_COLUMNS}, groups(name, color)`)
    .in("status", ["done", "missed"])
    .or(`completed_at.gte.${cutoffIso},missed_at.gte.${cutoffIso}`)
    .order("created_at", { ascending: false });

  const rows: HistoryRow[] = ((data ?? []) as TaskHistoryRow[]).map((t) => {
    const group = Array.isArray(t.groups) ? (t.groups[0] ?? null) : t.groups;
    return {
      id: t.id,
      title: t.title,
      status: t.status,
      completed_at: t.completed_at,
      missed_at: t.missed_at,
      group_name: group?.name ?? null,
      group_color: group?.color ?? null,
    };
  });

  const { weeks, days } = historyRollup(rows, today, timeZone);

  return (
    <main className="min-h-screen px-5 pt-6 pb-64 max-w-2xl mx-auto">
      <header className="mb-6">
        <Link
          href="/tasks"
          className="text-[10px] tracking-widest uppercase text-muted hover:text-fg transition-colors"
        >
          ← tasks
        </Link>
        <h1 className="text-label uppercase text-muted mt-3">history</h1>
      </header>

      <div className="space-y-1 mb-8">
        {weeks.map((w, i) => (
          <p key={w.startKey} className="text-xs tracking-wide text-muted">
            {i === 0 ? "this week" : `wk ${weekLabel(w.startKey)}`}
            <span className="text-line-subtle"> · </span>
            <span className="text-accent">{w.done} done</span>
            <span className="text-line-subtle"> · </span>
            <span className="text-danger">{w.missed} missed</span>
          </p>
        ))}
      </div>

      <HistoryClient days={days} timeZone={timeZone} />
    </main>
  );
}
