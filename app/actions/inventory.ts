"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { createClient } from "@/utils/supabase/server";
import { lookupPrices } from "@/app/lib/shopping/price-lookup";
import { adjustQuantity, itemQuantityStore } from "@/app/lib/inventory/quantity";

const ITEM_COLUMNS =
  "id, name, quantity, unit, notes, image_url, inventory_group_id, reorder_threshold, priority, archived, archived_at, last_restocked_at, shopping_pinned, buy_amount, est_price, price_source, price_checked_at, created_at";

const PRIORITIES = new Set(["low", "med", "high"]);
const GROUP_COLUMNS = "id, name, color, created_at";
const USAGE_COLUMNS =
  "id, inventory_item_id, amount, period, interval_days, created_at";

function normalizeQuantity(value: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value < 0) return 0;
  return value;
}

export async function createInventoryGroup(input: {
  name: string;
  color: string;
}) {
  const name = input.name?.trim();
  if (!name) return { error: "name required" };
  if (!input.color || !/^#[0-9a-fA-F]{6}$/.test(input.color)) {
    return { error: "invalid color" };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "not authenticated" };

  const { data, error } = await supabase
    .from("inventory_groups")
    .insert({ user_id: user.id, name, color: input.color })
    .select(GROUP_COLUMNS)
    .single();

  if (error) return { error: error.message };

  revalidatePath("/inventory");
  return { error: null, group: data };
}

export async function updateInventoryGroup(input: {
  id: string;
  name?: string;
  color?: string;
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
  if (input.color !== undefined) {
    if (!/^#[0-9a-fA-F]{6}$/.test(input.color)) {
      return { error: "invalid color" };
    }
    updates.color = input.color;
  }

  if (Object.keys(updates).length === 0) return { error: null };

  const { error } = await supabase
    .from("inventory_groups")
    .update(updates)
    .eq("id", input.id);

  if (error) return { error: error.message };

  revalidatePath("/inventory");
  return { error: null };
}

export async function deleteInventoryGroup(id: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "not authenticated" };

  const { error } = await supabase
    .from("inventory_groups")
    .delete()
    .eq("id", id);

  if (error) return { error: error.message };

  revalidatePath("/inventory");
  return { error: null };
}

export async function createInventoryItem(input: {
  groupId: string | null;
  name: string;
  quantity: number;
  unit: string;
  notes?: string | null;
}) {
  const name = input.name?.trim();
  if (!name) return { error: "name required" };

  const quantity = normalizeQuantity(input.quantity);
  if (quantity === null) return { error: "invalid quantity" };

  const unit = input.unit?.trim() ?? "";
  const notes = input.notes?.trim() || null;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "not authenticated" };

  const { data, error } = await supabase
    .from("inventory_items")
    .insert({
      user_id: user.id,
      inventory_group_id: input.groupId,
      name,
      quantity,
      unit,
      notes,
    })
    .select(ITEM_COLUMNS)
    .single();

  if (error) return { error: error.message };

  revalidatePath("/inventory");
  return { error: null, item: data };
}

