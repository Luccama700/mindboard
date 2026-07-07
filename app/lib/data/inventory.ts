import "server-only";
import { cache } from "react";
import { createClient } from "@/utils/supabase/server";
import type {
  InventoryItem,
  InventoryUsage,
} from "@/app/_components/inventory-types";

// Reusable inventory reads. Selects mirror app/inventory/page.tsx; RLS scopes
// every row to the caller. React-cache()'d so the dashboard vitals strip and any
// future consumer share one query per request. userId is the cache key.

const ITEM_COLUMNS =
  "id, name, quantity, unit, notes, image_url, inventory_group_id, reorder_threshold, archived, archived_at, last_restocked_at, created_at";
const USAGE_COLUMNS =
  "id, inventory_item_id, amount, period, interval_days, created_at";

export const getInventoryItems = cache(
  async (userId: string): Promise<InventoryItem[]> => {
    const supabase = await createClient();
    const { data } = await supabase
      .from("inventory_items")
      .select(ITEM_COLUMNS)
      .eq("user_id", userId)
      .eq("archived", false)
      .order("created_at", { ascending: true });
    return (data ?? []) as InventoryItem[];
  },
);

export const getInventoryUsages = cache(
  async (userId: string): Promise<InventoryUsage[]> => {
    const supabase = await createClient();
    const { data } = await supabase
      .from("inventory_usages")
      .select(USAGE_COLUMNS)
      .eq("user_id", userId)
      .order("created_at", { ascending: true });
    return (data ?? []) as InventoryUsage[];
  },
);
