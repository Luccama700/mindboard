"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "@/utils/supabase/server";

const TIMEZONE_RE = /^[A-Za-z_+-]+(?:\/[A-Za-z0-9_+-]+){0,2}$/;

export async function savePreferences(input: {
  timezone: string;
  wakeStartHour: number;
  wakeEndHour: number;
}): Promise<{ error: string | null }> {
  const timezone = input.timezone?.trim() || "UTC";
  if (timezone.length > 64 || !TIMEZONE_RE.test(timezone)) {
    return { error: "invalid timezone" };
  }
  const wakeStartHour = Math.trunc(input.wakeStartHour);
  const wakeEndHour = Math.trunc(input.wakeEndHour);
  if (!Number.isFinite(wakeStartHour) || wakeStartHour < 0 || wakeStartHour > 23) {
    return { error: "wake start must be 0–23" };
  }
  if (!Number.isFinite(wakeEndHour) || wakeEndHour < 1 || wakeEndHour > 24) {
    return { error: "wake end must be 1–24" };
  }
  if (wakeEndHour <= wakeStartHour) {
    return { error: "wake end must be after wake start" };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "not authenticated" };

  const { error } = await supabase.from("user_settings").upsert(
    {
      user_id: user.id,
      timezone,
      wake_start_hour: wakeStartHour,
      wake_end_hour: wakeEndHour,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" },
  );
  if (error) return { error: error.message };

  revalidatePath("/", "layout");
  return { error: null };
}
