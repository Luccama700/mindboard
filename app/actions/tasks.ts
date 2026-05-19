"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/utils/supabase/server";

export async function createTask(input: {
  title: string;
  groupId: string | null;
  dueDate: string | null;
}) {
  const title = input.title?.trim();
  if (!title) return { error: "title required" };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "not authenticated" };

  const { data, error } = await supabase
    .from("tasks")
    .insert({
      user_id: user.id,
      group_id: input.groupId,
      title,
      due_date: input.dueDate,
    })
    .select("id, title, due_date, status, priority, group_id, created_at, completed_at")
    .single();

  if (error) return { error: error.message };

  revalidatePath(input.groupId ? `/groups/${input.groupId}` : "/inbox");
  return { error: null, task: data };
}

export async function toggleTaskStatus(id: string, currentStatus: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "not authenticated" };

  const nextStatus = currentStatus === "done" ? "todo" : "done";
  const completed_at = nextStatus === "done" ? new Date().toISOString() : null;

  const { error } = await supabase
    .from("tasks")
    .update({ status: nextStatus, completed_at })
    .eq("id", id);

  if (error) return { error: error.message };

  revalidatePath("/", "layout");
  return { error: null, nextStatus };
}

export async function deleteTask(id: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "not authenticated" };

  const { error } = await supabase.from("tasks").delete().eq("id", id);

  if (error) return { error: error.message };

  revalidatePath("/", "layout");
  return { error: null };
}
