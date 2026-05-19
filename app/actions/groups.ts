"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/utils/supabase/server";

const ALLOWED_TYPES = ["course", "project", "work", "personal"] as const;
type GroupType = (typeof ALLOWED_TYPES)[number];

export async function createGroup(formData: FormData) {
  const name = (formData.get("name") as string | null)?.trim();
  const type = formData.get("type") as string | null;
  const color = formData.get("color") as string | null;

  if (!name) return { error: "name required" };
  if (!type || !ALLOWED_TYPES.includes(type as GroupType)) {
    return { error: "invalid type" };
  }
  if (!color || !/^#[0-9a-fA-F]{6}$/.test(color)) {
    return { error: "invalid color" };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "not authenticated" };

  const { error } = await supabase.from("groups").insert({
    user_id: user.id,
    name,
    type,
    color,
  });

  if (error) return { error: error.message };

  revalidatePath("/groups");
  return { error: null };
}

export async function archiveGroup(id: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "not authenticated" };

  const { error } = await supabase
    .from("groups")
    .update({ archived: true })
    .eq("id", id);

  if (error) return { error: error.message };

  revalidatePath("/groups");
  return { error: null };
}
