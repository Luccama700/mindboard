"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/utils/supabase/server";
import { noteTitle } from "@/app/lib/brain/parse";
import {
  PEOPLE_FOLDER,
  readCuratedAliases,
  seedAliases,
  upsertPeopleRows,
} from "@/app/lib/people/sync";

// User-initiated People writes. Every row that touches a `people` record sets
// updated_at explicitly — no triggers exist in this codebase to do it
// (docs/people-plan.md §10). person_interactions has no updated_at column, so
// interaction edits deliberately set none.

const PEOPLE_COLUMNS =
  "id, name, vault_path, aliases, checkin_days, attention_snoozed_until, archived, archived_at, created_at, updated_at";
const INTERACTION_COLUMNS =
  "id, person_id, summary, occurred_at, occurred_precision, source, created_at";

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
const PRECISIONS = new Set(["exact", "approx"]);
const MIN_ALIAS_LENGTH = 3;
const UNIQUE_VIOLATION = "23505";

function nowStamp(): string {
  // A timestamptz instant, not a calendar day: no date key is derived from it.
  return new Date().toISOString();
}

function nameTaken(name: string): string {
  return `you already have a ${name} — add a distinguishing name`;
}

function normalizeAliases(input: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input) {
    const alias = (raw ?? "").trim();
    if (alias.length < MIN_ALIAS_LENGTH) continue;
    const key = alias.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(alias);
  }
  return out;
}

function revalidatePerson(personId: string) {
  revalidatePath("/people");
  revalidatePath(`/people/${personId}`);
}

async function requireUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return { supabase, user };
}

export async function createPerson(name: string) {
  const trimmed = name?.trim();
  if (!trimmed) return { error: "name required" };

  const { supabase, user } = await requireUser();
  if (!user) return { error: "not authenticated" };

  const { data, error } = await supabase
    .from("people")
    .insert({
      user_id: user.id,
      name: trimmed,
      // A hand-created person has no note — the whole point of the nullable
      // column. The sync adopts this row if a note by that name later appears.
      vault_path: null,
      // Same seed as the vault sync and the MCP create op, so all three
      // creation paths leave identical rows and M4's matcher sees no drift.
      aliases: seedAliases(trimmed),
      updated_at: nowStamp(),
    })
    .select(PEOPLE_COLUMNS)
    .single();

  if (error) {
    if (error.code === UNIQUE_VIOLATION) return { error: nameTaken(trimmed) };
    return { error: error.message };
  }

  revalidatePath("/people");
  return { error: null, person: data };
}

// occurredAt is REQUIRED from the caller: it lands in a `date` column, so it
// persists instead of healing on hydration, and a server-derived day would be
// the UTC process clock. The page passes its own resolved `today`.
export async function logInteraction(input: {
  personId: string;
  summary?: string | null;
  occurredAt: string;
  precision?: "exact" | "approx";
}) {
  if (!input.personId) return { error: "person required" };
  if (!DATE_KEY_RE.test(input.occurredAt ?? "")) {
    return { error: "invalid date" };
  }
  const precision = input.precision ?? "exact";
  if (!PRECISIONS.has(precision)) return { error: "invalid precision" };

  const { supabase, user } = await requireUser();
  if (!user) return { error: "not authenticated" };

  // The insert's RLS check only proves the ROW is the caller's; nothing at the
  // database level ties person_id to the same owner (§5, the accepted composite
  // -FK gap), so the ownership check happens here.
  const { data: person } = await supabase
    .from("people")
    .select("id")
    .eq("user_id", user.id)
    .eq("id", input.personId)
    .maybeSingle();
  if (!person) return { error: "person not found" };

  const summary = input.summary?.trim() || null;
  const { data, error } = await supabase
    .from("person_interactions")
    .insert({
      user_id: user.id,
      person_id: input.personId,
      summary,
      occurred_at: input.occurredAt,
      occurred_precision: precision,
      source: "logged",
    })
    .select(INTERACTION_COLUMNS)
    .single();

  if (error) return { error: error.message };

  revalidatePerson(input.personId);
  return { error: null, interaction: data };
}

export async function updateInteraction(input: {
  interactionId: string;
  summary?: string | null;
  occurredAt?: string;
  precision?: "exact" | "approx";
}) {
  const { supabase, user } = await requireUser();
  if (!user) return { error: "not authenticated" };

  const updates: Record<string, unknown> = {};
  if (input.summary !== undefined) {
    updates.summary = input.summary?.trim() || null;
  }
  if (input.occurredAt !== undefined) {
    if (!DATE_KEY_RE.test(input.occurredAt)) return { error: "invalid date" };
    updates.occurred_at = input.occurredAt;
  }
  if (input.precision !== undefined) {
    if (!PRECISIONS.has(input.precision)) return { error: "invalid precision" };
    updates.occurred_precision = input.precision;
  }
  if (Object.keys(updates).length === 0) return { error: null };

  const { data, error } = await supabase
    .from("person_interactions")
    .update(updates)
    .eq("user_id", user.id)
    .eq("id", input.interactionId)
    .select(INTERACTION_COLUMNS)
    .maybeSingle();

  if (error) return { error: error.message };
  if (!data) return { error: "interaction not found" };

  revalidatePerson((data as { person_id: string }).person_id);
  return { error: null, interaction: data };
}

export async function deleteInteraction(id: string) {
  const { supabase, user } = await requireUser();
  if (!user) return { error: "not authenticated" };

  const { data, error } = await supabase
    .from("person_interactions")
    .delete()
    .eq("user_id", user.id)
    .eq("id", id)
    .select("person_id")
    .maybeSingle();

  if (error) return { error: error.message };
  if (!data) return { error: "interaction not found" };

  revalidatePerson((data as { person_id: string }).person_id);
  return { error: null };
}

