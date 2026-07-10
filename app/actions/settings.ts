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

// Grocery store + weekly shopping weekday (0 = Sunday) for the shopping list.
// The store string feeds AI price lookups; the day anchors projected grocery
// spend on the finance forecast. Null clears either.
export async function saveShoppingSettings(input: {
  store?: string | null;
  shoppingDay?: number | null;
}): Promise<{ error: string | null }> {
  const updates: Record<string, unknown> = {};
  if (input.store !== undefined) {
    const store = input.store?.trim() || null;
    if (store !== null && store.length > 200) {
      return { error: "store name too long" };
    }
    updates.shopping_store = store;
  }
  if (input.shoppingDay !== undefined) {
    if (input.shoppingDay === null) {
      updates.shopping_day = null;
    } else {
      const day = Math.trunc(input.shoppingDay);
      if (!Number.isFinite(day) || day < 0 || day > 6) {
        return { error: "shopping day must be 0–6" };
      }
      updates.shopping_day = day;
    }
  }
  if (Object.keys(updates).length === 0) return { error: null };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "not authenticated" };

  const { error } = await supabase.from("user_settings").upsert(
    {
      user_id: user.id,
      ...updates,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" },
  );
  if (error) return { error: error.message };

  revalidatePath("/inventory");
  revalidatePath("/finance");
  return { error: null };
}

// Manual everyday-spend fallback for the cashflow forecast (null clears it and
// the forecast shows nothing until spending history is thick enough).
export async function saveDailySpendEstimate(
  value: number | null,
): Promise<{ error: string | null }> {
  let estimate: number | null = null;
  if (value !== null) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0 || n > 100000) {
      return { error: "invalid amount" };
    }
    estimate = Math.round(n * 100) / 100;
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "not authenticated" };

  const { error } = await supabase.from("user_settings").upsert(
    {
      user_id: user.id,
      daily_spend_estimate: estimate,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" },
  );
  if (error) return { error: error.message };

  revalidatePath("/finance");
  return { error: null };
}
