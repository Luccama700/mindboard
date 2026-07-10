"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "@/utils/supabase/server";
import {
  claimProposal,
  finalizeClaimedProposal,
  loadProposal,
  resolveProposal,
} from "@/app/lib/mcp/audit";
import { EXECUTORS } from "@/app/lib/mcp/writes";
import type { Result } from "@/app/lib/mcp/validate";
import { pushTaskToCalendar, updateTask } from "@/app/actions/tasks";

// Key save/clear moved to app/actions/connections.ts (the unified provider-key
// path shared by every connection card).

// ---- confirm / cancel: the only paths on which an assistant write executes.

async function executeScheduleTask(
  userId: string,
  input: Record<string, unknown>,
): Promise<Result<Record<string, unknown>>> {
  const taskId = String(input.taskId ?? "");
  const dueDate = String(input.dueDate ?? "");
  const dueTime = String(input.dueTime ?? "");
  const durationMin = Number(input.durationMin ?? 30);

  const updated = await updateTask({
    id: taskId,
    dueDate,
    dueTime,
    durationMin,
  });
  if (updated.error) return { ok: false, error: updated.error };

  if (input.pushToCalendar === true) {
    const pushed = await pushTaskToCalendar(taskId);
    if (pushed.error && pushed.error !== "already on the calendar") {
      return {
        ok: true,
        value: { scheduled: true, calendarPushFailed: pushed.error },
      };
    }
    return { ok: true, value: { scheduled: true, pushed: true } };
  }
  return { ok: true, value: { scheduled: true } };
}

export async function confirmProposal(
  proposalId: string,
): Promise<{ error: string | null; preview?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "not authenticated" };

  const proposal = await loadProposal(supabase, user.id, proposalId);
  if (!proposal) return { error: "proposal not found or already resolved" };

  const isSchedule = proposal.tool_name === "schedule_task";
  const executor = isSchedule ? null : EXECUTORS[proposal.tool_name];
  if (!isSchedule && !executor) {
    await resolveProposal(supabase, user.id, proposalId, "error", {
      error: `unknown tool ${proposal.tool_name}`,
    });
    return { error: `unknown tool ${proposal.tool_name}` };
  }

  // Claim BEFORE executing so a concurrent confirm (double-tap / retry, or a
  // race with the MCP confirm path) can't also run the executor and double-
  // apply the write. The loser bails without touching anything.
  const claimed = await claimProposal(supabase, user.id, proposalId);
  if (!claimed) {
    return { error: "proposal is already being confirmed or resolved" };
  }

  let outcome: Result<Record<string, unknown>>;
  try {
    outcome = isSchedule
      ? await executeScheduleTask(user.id, proposal.input)
      : await executor!(supabase, user.id, proposal.input);
  } catch (err) {
    const message = err instanceof Error ? err.message : "executor threw";
    await finalizeClaimedProposal(supabase, user.id, proposalId, "error", {
      error: message,
    });
    return { error: message };
  }

  if (!outcome.ok) {
    await finalizeClaimedProposal(supabase, user.id, proposalId, "error", {
      error: outcome.error,
    });
    return { error: outcome.error };
  }

  await finalizeClaimedProposal(
    supabase,
    user.id,
    proposalId,
    "executed",
    outcome.value,
  );
  revalidatePath("/", "layout");
  return { error: null, preview: proposal.summary };
}

export async function cancelProposal(
  proposalId: string,
): Promise<{ error: string | null }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "not authenticated" };

  const ok = await resolveProposal(supabase, user.id, proposalId, "rejected", null);
  if (!ok) return { error: "proposal not found or already resolved" };
  revalidatePath("/", "layout");
  return { error: null };
}
