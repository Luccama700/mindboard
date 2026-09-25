import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { recordProposal } from "@/app/lib/mcp/audit";
import type { Result } from "@/app/lib/mcp/validate";
import { createServiceClient } from "@/utils/supabase/service";
import { homeDb, resolveMember } from "./db";
import {
  addDays,
  buildChoreRow,
  feedingSlot,
  nextUpAfter,
  stepDays,
  summarizeChoreRow,
  vanTime,
  vanToday,
  type ChoreRow,
  type ChoreUpsertInput,
  type HomeChore,
} from "./logic";

// Home-app writes follow Mindboard's propose → confirm rule: propose* records
// a 'proposed' ai_audit_log row (in Mindboard's DB) and touches nothing; the
// shared confirm_action runs the matching HOME_EXECUTORS entry, which
// re-checks household membership before writing to the home app's DB.

type Proposal = { proposalId: string; preview: string };

async function loadChore(id: string): Promise<HomeChore | null> {
  const { data } = await homeDb()
    .from("chores")
    .select("id, name, frequency, interval_days, assigned_to, assignees, due_date")
    .eq("id", id)
    .maybeSingle();
  return (data as HomeChore | null) ?? null;
}

async function propose(userId: string, tool: string, input: Record<string, unknown>, summary: string) {
  const proposalId = await recordProposal(createServiceClient(), userId, tool, input, summary);
  return { ok: true as const, value: { proposalId, preview: summary } };
}

export async function proposeHomeCompleteChore(userId: string, choreId: string): Promise<Result<Proposal>> {
  const { member, members } = await resolveMember(userId);
  const chore = await loadChore(choreId);
  if (!chore) return { ok: false, error: "chore not found" };
  const next = nextUpAfter(chore, members, member.id);
  const due = addDays(vanToday(), stepDays(chore));
  const summary = `Mark home chore "${chore.name}" done by ${member.name}; next up ${next?.name ?? "nobody"}, due ${due}.`;
  return propose(userId, "home_complete_chore", { choreId }, summary);
}

export async function proposeHomeUpsertChore(userId: string, input: ChoreUpsertInput): Promise<Result<Proposal>> {
  const { members } = await resolveMember(userId);
  const existing = input.choreId ? await loadChore(input.choreId) : null;
  if (input.choreId && !existing) return { ok: false, error: "chore not found" };
  const row = buildChoreRow(input, existing, members, vanToday());
  if (!row.ok) return row;
  const summary = summarizeChoreRow(row.value, members, !existing);
  return propose(userId, "home_upsert_chore", { choreId: existing?.id ?? null, row: row.value }, summary);
}

export async function proposeHomeDeleteChore(userId: string, choreId: string): Promise<Result<Proposal>> {
  await resolveMember(userId);
  const chore = await loadChore(choreId);
  if (!chore) return { ok: false, error: "chore not found" };
  return propose(userId, "home_delete_chore", { choreId }, `Delete home chore "${chore.name}" (its history stays).`);
}

export async function proposeHomeLogFeeding(userId: string): Promise<Result<Proposal>> {
  const { member, members } = await resolveMember(userId);
  const db = homeDb();
  const now = new Date();
  const { data: s, error } = await db.from("household_settings").select("morning_time, evening_time").eq("id", 1).single();
  if (error || !s) return { ok: false, error: error?.message ?? "household settings missing" };
  const slot = feedingSlot(now, s.morning_time, s.evening_time);
  const { data: prior } = await db
    .from("feedings")
    .select("fed_by, fed_at")
    .eq("fed_on", vanToday(now))
    .eq("slot", slot)
    .order("fed_at", { ascending: false })
    .limit(1);
  const already = (prior ?? [])[0] as { fed_by: string; fed_at: string } | undefined;
  const warn = already
    ? ` Heads up: ${members.find((m) => m.id === already.fed_by)?.name ?? "someone"} already fed her this ${slot} at ${vanTime(already.fed_at)}.`
    : "";
  return propose(userId, "home_log_feeding", {}, `Log that ${member.name} fed Taiga (${slot}).${warn}`);
}

// ---------- executors (run by confirm_action) ----------

type Executor = (
  supabase: SupabaseClient,
  ownerId: string,
  input: Record<string, unknown>,
) => Promise<Result<Record<string, unknown>>>;

const executeComplete: Executor = async (_s, ownerId, input) => {
  const { member, members } = await resolveMember(ownerId);
  const choreId = String(input.choreId ?? "");
  const { error } = await homeDb().rpc("complete_chore_as", { p_chore_id: choreId, p_actor: member.id });
  if (error) return { ok: false, error: error.message };
  const after = await loadChore(choreId);
  return {
    ok: true,
    value: {
      chore: after?.name,
      doneBy: member.name,
      nextUp: members.find((m) => m.id === after?.assigned_to)?.name ?? null,
      nextDue: after?.due_date ?? null,
    },
  };
};

const executeUpsert: Executor = async (_s, ownerId, input) => {
  await resolveMember(ownerId);
  const row = input.row as ChoreRow;
  const choreId = typeof input.choreId === "string" ? input.choreId : null;
  const db = homeDb();
  const { data, error } = choreId
    ? await db.from("chores").update(row).eq("id", choreId).select("id").maybeSingle()
    : await db.from("chores").insert(row).select("id").single();
  if (error) return { ok: false, error: error.message };
  if (!data) return { ok: false, error: "chore not found" };
  return { ok: true, value: { choreId: (data as { id: string }).id, name: row.name } };
};

const executeDelete: Executor = async (_s, ownerId, input) => {
  await resolveMember(ownerId);
  const { data, error } = await homeDb()
    .from("chores")
    .delete()
    .eq("id", String(input.choreId ?? ""))
    .select("name");
  if (error) return { ok: false, error: error.message };
  if (!data?.length) return { ok: false, error: "chore not found" };
  return { ok: true, value: { deleted: (data[0] as { name: string }).name } };
};

const executeFeeding: Executor = async (_s, ownerId) => {
  const { member } = await resolveMember(ownerId);
  const db = homeDb();
  const now = new Date();
  const { data: s, error: sErr } = await db.from("household_settings").select("morning_time, evening_time").eq("id", 1).single();
  if (sErr || !s) return { ok: false, error: sErr?.message ?? "household settings missing" };
  const slot = feedingSlot(now, s.morning_time, s.evening_time);
  const { error } = await db
    .from("feedings")
    .insert({ fed_by: member.id, fed_at: now.toISOString(), fed_on: vanToday(now), slot });
  if (error) return { ok: false, error: error.message };
  return { ok: true, value: { fedBy: member.name, slot, at: vanTime(now.toISOString()) } };
};

export const HOME_EXECUTORS: Record<string, Executor> = {
  home_complete_chore: executeComplete,
  home_upsert_chore: executeUpsert,
  home_delete_chore: executeDelete,
  home_log_feeding: executeFeeding,
};
