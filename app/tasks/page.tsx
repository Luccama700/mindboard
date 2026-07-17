import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/utils/supabase/server";
import {
  CalendarListEntry,
  GoogleCalendarConnectionError,
  listCalendars,
} from "@/utils/google/calendar";
import { TasksClient, type TaskFilter } from "@/app/_components/tasks-client";
import type { Task } from "@/app/_components/types";
import { getActiveRecurringTasks } from "@/app/lib/data/recurring-tasks";
import { ownerUserId } from "@/app/lib/mcp/config";
import type { Group } from "./groups-types";
import { AgentRunButton } from "./agent-run-button";
import { GroupsClient } from "./groups-client";
import { RecurringClient } from "./recurring-client";

function parseFilter(value: string | string[] | undefined): TaskFilter {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return "all";
  if (raw === "inbox") return null;
  return raw;
}

export default async function TasksPage({
  searchParams,
}: {
  searchParams: Promise<{ group?: string | string[] | undefined }>;
}) {
  const query = await searchParams;
  const filter = parseFilter(query.group);

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const calendarsPromise = listCalendars(user.id).catch(
    (error): CalendarListEntry[] => {
      if (!(error instanceof GoogleCalendarConnectionError)) {
        console.error("listCalendars failed", error);
      }
      return [];
    },
  );

  let tasksQuery = supabase
    .from("tasks")
    .select(
      "id, title, due_date, due_time, duration_min, status, priority, ai_state, notes, group_id, gcal_event_id, gcal_calendar_id, created_at, completed_at",
    )
    // Soonest due date first; undated tasks sink to the bottom, newest-captured
    // first among ties/undated.
    .order("due_date", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: false });
  if (filter === null) {
    tasksQuery = tasksQuery.is("group_id", null);
  } else if (filter !== "all") {
    tasksQuery = tasksQuery.eq("group_id", filter);
  }

  const [{ data: tasks }, groupsResult, calendars, recurringRules] =
    await Promise.all([
      tasksQuery,
      supabase
        .from("groups")
        .select("id, name, type, color, archived, created_at, google_calendar_id")
        .eq("archived", false)
        .order("created_at", { ascending: false }),
      calendarsPromise,
      getActiveRecurringTasks(user.id),
    ]);

  const groups = (groupsResult.data ?? []) as Group[];
  const groupOptions = groups.map((g) => ({
    id: g.id,
    name: g.name,
    color: g.color,
  }));
  const activeGroup =
    filter !== "all" && filter !== null
      ? (groups.find((g) => g.id === filter) ?? null)
      : null;

  // "Run agent now" only renders for the owner: the PC's poll runs on the
  // owner's PAT alone, so for anyone else (worker allowlist included) the
  // "picks it up in ~5 min" promise would be false.
  let agentServiced = false;
  try {
    agentServiced = ownerUserId() === user.id;
  } catch {
    // env unset (e.g. local dev) — keep the button hidden
  }

  const chipBase =
    "inline-flex items-center gap-2 min-h-11 px-3 text-action lowercase border transition-colors whitespace-nowrap";
  const chipOn = "border-accent text-fg";
  const chipOff = "border-hairline text-muted hover:text-fg";

  return (
    <main className="min-h-screen px-5 pt-6 pb-64 max-w-2xl mx-auto">
      <header className="mb-6">
        <div className="flex items-center justify-between gap-3 mb-4">
          <h1 className="text-label uppercase text-muted">tasks</h1>
          {agentServiced && <AgentRunButton />}
        </div>
        <div className="flex gap-2 overflow-x-auto pb-1" data-tour="task-groups">
          <Link
            href="/tasks"
            className={`${chipBase} ${filter === "all" ? chipOn : chipOff}`}
          >
            all
          </Link>
          <Link
            href="/tasks?group=inbox"
            data-tour="task-inbox"
            className={`${chipBase} ${filter === null ? chipOn : chipOff}`}
          >
            <span
              className="h-2.5 w-2.5 border border-muted border-dashed"
              aria-hidden
            />
            inbox
          </Link>
          {groups.map((group) => (
            <Link
              key={group.id}
              href={`/tasks?group=${group.id}`}
              className={`${chipBase} ${filter === group.id ? chipOn : chipOff}`}
            >
              <span
                className="h-2.5 w-2.5"
                style={{ backgroundColor: group.color }}
                aria-hidden
              />
              {group.name}
            </Link>
          ))}
        </div>
        {activeGroup && (
          <p className="text-meta text-muted mt-2">
            {activeGroup.name} · {activeGroup.type}
          </p>
        )}
      </header>

      <TasksClient
        key={typeof filter === "string" ? filter : "inbox"}
        initial={(tasks ?? []) as Task[]}
        filter={filter}
        groups={groupOptions}
      />

      <details className="mt-12 border-t border-hairline pt-4">
        <summary className="text-label uppercase text-muted cursor-pointer min-h-11 flex items-center hover:text-fg transition-colors">
          repeating{recurringRules.length > 0 && ` · ${recurringRules.length}`}
        </summary>
        <div className="mt-4">
          <RecurringClient initial={recurringRules} groups={groupOptions} />
        </div>
      </details>

      <details
        className="mt-4 border-t border-hairline pt-4"
        data-tour="task-manage"
      >
        <summary className="text-label uppercase text-muted cursor-pointer min-h-11 flex items-center hover:text-fg transition-colors">
          manage groups
        </summary>
        <div className="mt-4">
          <GroupsClient initial={groups} calendars={calendars} />
        </div>
      </details>
    </main>
  );
}
