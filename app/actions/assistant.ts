"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "@/utils/supabase/server";
import { loadProposal, resolveProposal } from "@/app/lib/mcp/audit";
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

  let outcome: Result<Record<string, unknown>>;
  switch (proposal.tool_name) {
    case "schedule_task":
      outcome = await executeScheduleTask(user.id, proposal.input);
      break;
    default: {
      const executor = EXECUTORS[proposal.tool_name];
      if (!executor) {
        await resolveProposal(supabase, user.id, proposalId, "error", {
          error: `unknown tool ${proposal.tool_name}`,
        });
        return { error: `unknown tool ${proposal.tool_name}` };
      }
      outcome = await executor(supabase, user.id, proposal.input);
    }
  }

  if (!outcome.ok) {
    await resolveProposal(supabase, user.id, proposalId, "error", {
      error: outcome.error,
    });
    return { error: outcome.error };
  }

  const claimed = await resolveProposal(
    supabase,
    user.id,
    proposalId,
    "executed",
    outcome.value,
  );
  if (!claimed) return { error: "proposal was already resolved" };

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
