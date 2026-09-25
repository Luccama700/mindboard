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
  const { data, error } = await homeDb()
    .from("chores")
    .select("id, name, frequency, interval_days, assigned_to, assignees, due_date")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as HomeChore | null) ?? null;
}

async function feedingState(now: Date) {
  const db = homeDb();
  const { data: s, error } = await db.from("household_settings").select("morning_time, evening_time").eq("id", 1).single();
  if (error || !s) throw new Error(error?.message ?? "household settings missing");
  const slot = feedingSlot(now, s.morning_time, s.evening_time);
  const fedOn = vanToday(now);
  const { data: prior, error: pErr } = await db
    .from("feedings")
    .select("fed_by, fed_at")
    .eq("fed_on", fedOn)
    .eq("slot", slot)
    .order("fed_at", { ascending: false });
  if (pErr) throw new Error(pErr.message);
  return { slot, fedOn, prior: (prior ?? []) as { fed_by: string; fed_at: string }[] };
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
  // Store the request, not the built row: confirm re-merges it onto the chore as it is
  // then, so a completion or a housemate's edit in between isn't reverted.
  return propose(userId, "home_upsert_chore", { input }, summary);
}

export async function proposeHomeDeleteChore(userId: string, choreId: string): Promise<Result<Proposal>> {
  await resolveMember(userId);
  const chore = await loadChore(choreId);
  if (!chore) return { ok: false, error: "chore not found" };
  return propose(userId, "home_delete_chore", { choreId }, `Delete home chore "${chore.name}" (its history stays).`);
}

export async function proposeHomeLogFeeding(userId: string): Promise<Result<Proposal>> {
  const { member, members } = await resolveMember(userId);
  const { slot, fedOn, prior } = await feedingState(new Date());
  const already = prior[0];
  const warn = already
    ? ` Heads up: ${members.find((m) => m.id === already.fed_by)?.name ?? "someone"} already fed her this ${slot} at ${vanTime(already.fed_at)}.`
    : "";
  return propose(
    userId,
    "home_log_feeding",
    { slot, fedOn, priorCount: prior.length },
    `Log that ${member.name} fed the cat (${slot}).${warn}`,
  );
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

const executeUpsert: Executor = async (_s, ownerId, stored) => {
  const { members } = await resolveMember(ownerId);
  const input = (stored.input ?? {}) as ChoreUpsertInput;
  const existing = input.choreId ? await loadChore(input.choreId) : null;
  if (input.choreId && !existing) return { ok: false, error: "chore not found" };
  const built = buildChoreRow(input, existing, members, vanToday());
  if (!built.ok) return built;
  const row: ChoreRow = built.value;
  const db = homeDb();
  const { data, error } = existing
    ? await db.from("chores").update(row).eq("id", existing.id).select("id").maybeSingle()
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

const executeFeeding: Executor = async (_s, ownerId, input) => {
  const { member, members } = await resolveMember(ownerId);
  const now = new Date();
  const { slot, fedOn, prior } = await feedingState(now);
  // What was previewed must still hold; otherwise make the caller look again.
  if (slot !== input.slot || fedOn !== input.fedOn) {
    return { ok: false, error: `it's now the ${slot} slot on ${fedOn}; propose the feeding again` };
  }
  if (prior.length > Number(input.priorCount ?? 0)) {
    const who = members.find((m) => m.id === prior[0].fed_by)?.name ?? "someone";
    return { ok: false, error: `${who} logged a ${slot} feeding at ${vanTime(prior[0].fed_at)} since the proposal; propose again if you still want to log one` };
  }
  const { error } = await homeDb()
    .from("feedings")
    .insert({ fed_by: member.id, fed_at: now.toISOString(), fed_on: fedOn, slot });
  if (error) return { ok: false, error: error.message };
  return { ok: true, value: { fedBy: member.name, slot, at: vanTime(now.toISOString()) } };
};

export const HOME_EXECUTORS: Record<string, Executor> = {
  home_complete_chore: executeComplete,
  home_upsert_chore: executeUpsert,
  home_delete_chore: executeDelete,
  home_log_feeding: executeFeeding,
};
