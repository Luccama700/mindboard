import { redirect } from "next/navigation";

import { createClient } from "@/utils/supabase/server";
import { DashboardCalendar } from "@/app/_components/dashboard-calendar";
import { getDashboardData, normalizeMonth } from "@/app/lib/data/dashboard";
import { getUserPreferences } from "@/app/lib/data/settings";

export default async function WeekPage({
  searchParams,
}: {
  searchParams: Promise<{ m?: string | string[] | undefined }>;
}) {
  const query = await searchParams;
  const month = normalizeMonth(query.m);

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const [
    { calendarTasks, events, finance, calendarStatus, calendarLinks },
    prefs,
  ] = await Promise.all([
    getDashboardData(user.id, month),
    getUserPreferences(user.id),
  ]);

  return (
    <main className="min-h-screen px-4 pt-6 pb-64 lg:px-8 max-w-6xl mx-auto">
      <header className="flex items-center justify-between mb-6">
        <h1 className="text-label uppercase text-muted">schedule</h1>
      </header>
      <DashboardCalendar
        key={month}
        month={month}
        tasks={calendarTasks}
        events={events}
        finance={finance}
        status={calendarStatus}
        calendarLinks={calendarLinks}
        initialView="week"
        wakeStartHour={prefs.wake_start_hour}
        wakeEndHour={prefs.wake_end_hour}
      />
    </main>
  );
}
