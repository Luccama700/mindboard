"use server";

import { createClient } from "@/utils/supabase/server";
import { getPeopleGroups } from "@/app/lib/data/people";
import type { PersonGroup } from "@/app/_components/people-types";

// Lazy loader for the dock's groups sheet (people tab) — one fetch per
// sheet-open, the loadCalendarOptions precedent. Reads only the caller's
// own groups; RLS session client.
export async function loadPeopleGroups(): Promise<PersonGroup[]> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return [];
  return getPeopleGroups(user.id);
}
