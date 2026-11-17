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

// The in-app confirm rail — a human tap, from /plan, /people, /inventory or
// the /approvals inbox. The proposal row itself is read and resolved on the
// service client (audit M7: clients may no longer write ai_audit_log), scoped
// by a user id taken from the session and NEVER from the caller's input. The
// write the proposal describes still executes on the session's own RLS-scoped
// client, so approving something here can never reach another tenant's rows.
export async function confirmProposal(
  proposalId: string,
): Promise<{ error: string | null; preview?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "not authenticated" };

  const proposal = await loadProposal(user.id, proposalId);
  if (!proposal) return { error: "proposal not found or already resolved" };

  const isSchedule = proposal.tool_name === "schedule_task";
  const executor = isSchedule ? null : EXECUTORS[proposal.tool_name];
  if (!isSchedule && !executor) {
    await resolveProposal(user.id, proposalId, "error", {
      error: `unknown tool ${proposal.tool_name}`,
    });
    return { error: `unknown tool ${proposal.tool_name}` };
  }

  // Claim BEFORE executing so a concurrent confirm (double-tap / retry, or a
  // race with the MCP confirm path) can't also run the executor and double-
  // apply the write. The loser bails without touching anything.
  const claimed = await claimProposal(user.id, proposalId);
  if (!claimed) {
    return { error: "proposal is already being confirmed or resolved" };
  }

  let outcome: Result<Record<string, unknown>>;
  try {
    outcome = isSchedule
      ? await executeScheduleTask(user.id, proposal.input)
      : // "assistant" is not an MCP credential, so an executor that gates on
        // one (spawn_urc) refuses here by design.
        await executor!(supabase, user.id, proposal.input, {
          proposalId,
          proposedAt: proposal.created_at,
          authKind: "assistant",
        });
  } catch (err) {
    const message = err instanceof Error ? err.message : "executor threw";
    await finalizeClaimedProposal(user.id, proposalId, "error", {
      error: message,
    });
    return { error: message };
  }

  if (!outcome.ok) {
    await finalizeClaimedProposal(user.id, proposalId, "error", {
      error: outcome.error,
    });
    return { error: outcome.error };
  }

  await finalizeClaimedProposal(
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

  const ok = await resolveProposal(user.id, proposalId, "rejected", null);
  if (!ok) return { error: "proposal not found or already resolved" };
  revalidatePath("/", "layout");
  return { error: null };
}
