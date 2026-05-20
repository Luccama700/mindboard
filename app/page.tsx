import Link from "next/link";
import { createClient } from "@/utils/supabase/server";
import {
  GoogleCalendarConnectionError,
  listEvents,
  type CalendarEvent,
} from "@/utils/google/calendar";
import { DashboardCalendar } from "./_components/dashboard-calendar";
import { signOut } from "./actions/auth";
import { TodayClient } from "./_components/today-client";
import type { TaskWithGroup } from "./_components/types";

type RawTask = {
  id: string;
  title: string;
  due_date: string | null;
  status: "todo" | "doing" | "done";
  priority: "low" | "med" | "high";
  group_id: string | null;
  created_at: string;
  completed_at: string | null;
  groups: { name: string; color: string } | { name: string; color: string }[] | null;
};

function toDateKey(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function currentMonth() {
  const today = new Date();
  const month = String(today.getMonth() + 1).padStart(2, "0");
  return `${today.getFullYear()}-${month}`;
}

function normalizeMonth(value: string | string[] | undefined) {
  const month = Array.isArray(value) ? value[0] : value;
  if (!month || !/^\d{4}-\d{2}$/.test(month)) return currentMonth();

  const [year, monthNumber] = month.split("-").map(Number);
  if (monthNumber < 1 || monthNumber > 12) return currentMonth();
  if (year < 1970 || year > 2100) return currentMonth();

  return month;
}

function calendarRange(month: string) {
  const [year, monthNumber] = month.split("-").map(Number);
  const first = new Date(year, monthNumber - 1, 1);
  const start = new Date(first);
  start.setDate(first.getDate() - first.getDay());

  const end = new Date(start);
  end.setDate(start.getDate() + 42);

  return {
    startDate: toDateKey(start),
    endDate: toDateKey(end),
    timeMin: start.toISOString(),
    timeMax: end.toISOString(),
  };
}

function mapTasks(rawTasks: RawTask[]): TaskWithGroup[] {
  return rawTasks.map((row) => {
    const groupRecord = Array.isArray(row.groups)
      ? (row.groups[0] ?? null)
      : (row.groups ?? null);
    return {
      id: row.id,
      title: row.title,
      due_date: row.due_date,
      status: row.status,
      priority: row.priority,
      group_id: row.group_id,
      created_at: row.created_at,
      completed_at: row.completed_at,
      group_name: groupRecord?.name ?? null,
      group_color: groupRecord?.color ?? null,
    };
  });
}

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ m?: string | string[] | undefined }>;
}) {
  const query = await searchParams;
  const calendarMonth = normalizeMonth(query.m);
  const { startDate, endDate, timeMin, timeMax } =
    calendarRange(calendarMonth);

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return (
      <main className="min-h-screen flex flex-col items-center justify-center px-6">
        <div className="max-w-sm w-full space-y-8">
          <div>
            <p className="text-[#6b6b6b] text-xs tracking-widest uppercase mb-3">
              personal dashboard
            </p>
            <h1 className="text-4xl font-bold tracking-tight text-[#f5f0e8]">
              mindboard
            </h1>
          </div>

          <p className="text-[#6b6b6b] text-sm leading-relaxed">
            Track what matters. Ship what ships.
          </p>

          <div className="pt-4">
            <Link
              href="/login"
              className="inline-block bg-[#b5ff3c] text-[#0d0d0d] text-sm font-bold px-6 py-3 hover:bg-[#f5f0e8] transition-colors"
            >
              get started →
            </Link>
          </div>
        </div>
      </main>
    );
  }

  const [{ data: rawTasks }, { data: groupRows }] = await Promise.all([
    supabase
      .from("tasks")
      .select(
        "id, title, due_date, status, priority, group_id, created_at, completed_at, groups(name, color)",
      )
      .neq("status", "done")
      .not("due_date", "is", null),
    supabase
      .from("groups")
      .select("id, name, color, google_calendar_id")
      .eq("archived", false)
      .order("created_at", { ascending: false }),
  ]);

  const tasks = mapTasks((rawTasks ?? []) as RawTask[]);
  const groupsRaw = (groupRows ?? []) as {
    id: string;
    name: string;
    color: string;
    google_calendar_id: string | null;
  }[];
  const groups = groupsRaw.map((g) => ({
    id: g.id,
    name: g.name,
    color: g.color,
  }));

  const calendarLinks: Record<
    string,
    { groupId: string; groupName: string; groupColor: string }
  > = {};
  for (const g of groupsRaw) {
    if (g.google_calendar_id) {
      calendarLinks[g.google_calendar_id] = {
        groupId: g.id,
        groupName: g.name,
        groupColor: g.color,
      };
    }
  }
  const calendarTasks = tasks.filter(
    (task) =>
      task.due_date && task.due_date >= startDate && task.due_date < endDate,
  );

  let calendarEvents: CalendarEvent[] = [];
  let calendarStatus: "connected" | "connect" | "error" = "connect";

  try {
    calendarEvents = await listEvents(user.id, { timeMin, timeMax });
    calendarStatus = "connected";
  } catch (error) {
    calendarStatus =
      error instanceof GoogleCalendarConnectionError ? "connect" : "error";
  }

  const todayLabel = new Date().toLocaleDateString(undefined, {
    weekday: "long",
    month: "short",
    day: "numeric",
  });

  return (
    <main className="min-h-screen px-5 pt-8 pb-56 lg:px-12">
      <div className="grid gap-8 lg:grid-cols-2 lg:gap-24 lg:items-start">
        <section className="min-w-0">
          <header className="flex items-start justify-between mb-8">
            <div>
              <p className="text-[10px] tracking-widest uppercase text-[#6b6b6b]">
                {todayLabel}
              </p>
              <h1 className="text-3xl font-bold tracking-tight text-[#f5f0e8] mt-1">
                today
              </h1>
            </div>
            <div className="flex flex-col items-end gap-3 pt-1">
              <Link
                href="/groups"
                className="text-xs tracking-widest uppercase px-3 py-2 border border-[#f5f0e8] text-[#f5f0e8] hover:bg-[#f5f0e8] hover:text-[#0d0d0d] transition-colors"
              >
                groups →
              </Link>
              <form action={signOut}>
                <button
                  type="submit"
                  className="text-[10px] tracking-widest uppercase text-[#6b6b6b] hover:text-[#f5f0e8] transition-colors"
                >
                  sign out
                </button>
              </form>
            </div>
          </header>

          <TodayClient
            initial={tasks}
            groups={groups}
            events={calendarEvents}
            calendarLinks={calendarLinks}
          />
        </section>

        <aside className="min-w-0 lg:sticky lg:top-8">
          <DashboardCalendar
            key={calendarMonth}
            month={calendarMonth}
            tasks={calendarTasks}
            events={calendarEvents}
            status={calendarStatus}
            calendarLinks={calendarLinks}
          />
        </aside>
      </div>
    </main>
  );
}
