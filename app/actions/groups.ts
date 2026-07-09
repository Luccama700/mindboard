"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/utils/supabase/server";
import {
  type CalendarListEntry,
  GoogleCalendarConnectionError,
  listCalendars,
} from "@/utils/google/calendar";

// Calendar list for the dock's groups sheet, fetched on first open — the
// globally-mounted dock must never pay the Google round-trip per page load.
export async function loadCalendarOptions(): Promise<CalendarListEntry[]> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return [];
  try {
    return await listCalendars(user.id);
  } catch (error) {
    if (!(error instanceof GoogleCalendarConnectionError)) {
      console.error("listCalendars failed", error);
    }
    return [];
  }
}

const ALLOWED_TYPES = ["course", "project", "work", "personal"] as const;
type GroupType = (typeof ALLOWED_TYPES)[number];

export async function createGroup(formData: FormData) {
  const name = (formData.get("name") as string | null)?.trim();
  const type = formData.get("type") as string | null;
  const color = formData.get("color") as string | null;

  if (!name) return { error: "name required" };
  if (!type || !ALLOWED_TYPES.includes(type as GroupType)) {
    return { error: "invalid type" };
  }
  if (!color || !/^#[0-9a-fA-F]{6}$/.test(color)) {
    return { error: "invalid color" };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "not authenticated" };

  const { error } = await supabase.from("groups").insert({
    user_id: user.id,
    name,
    type,
    color,
  });

  if (error) return { error: error.message };

  revalidatePath("/", "layout");
  return { error: null };
}

export async function updateGroup(input: {
  id: string;
  name?: string;
  type?: string;
  color?: string;
  googleCalendarId?: string | null;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "not authenticated" };

  const updates: Record<string, unknown> = {};

  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) return { error: "name required" };
    updates.name = name;
  }
  if (input.type !== undefined) {
    if (!ALLOWED_TYPES.includes(input.type as GroupType)) {
      return { error: "invalid type" };
    }
    updates.type = input.type;
  }
  if (input.color !== undefined) {
    if (!/^#[0-9a-fA-F]{6}$/.test(input.color)) {
      return { error: "invalid color" };
    }
    updates.color = input.color;
  }
  if (input.googleCalendarId !== undefined) {
    if (
      input.googleCalendarId !== null &&
      (typeof input.googleCalendarId !== "string" ||
        input.googleCalendarId.length > 256)
    ) {
      return { error: "invalid calendar" };
    }
    updates.google_calendar_id = input.googleCalendarId;
  }

  if (Object.keys(updates).length === 0) return { error: null };

  const { error } = await supabase
    .from("groups")
    .update(updates)
    .eq("id", input.id);

  if (error) return { error: error.message };

  revalidatePath("/groups");
  revalidatePath("/", "layout");
  return { error: null };
}

export async function archiveGroup(id: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "not authenticated" };

  const { error } = await supabase
    .from("groups")
    .update({ archived: true })
    .eq("id", id);

  if (error) return { error: error.message };

  revalidatePath("/", "layout");
  return { error: null };
}
