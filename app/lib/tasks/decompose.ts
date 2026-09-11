import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";

import { readProviderKey } from "@/app/lib/connections/keys";
import { recordProposal } from "@/app/lib/mcp/audit";
import {
  MAX_CHILDREN,
  MIN_CHILDREN,
  renderDecompositionReceipt,
  validateDecomposition,
  type DecompositionParent,
  type ProposedChild,
} from "@/app/lib/mcp/decompose-ops";
import type { Proposal } from "@/app/lib/mcp/writes";
import type { Result } from "@/app/lib/mcp/validate";
import { ENERGY_SCALE } from "@/app/lib/tasks/energy";

// decompose_task: the propose step (shared by the MCP tool, the in-app
// assistant, and the "break down" button) and the executor confirm_action /
// confirmProposal run. Opt-in only — nothing here fires without a user tap or
// an explicit tool call, and nothing is written until the proposal is
// confirmed. Same AI recipe as the energy default: one forced-tool Haiku call
// on the user's own stored key.

const DECOMPOSE_MODEL = "claude-haiku-4-5-20251001";

const PROPOSE_TOOL: Anthropic.Tool = {
  name: "propose_subtasks",
  description: `Break the task into ${MIN_CHILDREN}-${MAX_CHILDREN} concrete steps, each with its own time and energy and a window of days it should happen in.`,
  input_schema: {
    type: "object",
    properties: {
      children: {
        type: "array",
        minItems: MIN_CHILDREN,
        maxItems: MAX_CHILDREN,
        items: {
          type: "object",
          properties: {
            title: { type: "string", description: "imperative, specific, standalone" },
            estimatedMinutes: { type: "integer", minimum: 5 },
            energyCost: { type: "integer", minimum: 1, maximum: 5 },
            notBefore: { type: "string", description: "YYYY-MM-DD, earliest sensible day" },
            dueDate: { type: "string", description: "YYYY-MM-DD, must be done by" },
          },
          required: ["title", "estimatedMinutes", "energyCost", "notBefore", "dueDate"],
          additionalProperties: false,
        },
      },
    },
    required: ["children"],
    additionalProperties: false,
  },
};

type ParentRow = {
  id: string;
  title: string;
  notes: string | null;
  due_date: string | null;
  estimated_minutes: number | null;
  energy_cost: number | null;
  status: string;
  parent_task_id: string | null;
  groups: { name: string } | { name: string }[] | null;
};

async function loadParent(
  supabase: SupabaseClient,
  userId: string,
  taskId: string,
): Promise<Result<ParentRow & { groupName: string | null }>> {
  const { data } = await supabase
    .from("tasks")
    .select(
      "id, title, notes, due_date, estimated_minutes, energy_cost, status, parent_task_id, groups(name)",
    )
    .eq("id", taskId)
    .eq("user_id", userId)
    .maybeSingle();
  const row = data as ParentRow | null;
  if (!row) return { ok: false, error: "task not found" };
  if (row.parent_task_id) return { ok: false, error: "a subtask cannot be broken down further" };
  if (row.status === "done" || row.status === "missed") {
    return { ok: false, error: `"${row.title}" is already ${row.status}` };
  }
  if (!row.due_date) {
    return {
      ok: false,
      error: `"${row.title}" needs a due date first — the steps are planned backwards from it`,
    };
  }
  const { count } = await supabase
    .from("tasks")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("parent_task_id", taskId);
  if ((count ?? 0) > 0) {
    return { ok: false, error: `"${row.title}" is already broken down` };
  }
  const groupName = Array.isArray(row.groups)
    ? (row.groups[0]?.name ?? null)
    : (row.groups?.name ?? null);
  return { ok: true, value: { ...row, groupName } };
}

export function decompositionPrompt(
  parent: ParentRow & { groupName: string | null },
  today: string,
): string {
  const lines = [
    `Today: ${today}`,
    `Task: ${parent.title}`,
    `Due: ${parent.due_date}`,
  ];
  if (parent.groupName) lines.push(`Group: ${parent.groupName}`);
  if (parent.estimated_minutes) lines.push(`Estimated total: ${parent.estimated_minutes} minutes`);
  if (parent.energy_cost) lines.push(`Energy cost (1-5): ${parent.energy_cost}`);
  if (parent.notes) lines.push(`Notes: ${parent.notes.replace(/\s+/g, " ").slice(0, 1500)}`);
  return lines.join("\n");
}

