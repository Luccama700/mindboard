"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "@/utils/supabase/server";
import {
  lookupPrices,
  type PriceLookupResult,
} from "@/app/lib/shopping/price-lookup";

// Shopping-panel server side: AI price lookups on the user's stored key.
// force overwrites AI-sourced prices; manual prices always survive.
export async function lookupItemPrices(input: {
  itemIds: string[];
  force?: boolean;
}): Promise<{ error: string | null; results?: PriceLookupResult[] }> {
  if (!Array.isArray(input.itemIds) || input.itemIds.length === 0) {
    return { error: null, results: [] };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "not authenticated" };

  const outcome = await lookupPrices({
    supabase,
    userId: user.id,
    itemIds: input.itemIds.filter((id) => typeof id === "string"),
    force: input.force === true,
  });
  if (!outcome.ok) return { error: outcome.error };

  revalidatePath("/inventory");
  revalidatePath("/finance");
  return { error: null, results: outcome.results };
}
