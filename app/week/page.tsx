import { redirect } from "next/navigation";

import { createClient } from "@/utils/supabase/server";
import { DashboardCalendar } from "@/app/_components/dashboard-calendar";
import {
  getDashboardData,
  normalizeDay,
  normalizeMonth,
} from "@/app/lib/data/dashboard";
import { getUserPreferences } from "@/app/lib/data/settings";
import { occurrenceBusyEvents, slotBusyEvents } from "@/app/lib/recurrence";
import { scheduleSnapshot } from "@/app/lib/snapshots/schedule";
import { safeTimeZone, todayISO } from "@/app/_components/date-utils";
import { addDaysKey } from "@/app/lib/snapshots/stream";

export default async function WeekPage({
  searchParams,
}: {
  searchParams: Promise<{
    m?: string | string[] | undefined;
    d?: string | string[] | undefined;
  }>;
}) {
  const query = await searchParams;
  const selectedDay = normalizeDay(query.d);

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // The default month is the USER'S current month: on the process clock the
  // last evening of a month fetched next month's grid, so the week actually
  // being viewed had no events or completions loaded at all. This serialises
  // prefs before getDashboardData — nothing is deduped here, /week is the only
  // caller in the request — and /week has no Suspense boundary, so the extra
  // round-trip lands on TTFB. Accepted: fetching the wrong month is worse than
  // one indexed read.
  const prefs = await getUserPreferences(user.id);
  const timeZone = safeTimeZone(prefs.timezone);
  const month = selectedDay
    ? selectedDay.slice(0, 7)
    : normalizeMonth(query.m, timeZone);

  const {
    calendarTasks,
    events,
    finance,
    calendarStatus,
    calendarLinks,
    recurringTasks,
    recurringCompletions,
    recurringSlots,
  } = await getDashboardData(user.id, month);

  const today = todayISO(timeZone);
  const slotKeys = new Set(
    recurringSlots.map((s) => `${s.rule_id}:${s.occurred_on}`),
  );
  const schedule = scheduleSnapshot({
    events: [
      ...events,
      ...occurrenceBusyEvents(
        recurringTasks,
        [today, addDaysKey(today, 1)],
        slotKeys,
        timeZone,
      ),
      ...slotBusyEvents(recurringSlots, recurringTasks, timeZone),
    ],
    now: new Date(),
    wakeStartHour: prefs.wake_start_hour,
    wakeEndHour: prefs.wake_end_hour,
    timeZone,
  });

  return (
    <main className="min-h-screen px-4 pt-6 pb-64 lg:px-8 max-w-6xl mx-auto">
      <header className="flex items-center justify-between mb-6">
        <h1 className="text-label uppercase text-muted">schedule</h1>
      </header>
      <div data-tour="week-grid">
        <DashboardCalendar
          key={`${month}:${selectedDay ?? ""}`}
          month={month}
          today={today}
          timeZone={timeZone}
          tasks={calendarTasks}
          events={events}
          finance={finance}
          status={calendarStatus}
          calendarLinks={calendarLinks}
          initialView="week"
          selectedDay={selectedDay}
          wakeStartHour={prefs.wake_start_hour}
          wakeEndHour={prefs.wake_end_hour}
          scheduleVitals={schedule}
          basePath="/week"
          recurringTasks={recurringTasks}
          recurringCompletions={recurringCompletions}
          recurringSlots={recurringSlots}
        />
      </div>
    </main>
  );
}