async function suggestChildren(
  anthropic: Anthropic,
  parent: ParentRow & { groupName: string | null },
  today: string,
): Promise<unknown> {
  const response = await anthropic.messages.create({
    model: DECOMPOSE_MODEL,
    max_tokens: 1500,
    system: `You break one big task into ${MIN_CHILDREN}-${MAX_CHILDREN} concrete steps a person can do on different days, so the work starts before the deadline instead of on it.

Rules:
- Steps are sequential-ish and specific ("Pull three quotes from the readings", not "Research"). Never pad with trivial steps.
- Give each step its own estimatedMinutes; together they should roughly match the task's estimated total when one is given.
- Give each step an energyCost on this scale (energy is not time — a long easy step is cheap, a short high-friction one is expensive):
${ENERGY_SCALE}
- Give each step a window: notBefore (earliest sensible day, on or after today) and dueDate (must be done by). Windows may overlap a little, move forward through the calendar, and the last step's dueDate is the task's due date. Leave slack before the deadline for the heavy steps.
- Dates are YYYY-MM-DD. Call propose_subtasks exactly once.`,
    messages: [{ role: "user", content: decompositionPrompt(parent, today) }],
    tools: [PROPOSE_TOOL],
    tool_choice: { type: "tool", name: "propose_subtasks" },
  });
  const toolUse = response.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
  );
  return toolUse?.input ?? null;
}

// Propose. `children` (optional) is the edit path: a client that wants a
// different breakdown than the model's re-proposes with an explicit list and
// no model call is made. Records a 'decompose_task' proposal row; nothing is
// written to tasks.
export async function proposeDecomposeTaskFor(
  supabase: SupabaseClient,
  userId: string,
  raw: { taskId?: unknown; children?: unknown },
  today: string,
  options?: { source?: "mcp" | "assistant"; conversationId?: string | null },
): Promise<Result<Proposal & { children: ProposedChild[] }>> {
  if (typeof raw.taskId !== "string" || !raw.taskId) {
    return { ok: false, error: "taskId is required" };
  }
  const loaded = await loadParent(supabase, userId, raw.taskId);
  if (!loaded.ok) return loaded;
  const parent = loaded.value;
  const target: DecompositionParent = {
    id: parent.id,
    title: parent.title,
    dueDate: parent.due_date as string,
  };

  let candidate: unknown = raw.children;
  if (candidate === undefined) {
    const apiKey = await readProviderKey(supabase, userId, "anthropic");
    if (!apiKey) {
      return {
        ok: false,
        error: "add your anthropic api key in settings to break tasks down (or pass the steps yourself)",
      };
    }
    try {
      candidate = await suggestChildren(new Anthropic({ apiKey }), parent, today);
    } catch (error) {
      const message =
        error instanceof Anthropic.APIError
          ? `anthropic: ${error.message}`
          : "could not break the task down — try again";
      return { ok: false, error: message };
    }
    if (candidate === null) return { ok: false, error: "the model proposed no steps — try again" };
  }

  const validated = validateDecomposition(candidate, target, today);
  if (!validated.ok) return validated;
  const children = validated.value;
  const summary = renderDecompositionReceipt(target, children);
  const proposalId = await recordProposal(
    supabase,
    userId,
    "decompose_task",
    { parentTaskId: parent.id, children },
    summary,
    options,
  );
  return { ok: true, value: { proposalId, preview: summary, children } };
}

// Executor (EXECUTORS.decompose_task): re-check the parent as it is NOW, then
// insert the children in one batch. Children inherit the parent's group; their
// energy comes from the proposal and reads as the AI default ('ai') until the
// user taps a dot.
export async function executeDecomposeTask(
  supabase: SupabaseClient,
  ownerId: string,
  input: Record<string, unknown>,
  today: string,
): Promise<Result<Record<string, unknown>>> {
  const parentTaskId = input.parentTaskId;
  if (typeof parentTaskId !== "string" || !parentTaskId) {
    return { ok: false, error: "parentTaskId is required" };
  }
  const loaded = await loadParent(supabase, ownerId, parentTaskId);
  if (!loaded.ok) return loaded;
  const parent = loaded.value;
  const dueDate = parent.due_date as string;
  // The window was validated at propose time; a day may have passed since, so
  // clamp again against today rather than failing a confirm the user just
  // tapped — unless the deadline itself has passed, which needs a fresh look.
  if (dueDate < today) {
    return {
      ok: false,
      error: `"${parent.title}" was due ${dueDate} — move its due date and break it down again`,
    };
  }
  const validated = validateDecomposition(
    input.children,
    { id: parent.id, title: parent.title, dueDate },
    today,
  );
  if (!validated.ok) return validated;

  const { data: groupRow } = await supabase
    .from("tasks")
    .select("group_id")
    .eq("id", parent.id)
    .eq("user_id", ownerId)
    .maybeSingle();
  const groupId = (groupRow as { group_id: string | null } | null)?.group_id ?? null;

  const { data, error } = await supabase
    .from("tasks")
    .insert(
      validated.value.map((c) => ({
        user_id: ownerId,
        parent_task_id: parent.id,
        group_id: groupId,
        title: c.title,
        estimated_minutes: c.estimatedMinutes,
        energy_cost: c.energyCost,
        energy_source: "ai",
        not_before: c.notBefore,
        due_date: c.dueDate,
        priority: "med",
      })),
    )
    .select("id, title, not_before, due_date, estimated_minutes, energy_cost");
  if (error) return { ok: false, error: error.message };
  return {
    ok: true,
    value: { parent: { id: parent.id, title: parent.title }, children: data ?? [] },
  };
}
