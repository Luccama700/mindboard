import "server-only";
import { cache } from "react";

import { createClient } from "@/utils/supabase/server";

export type UserPreferences = {
  timezone: string | null;
  wake_start_hour: number;
  wake_end_hour: number;
};

const DEFAULTS: UserPreferences = {
  timezone: null,
  wake_start_hour: 8,
  wake_end_hour: 22,
};

// Manual everyday-spend fallback for the cashflow forecast (null = unset).
export const getDailySpendEstimate = cache(
  async (userId: string): Promise<number | null> => {
    const supabase = await createClient();
    const { data } = await supabase
      .from("user_settings")
      .select("daily_spend_estimate")
      .eq("user_id", userId)
      .maybeSingle();
    const value = data?.daily_spend_estimate;
    return value === null || value === undefined ? null : Number(value);
  },
);

export type ShoppingSettings = {
  store: string | null;
  // Weekly shopping weekday, 0 = Sunday. Null = unset (grocery forecast off).
  shoppingDay: number | null;
};

export const getShoppingSettings = cache(
  async (userId: string): Promise<ShoppingSettings> => {
    const supabase = await createClient();
    const { data } = await supabase
      .from("user_settings")
      .select("shopping_store, shopping_day")
      .eq("user_id", userId)
      .maybeSingle();
    return {
      store: (data?.shopping_store as string | null) ?? null,
      shoppingDay:
        typeof data?.shopping_day === "number" ? data.shopping_day : null,
    };
  },
);

export const getUserPreferences = cache(
  async (userId: string): Promise<UserPreferences> => {
    const supabase = await createClient();
    const { data } = await supabase
      .from("user_settings")
      .select("timezone, wake_start_hour, wake_end_hour")
      .eq("user_id", userId)
      .maybeSingle();
    if (!data) return DEFAULTS;
    return {
      timezone: (data.timezone as string | null) ?? null,
      wake_start_hour:
        typeof data.wake_start_hour === "number"
          ? data.wake_start_hour
          : DEFAULTS.wake_start_hour,
      wake_end_hour:
        typeof data.wake_end_hour === "number"
          ? data.wake_end_hour
          : DEFAULTS.wake_end_hour,
    };
  },
);
