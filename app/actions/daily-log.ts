"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "@/utils/supabase/server";
import { todayISO } from "@/app/_components/date-utils";

function inRange(v: number, lo: number, hi: number): boolean {
  return Number.isFinite(v) && v >= lo && v <= hi;
}

export async function saveDailyLog(input: {
  mood: number;
  energy: number;
  sleepHours: number | null;
}): Promise<{ error: string | null }> {
  const mood = Math.trunc(input.mood);
  const energy = Math.trunc(input.energy);
  if (!inRange(mood, 1, 5)) return { error: "mood must be 1–5" };
  if (!inRange(energy, 1, 5)) return { error: "energy must be 1–5" };
  const sleepHours =
    input.sleepHours === null ? null : Number(input.sleepHours);
  if (sleepHours !== null && !inRange(sleepHours, 0, 24)) {
    return { error: "sleep must be 0–24 hours" };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "not authenticated" };

  const { error } = await supabase.from("daily_logs").upsert(
    {
      user_id: user.id,
      log_date: todayISO(),
      mood,
      energy,
      sleep_hours: sleepHours,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id,log_date" },
  );
  if (error) return { error: error.message };

  revalidatePath("/");
  return { error: null };
}
