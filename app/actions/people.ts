"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/utils/supabase/server";
import { noteTitle } from "@/app/lib/brain/parse";
import { todayKey } from "@/app/lib/mcp/config";
import { addDaysKey } from "@/app/_components/finance-projection";
import type { BackfillResult } from "@/app/lib/snapshots/people";
import {
  PEOPLE_FOLDER,
  readCuratedAliases,
  seedAliases,
  upsertPeopleRows,
} from "@/app/lib/people/sync";
import { suggestPeopleGroups } from "@/app/lib/people/suggest-groups";
import { loadProposal } from "@/app/lib/mcp/audit";
import { cancelProposal, confirmProposal } from "@/app/actions/assistant";

// User-initiated People writes. Every row that touches a `people` record sets
// updated_at explicitly — no triggers exist in this codebase to do it
// (docs/people-plan.md §10). person_interactions has no updated_at column, so
// interaction edits deliberately set none.

const PEOPLE_COLUMNS =
  "id, name, vault_path, aliases, group_id, checkin_days, attention_snoozed_until, archived, archived_at, created_at, updated_at";
const GROUP_COLUMNS = "id, name, color, created_at";
const INTERACTION_COLUMNS =
  "id, person_id, summary, occurred_at, occurred_precision, source, created_at";

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
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

function groupNameTaken(name: string): string {
  return `you already have a ${name} group`;
}

// Bounded on purpose, not just tidied: every alias compiles to a regex that the
// mention scan runs against every new session inside after(). An unbounded list
// is a self-inflicted denial of service on the user's own page load, and a
// 400-character "alias" cannot be a name anyway.
const MAX_ALIASES = 10;
const MAX_ALIAS_LENGTH = 40;
// Same ceiling the agent path enforces (MAX_NAME_LENGTH in
// app/lib/mcp/people-ops.ts): three write surfaces, one column, one limit.
const MAX_NAME_LENGTH = 120;

