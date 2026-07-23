"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/utils/supabase/server";
import type { TopicKind, TopicStatus } from "@/app/lib/mindspace/types";

const KINDS: TopicKind[] = [
  "person",
  "project",
  "work",
  "course",
  "area",
  "emergent",
];
const STATUSES: TopicStatus[] = ["active", "muted", "archived"];
const MAX_SEED = 100;

export type SeedTopicInput = {
  name: string;
  kind: TopicKind;
  vaultPath: string | null;
  groupId: string | null;
  color: string | null;
};

export async function seedMindspaceTopics(candidates: SeedTopicInput[]) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "not authenticated" };

  const rows = candidates
    .slice(0, MAX_SEED)
    .map((candidate) => ({
      name: candidate.name.trim(),
      kind: candidate.kind,
      vaultPath: candidate.vaultPath,
      groupId: candidate.groupId,
      color: candidate.color,
    }))
    .filter(
      (candidate) =>
        candidate.name.length > 0 && KINDS.includes(candidate.kind),
    );
  if (rows.length === 0) return { error: "no topics selected" };

  // The unique index is on (user_id, lower(name)) — an expression PostgREST
  // upsert can't target — so duplicates are filtered out before a plain insert.
  const { data: existing, error: readError } = await supabase
    .from("mindspace_topics")
    .select("name")
    .eq("user_id", user.id);
  if (readError) return { error: readError.message };
  const taken = new Set(
    (existing ?? []).map((row) => (row.name as string).toLowerCase()),
  );
  const fresh = rows.filter((row) => !taken.has(row.name.toLowerCase()));
  if (fresh.length === 0) {
    revalidatePath("/mindspace");
    return { error: null };
  }

  const { error } = await supabase.from("mindspace_topics").insert(
    fresh.map((row) => ({
      user_id: user.id,
      name: row.name,
      kind: row.kind,
      seed_ref: {
        ...(row.vaultPath ? { vaultPath: row.vaultPath } : {}),
        ...(row.groupId ? { groupId: row.groupId } : {}),
      },
      color: row.color,
    })),
  );
  if (error) return { error: error.message };

  revalidatePath("/mindspace");
  return { error: null };
}

export async function createMindspaceTopic(input: {
  name: string;
  kind: TopicKind;
}) {
  const name = input.name.trim();
  if (!name) return { error: "name required" };
  if (!KINDS.includes(input.kind)) return { error: "invalid kind" };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "not authenticated" };

  const { error } = await supabase.from("mindspace_topics").insert({
    user_id: user.id,
    name,
    kind: input.kind,
  });
  if (error) return { error: error.message };

  revalidatePath("/mindspace");
  return { error: null };
}

export async function updateMindspaceTopic(input: {
  id: string;
  name?: string;
  aliases?: string[];
  status?: TopicStatus;
  pinned?: boolean;
  color?: string | null;
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
  if (input.aliases !== undefined) {
    updates.aliases = input.aliases
      .map((alias) => alias.trim())
      .filter((alias) => alias.length > 0)
      .slice(0, 20);
  }
  if (input.status !== undefined) {
    if (!STATUSES.includes(input.status)) return { error: "invalid status" };
    updates.status = input.status;
  }
  if (input.pinned !== undefined) updates.pinned = input.pinned;
  if (input.color !== undefined) {
    if (input.color !== null && !/^#[0-9a-fA-F]{6}$/.test(input.color)) {
      return { error: "invalid color" };
    }
    updates.color = input.color;
  }
  if (Object.keys(updates).length === 0) return { error: null };
  updates.updated_at = new Date().toISOString();

  const { error } = await supabase
    .from("mindspace_topics")
    .update(updates)
    .eq("id", input.id);
  if (error) return { error: error.message };

  revalidatePath("/mindspace");
  return { error: null };
}

// Merge = the absorbed topic's name and aliases become aliases of the target,
// then the absorbed row is deleted. With read-time classification there is no
// label history to migrate.
export async function mergeMindspaceTopics(input: {
  fromId: string;
  intoId: string;
}) {
  if (input.fromId === input.intoId) return { error: "cannot merge into self" };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "not authenticated" };

  const { data: rows, error: readError } = await supabase
    .from("mindspace_topics")
    .select("id, name, aliases")
    .in("id", [input.fromId, input.intoId]);
  if (readError) return { error: readError.message };
  const from = rows?.find((row) => row.id === input.fromId);
  const into = rows?.find((row) => row.id === input.intoId);
  if (!from || !into) return { error: "topic not found" };

  const merged = [
    ...new Set(
      [...((into.aliases as string[]) ?? []), from.name as string, ...((from.aliases as string[]) ?? [])]
        .map((alias) => alias.trim())
        .filter((alias) => alias.length > 0),
    ),
  ].slice(0, 20);

  const { error: updateError } = await supabase
    .from("mindspace_topics")
    .update({ aliases: merged, updated_at: new Date().toISOString() })
    .eq("id", input.intoId);
  if (updateError) return { error: updateError.message };

  const { error: deleteError } = await supabase
    .from("mindspace_topics")
    .delete()
    .eq("id", input.fromId);
  if (deleteError) return { error: deleteError.message };

  revalidatePath("/mindspace");
  return { error: null };
}

export async function deleteMindspaceTopic(id: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "not authenticated" };

  const { error } = await supabase
    .from("mindspace_topics")
    .delete()
    .eq("id", id);
  if (error) return { error: error.message };

  revalidatePath("/mindspace");
  return { error: null };
}
