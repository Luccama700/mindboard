import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/utils/supabase/server";
import {
  type CalendarEvent,
  GoogleCalendarConnectionError,
  listEventsForCalendar,
} from "@/utils/google/calendar";
import { EventRow, type VirtualEvent } from "@/app/_components/event-row";
import { TasksClient, type Task } from "@/app/_components/tasks-client";

function toLocalDateKey(iso: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const d = new Date(iso);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

function toVirtualEvents(
  events: CalendarEvent[],
  group: { name: string; color: string },
): VirtualEvent[] {
  const now = Date.now();
  const todayKey = toLocalDateKey(new Date().toISOString());
  return events.flatMap<VirtualEvent>((event) => {
    const startDateKey = toLocalDateKey(event.start);
    if (startDateKey < todayKey) return [];
    if (!event.allDay) {
      const endMs = new Date(event.end).getTime();
      if (Number.isFinite(endMs) && endMs <= now) return [];
    }
    return [
      {
        id: event.id,
        title: event.summary,
        startDateKey,
        startTime: event.allDay ? null : formatTime(event.start),
        endTime: event.allDay ? null : formatTime(event.end),
        allDay: event.allDay,
        groupName: group.name,
        groupColor: group.color,
      },
    ];
  });
}

export default async function GroupTasksPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const { data: group } = await supabase
    .from("groups")
    .select("id, name, type, color, google_calendar_id")
    .eq("id", id)
    .single();

  if (!group) notFound();

  const [{ data: tasks }, { data: groupRows }] = await Promise.all([
    supabase
      .from("tasks")
      .select(
        "id, title, due_date, status, priority, group_id, created_at, completed_at",
      )
      .eq("group_id", id)
      .order("created_at", { ascending: false }),
    supabase
      .from("groups")
      .select("id, name, color")
      .eq("archived", false)
      .order("created_at", { ascending: false }),
  ]);

  const groups = (groupRows ?? []) as { id: string; name: string; color: string }[];

  let upcomingEvents: VirtualEvent[] = [];
  if (group.google_calendar_id) {
    const now = new Date();
    const horizon = new Date(now);
    horizon.setDate(now.getDate() + 30);
    try {
      const events = await listEventsForCalendar(user.id, group.google_calendar_id, {
        timeMin: now.toISOString(),
        timeMax: horizon.toISOString(),
      });
      upcomingEvents = toVirtualEvents(events, group).sort((a, b) => {
        const dateCmp = a.startDateKey.localeCompare(b.startDateKey);
        if (dateCmp !== 0) return dateCmp;
        if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
        return (a.startTime ?? "").localeCompare(b.startTime ?? "");
      });
    } catch (error) {
      if (!(error instanceof GoogleCalendarConnectionError)) {
        console.error("listEventsForCalendar failed", error);
      }
    }
  }

  return (
    <main className="min-h-screen px-5 pt-8 pb-40 max-w-2xl mx-auto">
      <header className="flex items-center justify-between mb-8">
        <Link
          href="/groups"
          className="text-[#6b6b6b] text-xs tracking-widest uppercase hover:text-[#f5f0e8] transition-colors"
        >
          ← groups
        </Link>
        <p
          className="text-[10px] tracking-widest uppercase"
          style={{ color: group.color }}
        >
          {group.type}
        </p>
      </header>

      <div className="flex items-center gap-3 mb-8">
        <span
          className="w-1.5 h-8 flex-shrink-0"
          style={{ backgroundColor: group.color }}
          aria-hidden
        />
        <h1 className="text-2xl font-bold tracking-tight text-[#f5f0e8] truncate">
          {group.name}
        </h1>
      </div>

      {upcomingEvents.length > 0 && (
        <section className="mb-8">
          <p className="text-[10px] tracking-widest uppercase text-[#6b6b6b] mb-2 px-1">
            upcoming events · {upcomingEvents.length}
          </p>
          <div>
            {upcomingEvents.map((event) => (
              <EventRow key={event.id} event={event} />
            ))}
          </div>
        </section>
      )}

      <TasksClient initial={(tasks ?? []) as Task[]} groupId={id} groups={groups} />
    </main>
  );
}