function normalizeAliases(input: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input) {
    const alias = (raw ?? "").trim();
    if (alias.length < MIN_ALIAS_LENGTH) continue;
    if (alias.length > MAX_ALIAS_LENGTH) continue;
    const key = alias.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(alias);
    if (out.length >= MAX_ALIASES) break;
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
  if (trimmed.length > MAX_NAME_LENGTH) return { error: "name too long" };

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

  // A conversation cannot have happened tomorrow, and a future row is not a
  // harmless typo: daysSinceTalked goes NEGATIVE, which is never greater than
  // any cadence, so the person is silenced until that day passes. Same guard as
  // setPersonCadence and confirmCandidate, against the owner's zone day.
  const today = await todayKey(supabase, user.id);
  if (input.occurredAt > today) {
    return { error: "that day hasn't happened yet" };
  }

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
    // Editing a row into the future silences the person exactly as inserting
    // one there does — same guard, same reason.
    const today = await todayKey(supabase, user.id);
    if (input.occurredAt > today) {
      return { error: "that day hasn't happened yet" };
    }
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
  if (trimmed.length > MAX_NAME_LENGTH) return { error: "name too long" };

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

// Setting a cadence and seeding its baseline are ONE action, and the pairing is
// load-bearing (docs/people-plan.md §10 M3): if the cadence lands and the
// backfill row does not, the person has a cadence with no logged interaction —
// which §7's exclusion rule silently suppresses, producing a cadence the user
// set that never fires, with nothing on screen to explain it.
//
// supabase-js has no client-side transactions, so atomicity here is a
// COMPENSATING revert, not a real one: on insert failure the previous
// checkin_days is written back and the failure is surfaced. That leaves one
// unhandled window — if the revert itself fails, the half-applied state stands —
// which is why the error is returned rather than swallowed.
//
// `backfill` is the resolved chip, not the chip name: the page owns the
// today-arithmetic (backfillToDate in app/lib/snapshots/people.ts, shared with
// the chip UI so the two cannot drift), because the day lands in a `date`
// column and a server-derived one would be the UTC process clock. null =
// "not sure", a legitimate terminal state that writes no row.
export async function setPersonCadence(input: {
  personId: string;
  checkinDays: number | null;
  backfill: BackfillResult | null;
}) {
  if (!input.personId) return { error: "person required" };
  if (
    input.checkinDays !== null &&
    (!Number.isInteger(input.checkinDays) ||
      input.checkinDays <= 0 ||
      // Same ceiling the agent path enforces (MAX_CHECKIN_DAYS in
      // app/lib/mcp/people-ops.ts): the two write surfaces must not accept
      // different cadences for the same column.
      input.checkinDays > 3650)
  ) {
    return { error: "cadence must be a positive whole number of days" };
  }

  const { supabase, user } = await requireUser();
  if (!user) return { error: "not authenticated" };

  const backfill = input.backfill;
  if (backfill) {
    if (!DATE_KEY_RE.test(backfill.occurredAt ?? "")) {
      return { error: "invalid date" };
    }
    if (!PRECISIONS.has(backfill.precision)) {
      return { error: "invalid precision" };
    }
    // A conversation cannot have happened tomorrow. Compared against the
    // owner's zone day, not the process clock.
    const today = await todayKey(supabase, user.id);
    if (backfill.occurredAt > today) {
      return { error: "that day hasn't happened yet" };
    }
  }

  const { data: existing } = await supabase
    .from("people")
    .select("checkin_days")
    .eq("user_id", user.id)
    .eq("id", input.personId)
    .maybeSingle();
  if (!existing) return { error: "person not found" };
  const previous = (existing as { checkin_days: number | null }).checkin_days;

  const { error: cadenceError } = await supabase
    .from("people")
    .update({ checkin_days: input.checkinDays, updated_at: nowStamp() })
    .eq("user_id", user.id)
    .eq("id", input.personId);
  if (cadenceError) return { error: cadenceError.message };

  if (backfill) {
    const { error: logError } = await supabase
      .from("person_interactions")
      .insert({
        user_id: user.id,
        person_id: input.personId,
        summary: null,
        occurred_at: backfill.occurredAt,
        occurred_precision: backfill.precision,
        source: "logged",
      });
    if (logError) {
      await supabase
        .from("people")
        .update({ checkin_days: previous, updated_at: nowStamp() })
        .eq("user_id", user.id)
        .eq("id", input.personId);
      return { error: logError.message };
    }
  }

  revalidatePerson(input.personId);
  return { error: null };
}

// A persisted "not now" (§8). Dismissal has to be state: a suggestion that
// reappears on reload or on another device is exactly the nagging principle 8
// forbids, which is why this is a column and not component state.
const SNOOZE_DAYS = 7;

export async function snoozePerson(personId: string) {
  if (!personId) return { error: "person required" };

  const { supabase, user } = await requireUser();
  if (!user) return { error: "not authenticated" };

  // Resolved in the owner's zone, like app/actions/finance.ts does, because the
  // value lands in a `date` column — the process clock is UTC on Vercel, so a
  // late-evening dismissal would otherwise snooze from tomorrow.
  const today = await todayKey(supabase, user.id);
  const until = addDaysKey(today, SNOOZE_DAYS);

  const { error } = await supabase
    .from("people")
    .update({ attention_snoozed_until: until, updated_at: nowStamp() })
    .eq("user_id", user.id)
    .eq("id", personId);

  if (error) return { error: error.message };

  revalidatePerson(personId);
  return { error: null, until };
}

export async function unsnoozePerson(personId: string) {
  if (!personId) return { error: "person required" };

  const { supabase, user } = await requireUser();
  if (!user) return { error: "not authenticated" };

  const { error } = await supabase
    .from("people")
    .update({ attention_snoozed_until: null, updated_at: nowStamp() })
    .eq("user_id", user.id)
    .eq("id", personId);

  if (error) return { error: error.message };

  revalidatePerson(personId);
  return { error: null };
}

// Promote a mention candidate to a real interaction (§10 M4).
//
// CONFIRMATION ASKS TWO QUESTIONS, NOT ONE. A tap establishes THAT a mention
// describes contact; it frequently cannot establish WHEN — a session dated
// Aug 11 may say "I talked to Davi last month". So the caller passes the day it
// asked the user for, and silently adopting the evidence date would be the
// fabricated precision this doctrine exists to refuse.
//
// INSERT FIRST, FLIP SECOND — deliberately not setPersonCadence's revert
// pattern, because this ordering needs no compensation: if the flip fails after
// the insert, the candidate stays 'new' and a re-tap converges (the interaction
// insert hits person_interactions_confirmed_key and is treated as success, then
// the flip retries). The reverse order could mark a candidate reviewed with no
// interaction behind it, which is unrecoverable from the UI.
export async function confirmCandidate(input: {
  candidateId: string;
  occurredAt: string;
  precision: "exact" | "approx";
}) {
  if (!input.candidateId) return { error: "candidate required" };
  if (!DATE_KEY_RE.test(input.occurredAt ?? "")) return { error: "invalid date" };
  if (!PRECISIONS.has(input.precision)) return { error: "invalid precision" };

  const { supabase, user } = await requireUser();
  if (!user) return { error: "not authenticated" };

  // User-scoped, so the person's ownership is inherited — a candidate row and
  // its person always share a user_id by construction of the scan.
  const { data: candidate } = await supabase
    .from("person_mention_candidates")
    .select("id, person_id, status")
    .eq("user_id", user.id)
    .eq("id", input.candidateId)
    .maybeSingle();
  if (!candidate) return { error: "candidate not found" };
  const row = candidate as { person_id: string; status: string };

  const today = await todayKey(supabase, user.id);
  if (input.occurredAt > today) return { error: "that day hasn't happened yet" };

  const { error: insertError } = await supabase
    .from("person_interactions")
    .insert({
      user_id: user.id,
      person_id: row.person_id,
      summary: null,
      occurred_at: input.occurredAt,
      occurred_precision: input.precision,
      // 'confirmed' = promoted from a mention by an explicit tap. The page shows
      // this; it is how "you confirmed it from a mention" stays distinguishable
      // from "you logged it".
      source: "confirmed",
    });
  // person_interactions_confirmed_key makes a double tap a no-op rather than a
  // duplicate row, so a unique violation here IS the success case.
  if (insertError && insertError.code !== UNIQUE_VIOLATION) {
    return { error: insertError.message };
  }

  const { error: flipError } = await supabase
    .from("person_mention_candidates")
    .update({ status: "confirmed", reviewed_at: nowStamp() })
    .eq("user_id", user.id)
    .eq("id", input.candidateId);
  if (flipError) return { error: flipError.message };

  revalidatePerson(row.person_id);
  return { error: null };
}

// Dismissing settles a candidate without asserting anything. One idempotent
// update: re-tapping a dismissed row is a no-op.
export async function dismissCandidate(candidateId: string) {
  if (!candidateId) return { error: "candidate required" };

  const { supabase, user } = await requireUser();
  if (!user) return { error: "not authenticated" };

  const { data, error } = await supabase
    .from("person_mention_candidates")
    .update({ status: "dismissed", reviewed_at: nowStamp() })
    .eq("user_id", user.id)
    .eq("id", candidateId)
    .select("person_id")
    .maybeSingle();

  if (error) return { error: error.message };
  if (!data) return { error: "candidate not found" };

  revalidatePerson((data as { person_id: string }).person_id);
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

  let seeded = 0;
  try {
    // The WRITTEN count, not rows.length: name collisions are skipped by design
    // and an already-linked path is a no-op, so reporting the input size would
    // claim people the roster does not have.
    seeded = await upsertPeopleRows(supabase, rows);
  } catch (error) {
    return { error: error instanceof Error ? error.message : "seeding failed" };
  }

  revalidatePath("/people");
  return { error: null, seeded };
}

// ---------- groups ----------
//
// Groups are optional CONTEXTS (family / ubc / work), never closeness tiers —
// see the header of 0049_people_groups.sql. Nothing below can enforce that; the
// UI copy and the suggester's prompt carry the rule.

export async function createPeopleGroup(name: string, color: string) {
  const trimmed = name?.trim();
  if (!trimmed) return { error: "name required" };
  if (trimmed.length > MAX_NAME_LENGTH) return { error: "name too long" };
  // The value is fed straight into an inline style, so it is validated rather
  // than trusted: this action is a public POST endpoint.
  if (!HEX_COLOR_RE.test(color ?? "")) return { error: "invalid color" };

  const { supabase, user } = await requireUser();
  if (!user) return { error: "not authenticated" };

  const { data, error } = await supabase
    .from("people_groups")
    .insert({ user_id: user.id, name: trimmed, color })
    .select(GROUP_COLUMNS)
    .single();

  if (error) {
    if (error.code === UNIQUE_VIOLATION) return { error: groupNameTaken(trimmed) };
    return { error: error.message };
  }

  revalidatePath("/people");
  return { error: null, group: data };
}

export async function updatePeopleGroup(
  groupId: string,
  updates: { name?: string; color?: string },
) {
  if (!groupId) return { error: "group required" };

  const patch: Record<string, unknown> = {};
  if (updates.name !== undefined) {
    const trimmed = updates.name?.trim();
    if (!trimmed) return { error: "name required" };
    if (trimmed.length > MAX_NAME_LENGTH) return { error: "name too long" };
    patch.name = trimmed;
  }
  if (updates.color !== undefined) {
    if (!HEX_COLOR_RE.test(updates.color ?? "")) return { error: "invalid color" };
    patch.color = updates.color;
  }
  if (Object.keys(patch).length === 0) return { error: null };

  const { supabase, user } = await requireUser();
  if (!user) return { error: "not authenticated" };

  const { data, error } = await supabase
    .from("people_groups")
    .update(patch)
    .eq("user_id", user.id)
    .eq("id", groupId)
    .select(GROUP_COLUMNS)
    .maybeSingle();

  if (error) {
    if (error.code === UNIQUE_VIOLATION) {
      return { error: groupNameTaken(String(patch.name ?? "that")) };
    }
    return { error: error.message };
  }
  if (!data) return { error: "group not found" };

  revalidatePath("/people");
  return { error: null, group: data };
}

// people.group_id is ON DELETE SET NULL, so deleting a context never deletes
// the people in it — they just become unassigned. The member count is returned
// so the confirm can say "delete family? 6 people become ungrouped" instead of
// generic copy (the getDeleteImpact pattern), and it is counted BEFORE the
// delete because afterwards there is nothing left to count.
export async function deletePeopleGroup(groupId: string) {
  if (!groupId) return { error: "group required", members: 0 };

  const { supabase, user } = await requireUser();
  if (!user) return { error: "not authenticated", members: 0 };

  const { count } = await supabase
    .from("people")
    .select("id", { count: "exact", head: true })
    .eq("user_id", user.id)
    .eq("group_id", groupId);

  const { error } = await supabase
    .from("people_groups")
    .delete()
    .eq("user_id", user.id)
    .eq("id", groupId);

  if (error) return { error: error.message, members: 0 };

  revalidatePath("/people");
  return { error: null, members: count ?? 0 };
}

export async function setPersonGroup(personId: string, groupId: string | null) {
  if (!personId) return { error: "person required" };

  const { supabase, user } = await requireUser();
  if (!user) return { error: "not authenticated" };

  // Foreign keys do not run through RLS, so nothing at the database level stops
  // this row pointing at ANOTHER tenant's group id. Same accepted composite-FK
  // gap logInteraction guards against, guarded the same way: in code.
  if (groupId) {
    const { data: group } = await supabase
      .from("people_groups")
      .select("id")
      .eq("user_id", user.id)
      .eq("id", groupId)
      .maybeSingle();
    if (!group) return { error: "group not found" };
  }

  const { data, error } = await supabase
    .from("people")
    .update({ group_id: groupId, updated_at: nowStamp() })
    .eq("user_id", user.id)
    .eq("id", personId)
    .select("id")
    .maybeSingle();

  if (error) return { error: error.message };
  if (!data) return { error: "person not found" };

  revalidatePerson(personId);
  return { error: null };
}

// ---------- AI group suggestions ----------

// "Sort my people into groups": one Claude call on the user's stored key, then
// the ordinary update_people propose → confirm rail. userId comes from the
// session and is NEVER a parameter — every export here is a public POST
// endpoint, so a caller-supplied id would be a cross-tenant write.
export async function proposeGroupSuggestions(): Promise<{
  error: string | null;
  proposalId?: string;
  receipt?: string;
}> {
  const { user } = await requireUser();
  if (!user) return { error: "not authenticated" };

  const outcome = await suggestPeopleGroups(user.id);
  if (!outcome.ok) return { error: outcome.error };
  return {
    error: null,
    proposalId: outcome.value.proposalId,
    receipt: outcome.value.preview,
  };
}

// The page's confirm/reject rail. These delegate to the assistant's own
// confirm/cancel — the SAME EXECUTORS entry the MCP server and the in-app
// assistant use, so there is exactly one apply path — and add a tool-name guard
// so a /people control can only ever resolve a people proposal.
export async function confirmPeopleProposal(proposalId: string): Promise<{
  error: string | null;
  receipt?: string;
}> {
  if (!proposalId) return { error: "proposal required" };

  const { supabase, user } = await requireUser();
  if (!user) return { error: "not authenticated" };

  const proposal = await loadProposal(supabase, user.id, proposalId);
  if (!proposal) return { error: "proposal not found or already resolved" };
  if (proposal.tool_name !== "update_people") {
    return { error: "that proposal isn't a people change" };
  }

  const result = await confirmProposal(proposalId);
  return { error: result.error, receipt: result.preview };
}

export async function rejectPeopleProposal(
  proposalId: string,
): Promise<{ error: string | null }> {
  if (!proposalId) return { error: "proposal required" };

  const { supabase, user } = await requireUser();
  if (!user) return { error: "not authenticated" };

  const proposal = await loadProposal(supabase, user.id, proposalId);
  if (!proposal) return { error: "proposal not found or already resolved" };
  if (proposal.tool_name !== "update_people") {
    return { error: "that proposal isn't a people change" };
  }

  return cancelProposal(proposalId);
}
