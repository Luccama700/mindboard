"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/utils/supabase/server";

const ITEM_COLUMNS =
  "id, name, quantity, unit, notes, inventory_group_id, created_at";
const GROUP_COLUMNS = "id, name, color, created_at";

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

  if (Object.keys(updates).length === 0) return { error: null };

  const { error } = await supabase
    .from("inventory_items")
    .update(updates)
    .eq("id", input.id);

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
