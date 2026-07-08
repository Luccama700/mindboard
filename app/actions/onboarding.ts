"use server";

import { createClient } from "@/utils/supabase/server";
import { isTourKey } from "@/app/_components/onboarding/tours";

// Read-merge-upsert: the jsonb map is tiny (one key per tour) and a lost
// race costs at most one re-shown tour, so no locking. The row may not exist
// yet for a brand-new user — upsert, not update.
export async function completeTour(key: string) {
  if (!isTourKey(key)) return { error: "unknown tour" };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "not authenticated" };

  const { data } = await supabase
    .from("user_settings")
    .select("completed_tours")
    .eq("user_id", user.id)
    .maybeSingle();

  const current =
    data?.completed_tours && typeof data.completed_tours === "object"
      ? (data.completed_tours as Record<string, string>)
      : {};

  const { error } = await supabase.from("user_settings").upsert(
    {
      user_id: user.id,
      completed_tours: { ...current, [key]: new Date().toISOString() },
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" },
  );

  if (error) return { error: error.message };
  return { error: null };
}

export async function resetTours() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "not authenticated" };

  const { error } = await supabase.from("user_settings").upsert(
    {
      user_id: user.id,
      completed_tours: {},
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" },
  );

  if (error) return { error: error.message };
  return { error: null };
}
