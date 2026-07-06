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
