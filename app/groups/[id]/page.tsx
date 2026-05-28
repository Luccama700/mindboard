import { Suspense } from "react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/utils/supabase/server";
import {
  type CalendarEvent,
  GoogleCalendarConnectionError,
  listEventsForCalendar,
} from "@/utils/google/calendar";
import { EventRow, type VirtualEvent } from "@/app/_components/event-row";
import { GroupDetailClient } from "@/app/_components/group-detail-client";
import type { Task } from "@/app/_components/types";
import { formatClockTime } from "@/app/_components/date-utils";

function toLocalDateKey(iso: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const d = new Date(iso);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
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
        startTime: event.allDay ? null : formatClockTime(event.start),
        endTime: event.allDay ? null : formatClockTime(event.end),
        allDay: event.allDay,
        groupName: group.name,
        groupColor: group.color,
      },
    ];
  });
}

async function UpcomingEventsSection({
  userId,
  calendarId,
  group,
}: {
  userId: string;
  calendarId: string;
  group: { name: string; color: string };
}) {
  const now = new Date();
  const horizon = new Date(now);
  horizon.setDate(now.getDate() + 30);

  let events: VirtualEvent[] = [];
  try {
    const raw = await listEventsForCalendar(userId, calendarId, {
      timeMin: now.toISOString(),
      timeMax: horizon.toISOString(),
    });
    events = toVirtualEvents(raw, group).sort((a, b) => {
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

  if (events.length === 0) return null;

  return (
    <div className="mb-8">
      <p className="text-[10px] tracking-widest uppercase text-muted mb-2 px-1">
        upcoming events · {events.length}
      </p>
      <div>
        {events.map((event) => (
          <EventRow key={event.id} event={event} />
        ))}
      </div>
    </div>
  );
}

function UpcomingEventsSkeleton() {
  return (
    <div className="mb-8 animate-pulse" aria-hidden>
      <div className="h-2.5 w-32 bg-line mb-2" />
      <div className="space-y-px">
        <div className="h-14 bg-card" />
        <div className="h-14 bg-card" />
      </div>
    </div>
  );
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

  const [groupResult, tasksResult, groupsResult] = await Promise.all([
    supabase
      .from("groups")
      .select("id, name, type, color, google_calendar_id")
      .eq("id", id)
      .single(),
    supabase
      .from("tasks")
      .select(
        "id, title, due_date, status, priority, notes, group_id, created_at, completed_at",
      )
      .eq("group_id", id)
      .order("created_at", { ascending: false }),
    supabase
      .from("groups")
      .select("id, name, color")
      .eq("archived", false)
      .order("created_at", { ascending: false }),
  ]);

  const group = groupResult.data;
  if (!group) notFound();

  const groups = (groupsResult.data ?? []) as {
    id: string;
    name: string;
    color: string;
  }[];

  const upcomingEventsSlot = group.google_calendar_id ? (
    <Suspense fallback={<UpcomingEventsSkeleton />}>
      <UpcomingEventsSection
        userId={user.id}
        calendarId={group.google_calendar_id}
        group={{ name: group.name, color: group.color }}
      />
    </Suspense>
  ) : null;

  return (
    <main className="min-h-screen px-5 pt-8 pb-56 lg:px-12">
      <header className="flex items-center justify-between mb-8">
        <Link
          href="/groups"
          className="text-muted text-xs tracking-widest uppercase hover:text-fg transition-colors"
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
        <h1 className="text-2xl font-bold tracking-tight text-fg truncate">
          {group.name}
        </h1>
      </div>

      <GroupDetailClient
        initial={(tasksResult.data ?? []) as Task[]}
        groupId={id}
        groups={groups}
        upcomingEventsSlot={upcomingEventsSlot}
      />
    </main>
  );
}
