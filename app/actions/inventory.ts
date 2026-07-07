"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/utils/supabase/server";

const ITEM_COLUMNS =
  "id, name, quantity, unit, notes, image_url, inventory_group_id, reorder_threshold, archived, archived_at, last_restocked_at, created_at";
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

  revalidatePath("/inventory");
  return { error: null };
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
