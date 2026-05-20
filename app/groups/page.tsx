import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/utils/supabase/server";
import {
  CalendarListEntry,
  GoogleCalendarConnectionError,
  listCalendars,
} from "@/utils/google/calendar";
import { GroupsClient } from "./groups-client";

export type Group = {
  id: string;
  name: string;
  type: "course" | "project" | "work" | "personal";
  color: string;
  archived: boolean;
  created_at: string;
  google_calendar_id: string | null;
};

export default async function GroupsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const { data: groups } = await supabase
    .from("groups")
    .select("id, name, type, color, archived, created_at, google_calendar_id")
    .eq("archived", false)
    .order("created_at", { ascending: false });

  let calendars: CalendarListEntry[] = [];
  try {
    calendars = await listCalendars(user.id);
  } catch (error) {
    if (!(error instanceof GoogleCalendarConnectionError)) {
      console.error("listCalendars failed", error);
    }
  }

  return (
    <main className="min-h-screen px-5 pt-8 pb-32 max-w-2xl mx-auto">
      <header className="flex items-center justify-between mb-10">
        <Link
          href="/"
          className="text-[#6b6b6b] text-xs tracking-widest uppercase hover:text-[#f5f0e8] transition-colors"
        >
          ← mindboard
        </Link>
        <h1 className="text-xs tracking-widest uppercase text-[#6b6b6b]">
          groups
        </h1>
      </header>

      <GroupsClient
        initial={(groups ?? []) as Group[]}
        calendars={calendars}
      />
    </main>
  );
}