export async function archivePerson(id: string) {
  const { supabase, user } = await requireUser();
  if (!user) return { error: "not authenticated" };

  const stamp = nowStamp();
  const { error } = await supabase
    .from("people")
    .update({ archived: true, archived_at: stamp, updated_at: stamp })
    .eq("user_id", user.id)
    .eq("id", id);

  if (error) return { error: error.message };

  revalidatePerson(id);
  return { error: null };
}

export async function restorePerson(id: string) {
  const { supabase, user } = await requireUser();
  if (!user) return { error: "not authenticated" };

  const { data: existing } = await supabase
    .from("people")
    .select("name")
    .eq("user_id", user.id)
    .eq("id", id)
    .maybeSingle();

  const stamp = nowStamp();
  const { error } = await supabase
    .from("people")
    .update({ archived: false, archived_at: null, updated_at: stamp })
    .eq("user_id", user.id)
    .eq("id", id);

  if (error) {
    // people_user_name_key is partial on `not archived`, so un-archiving is the
    // one update that can collide with a live person of the same name.
    if (error.code === UNIQUE_VIOLATION) {
      return {
        error: nameTaken((existing as { name: string } | null)?.name ?? "person"),
      };
    }
    return { error: error.message };
  }

  revalidatePerson(id);
  return { error: null };
}

// What a hard delete would cascade away, so the confirm can name it
// ("delete davi and 14 logged conversations?") instead of using generic copy.
export async function getDeleteImpact(personId: string) {
  const { supabase, user } = await requireUser();
  if (!user) return { error: "not authenticated", name: null, interactions: 0 };

  const { data: person } = await supabase
    .from("people")
    .select("name")
    .eq("user_id", user.id)
    .eq("id", personId)
    .maybeSingle();
  if (!person) {
    return { error: "person not found", name: null, interactions: 0 };
  }

  const { count } = await supabase
    .from("person_interactions")
    .select("id", { count: "exact", head: true })
    .eq("user_id", user.id)
    .eq("person_id", personId);

  return {
    error: null,
    name: (person as { name: string }).name,
    interactions: count ?? 0,
  };
}

// Hard delete. Cascades the interaction log — the one signal the doctrine
// treats as precision-critical — which is why archive is the default path and
// the caller must have shown getDeleteImpact's count first.
export async function deletePerson(id: string) {
  const { supabase, user } = await requireUser();
  if (!user) return { error: "not authenticated" };

  const { error } = await supabase
    .from("people")
    .delete()
    .eq("user_id", user.id)
    .eq("id", id);

  if (error) return { error: error.message };

  revalidatePath("/people");
  return { error: null };
}

export async function updatePersonName(id: string, name: string) {
  const trimmed = name?.trim();
  if (!trimmed) return { error: "name required" };

  const { supabase, user } = await requireUser();
  if (!user) return { error: "not authenticated" };

  const { error } = await supabase
    .from("people")
    .update({ name: trimmed, updated_at: nowStamp() })
    .eq("user_id", user.id)
    .eq("id", id);

  if (error) {
    if (error.code === UNIQUE_VIOLATION) return { error: nameTaken(trimmed) };
    return { error: error.message };
  }

  revalidatePerson(id);
  return { error: null };
}

export async function updatePersonAliases(id: string, aliases: string[]) {
  const { supabase, user } = await requireUser();
  if (!user) return { error: "not authenticated" };

  const normalized = normalizeAliases(aliases ?? []);
  const { error } = await supabase
    .from("people")
    .update({ aliases: normalized, updated_at: nowStamp() })
    .eq("user_id", user.id)
    .eq("id", id);

  if (error) return { error: error.message };

  revalidatePerson(id);
  return { error: null };
}

// The first-run seeding checklist (§5). The vault exposes no marker for the
// user's own note and no predicate separates it from the other person notes, so
// the answer is asked for rather than guessed.
//
// COMPLETION IS PERSISTED AS THE ROWS THEMSELVES: a row is written for EVERY
// listed path — included ones active, excluded ones archived with archived_at
// stamped. An archived row still holds its vault_path, so the sync's
// ignoreDuplicates upsert never re-adds an excluded note, the roster hides it
// in "not tracking", and restore un-archives it. seedingDone() is then simply
// "any row carries a vault_path", which stays true even when the user excluded
// everything. No marker column, and no second source of truth to drift.
export async function confirmSeeding(
  selections: { path: string; include: boolean }[],
) {
  const { supabase, user } = await requireUser();
  if (!user) return { error: "not authenticated" };

  const stamp = nowStamp();
  const seen = new Set<string>();
  const rows: {
    user_id: string;
    name: string;
    vault_path: string | null;
    aliases: string[];
    archived: boolean;
    archived_at: string | null;
    updated_at: string;
  }[] = [];

  const curated = await readCuratedAliases(supabase, user.id);

  for (const selection of selections ?? []) {
    const path = selection?.path?.trim();
    if (!path) continue;
    // The path is written straight into vault_path, so it is validated rather
    // than trusted: this action is a public POST endpoint.
    if (!path.startsWith(`${PEOPLE_FOLDER}/`)) continue;
    if (!/\.md$/i.test(path)) continue;
    const key = path.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const name = noteTitle(path);
    if (!name) continue;
    rows.push({
      user_id: user.id,
      name,
      vault_path: path,
      aliases: seedAliases(name, curated.get(key)),
      archived: !selection.include,
      archived_at: selection.include ? null : stamp,
      updated_at: stamp,
    });
  }

  try {
    await upsertPeopleRows(supabase, rows);
  } catch (error) {
    return { error: error instanceof Error ? error.message : "seeding failed" };
  }

  revalidatePath("/people");
  return { error: null, seeded: rows.length };
}