export async function updateInventoryItem(input: {
  id: string;
  name?: string;
  quantity?: number;
  unit?: string;
  groupId?: string | null;
  notes?: string | null;
  imageUrl?: string | null;
  reorderThreshold?: number | null;
  priority?: "low" | "med" | "high";
  shoppingPinned?: boolean;
  buyAmount?: number | null;
  estPrice?: number | null;
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
  if (input.quantity !== undefined) {
    const quantity = normalizeQuantity(input.quantity);
    if (quantity === null) return { error: "invalid quantity" };
    updates.quantity = quantity;
  }
  if (input.unit !== undefined) updates.unit = input.unit.trim();
  if (input.groupId !== undefined)
    updates.inventory_group_id = input.groupId;
  if (input.notes !== undefined) updates.notes = input.notes?.trim() || null;
  if (input.imageUrl !== undefined) {
    if (
      input.imageUrl !== null &&
      (typeof input.imageUrl !== "string" || input.imageUrl.length > 2048)
    ) {
      return { error: "invalid image url" };
    }
    updates.image_url = input.imageUrl;
  }
  if (input.reorderThreshold !== undefined) {
    if (input.reorderThreshold === null) {
      updates.reorder_threshold = null;
    } else {
      const t = normalizeQuantity(input.reorderThreshold);
      if (t === null) return { error: "invalid threshold" };
      updates.reorder_threshold = t;
    }
  }
  if (input.priority !== undefined) {
    if (!PRIORITIES.has(input.priority)) return { error: "invalid priority" };
    updates.priority = input.priority;
  }
  if (input.shoppingPinned !== undefined) {
    updates.shopping_pinned = input.shoppingPinned === true;
  }
  if (input.buyAmount !== undefined) {
    if (input.buyAmount === null) {
      updates.buy_amount = null;
    } else {
      const n = Number(input.buyAmount);
      if (!Number.isFinite(n) || n <= 0) return { error: "invalid buy amount" };
      updates.buy_amount = Math.round(n * 1000) / 1000;
    }
  }
  if (input.estPrice !== undefined) {
    if (input.estPrice === null) {
      updates.est_price = null;
      updates.price_source = null;
      updates.price_checked_at = null;
    } else {
      const p = Number(input.estPrice);
      if (!Number.isFinite(p) || p < 0 || p > 100000) {
        return { error: "invalid price" };
      }
      updates.est_price = Math.round(p * 100) / 100;
      updates.price_source = "manual";
      updates.price_checked_at = new Date().toISOString();
    }
  }

  if (Object.keys(updates).length === 0) return { error: null };

  if (updates.quantity !== undefined) {
    const { data: current } = await supabase
      .from("inventory_items")
      .select("quantity")
      .eq("id", input.id)
      .single();
    if (
      current &&
      Number(updates.quantity) > Number((current as { quantity: number }).quantity)
    ) {
      updates.last_restocked_at = new Date().toISOString();
    }
  }

  const { error } = await supabase
    .from("inventory_items")
    .update(updates)
    .eq("id", input.id);

  if (error) return { error: error.message };

  // Pinning to the shopping list quietly fills a missing price after the
  // response (lookupPrices skips priced items and no-ops without a store/key).
  if (updates.shopping_pinned === true) {
    after(async () => {
      try {
        await lookupPrices({ supabase, userId: user.id, itemIds: [input.id] });
        revalidatePath("/inventory");
        revalidatePath("/finance");
      } catch {
        // best-effort: a failed lookup just leaves the price unset
      }
    });
  }

  revalidatePath("/inventory");
  // The dashboard stream shows inventory vitals and its quantity stepper reads
  // the server snapshot; revalidate it so a step is reflected and the stepper's
  // optimistic override reconciles against a fresh quantity (not a stale one).
  revalidatePath("/", "layout");
  return { error: null };
}

// Steppers and "+2 milk" capture go through here, never through
// updateInventoryItem's absolute `quantity`: the delta is applied server-side
// against the live row so a stale tab can't overwrite another surface's write.
export async function adjustInventoryQuantity(input: {
  id: string;
  delta: number;
}) {
  const delta = Number(input.delta);
  if (!Number.isFinite(delta) || delta === 0) return { error: "invalid delta" };
  if (!input.id || typeof input.id !== "string") {
    return { error: "invalid item" };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "not authenticated" };

  const outcome = await adjustQuantity(
    itemQuantityStore(supabase, input.id, user.id, new Date().toISOString()),
    delta,
  );
  if (!outcome.ok) return { error: outcome.error };

  revalidatePath("/inventory");
  // The dashboard stream shows inventory vitals and its quantity stepper reads
  // the server snapshot; revalidate it so a step is reflected and the stepper's
  // optimistic override reconciles against a fresh quantity (not a stale one).
  revalidatePath("/", "layout");
  return { error: null, quantity: outcome.after };
}

export async function setInventoryItemArchived(id: string, archived: boolean) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "not authenticated" };

  const { error } = await supabase
    .from("inventory_items")
    .update({
      archived,
      archived_at: archived ? new Date().toISOString() : null,
    })
    .eq("id", id);

  if (error) return { error: error.message };

  revalidatePath("/inventory");
  return { error: null };
}

export async function deleteInventoryItem(id: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "not authenticated" };

  const { error } = await supabase
    .from("inventory_items")
    .delete()
    .eq("id", id);

  if (error) return { error: error.message };

  revalidatePath("/inventory");
  return { error: null };
}

const USAGE_PERIODS = new Set(["day", "week", "custom"]);

function normalizeUsage(input: {
  amount: number;
  period: string;
  intervalDays?: number | null;
}): { amount: number; period: string; interval_days: number | null } | null {
  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  if (!USAGE_PERIODS.has(input.period)) return null;

  let interval_days: number | null = null;
  if (input.period === "custom") {
    const n = Number(input.intervalDays);
    if (!Number.isInteger(n) || n < 1) return null;
    interval_days = n;
  }
  return { amount, period: input.period, interval_days };
}

export async function createInventoryUsage(input: {
  itemId: string;
  amount: number;
  period: string;
  intervalDays?: number | null;
}) {
  const normalized = normalizeUsage(input);
  if (!normalized) return { error: "invalid usage" };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "not authenticated" };

  const { data, error } = await supabase
    .from("inventory_usages")
    .insert({
      user_id: user.id,
      inventory_item_id: input.itemId,
      amount: normalized.amount,
      period: normalized.period,
      interval_days: normalized.interval_days,
    })
    .select(USAGE_COLUMNS)
    .single();

  if (error) return { error: error.message };

  revalidatePath("/inventory");
  return { error: null, usage: data };
}

export async function updateInventoryUsage(input: {
  id: string;
  amount: number;
  period: string;
  intervalDays?: number | null;
}) {
  const normalized = normalizeUsage(input);
  if (!normalized) return { error: "invalid usage" };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "not authenticated" };

  const { error } = await supabase
    .from("inventory_usages")
    .update({
      amount: normalized.amount,
      period: normalized.period,
      interval_days: normalized.interval_days,
    })
    .eq("id", input.id);

  if (error) return { error: error.message };

  revalidatePath("/inventory");
  return { error: null };
}

export async function deleteInventoryUsage(id: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "not authenticated" };

  const { error } = await supabase
    .from("inventory_usages")
    .delete()
    .eq("id", id);

  if (error) return { error: error.message };

  revalidatePath("/inventory");
  return { error: null };
}
