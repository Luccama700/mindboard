"use server";

import { revalidatePath } from "next/cache";
import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@/utils/supabase/server";
import { decryptSecret } from "@/app/lib/assistant/crypto";

// The inbox "auto sort" button's server side. One forced-tool Claude call
// (the user's stored key, same rail as free-form stock notes) maps inbox
// tasks onto existing groups; confident matches apply directly — this is an
// in-app action the user just pressed, not an assistant write, so no
// propose → confirm step. Unsure tasks stay in the inbox.

export type AutoSortResult = {
  error: string | null;
  moves?: { taskId: string; groupId: string }[];
  left?: number;
};

const NL_MODEL = "claude-haiku-4-5-20251001";
const MAX_TASKS = 100;

const SORT_TOOL: Anthropic.Tool = {
  name: "sort_tasks",
  description: "Assign each inbox task to its best-fitting group, or none.",
  input_schema: {
    type: "object",
    properties: {
      assignments: {
        type: "array",
        items: {
          type: "object",
          properties: {
            task: {
              type: "integer",
              description: "task number from the list",
            },
            group: {
              type: ["string", "null"],
              description: "exact group name, or null to leave in the inbox",
            },
          },
          required: ["task", "group"],
          additionalProperties: false,
        },
      },
    },
    required: ["assignments"],
    additionalProperties: false,
  },
};

export async function autoSortInbox(): Promise<AutoSortResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "not authenticated" };

  const { data: settings } = await supabase
    .from("user_settings")
    .select("anthropic_api_key")
    .eq("user_id", user.id)
    .maybeSingle();
  const encrypted = settings?.anthropic_api_key as string | null | undefined;
  if (!encrypted) {
    return { error: "add your anthropic api key in settings to use auto sort" };
  }
  let apiKey: string;
  try {
    apiKey = decryptSecret(encrypted);
  } catch {
    return { error: "key unreadable — paste it again in settings" };
  }

  const [tasksRes, groupsRes] = await Promise.all([
    supabase
      .from("tasks")
      .select("id, title, notes")
      .is("group_id", null)
      .eq("status", "todo")
      .order("created_at", { ascending: false })
      .limit(MAX_TASKS),
    supabase
      .from("groups")
      .select("id, name, type")
      .eq("archived", false)
      .order("created_at", { ascending: true }),
  ]);
  type TaskRow = { id: string; title: string; notes: string | null };
  type GroupRow = { id: string; name: string; type: string };
  const tasks = (tasksRes.data ?? []) as TaskRow[];
  const groups = (groupsRes.data ?? []) as GroupRow[];
  if (tasks.length === 0) return { error: "inbox is already empty" };
  if (groups.length === 0) {
    return { error: "no groups to sort into — create one first" };
  }

  const taskList = tasks
    .map((t, i) => {
      const note = t.notes
        ? ` — ${t.notes.replace(/\s+/g, " ").slice(0, 120)}`
        : "";
      return `${i + 1}. ${t.title}${note}`;
    })
    .join("\n");
  const groupList = groups.map((g) => `- ${g.name} (${g.type})`).join("\n");

  const system = `You sort a user's inbox tasks into their existing task groups.

Groups:
${groupList}

Tasks:
${taskList}

Rules:
- Reference groups by their exact name from the list above.
- Assign a task to a group only when the fit is clear from its title or notes. When no group clearly fits, use null so it stays in the inbox — never force a match.
- Cover every task number exactly once.`;

  let assignments: unknown[];
  try {
    const anthropic = new Anthropic({ apiKey });
    const response = await anthropic.messages.create({
      model: NL_MODEL,
      max_tokens: 4000,
      system,
      messages: [
        { role: "user", content: "Sort these inbox tasks into my groups." },
      ],
      tools: [SORT_TOOL],
      tool_choice: { type: "tool", name: "sort_tasks" },
    });
    const toolUse = response.content.find(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
    );
    const input = (toolUse?.input ?? {}) as { assignments?: unknown };
    if (!Array.isArray(input.assignments)) {
      return { error: "could not sort the inbox — try again" };
    }
    assignments = input.assignments;
  } catch (error) {
    const message =
      error instanceof Anthropic.APIError
        ? `anthropic: ${error.message}`
        : "could not sort the inbox — try again";
    return { error: message };
  }

  const byName = new Map(groups.map((g) => [g.name.toLowerCase(), g]));
  const perGroup = new Map<string, string[]>();
  const used = new Set<number>();
  for (const raw of assignments) {
    const a = raw as { task?: unknown; group?: unknown };
    if (typeof a.task !== "number" || used.has(a.task)) continue;
    const task = tasks[a.task - 1];
    if (!task) continue;
    used.add(a.task);
    if (typeof a.group !== "string") continue;
    const group = byName.get(a.group.trim().toLowerCase());
    if (!group) continue;
    const ids = perGroup.get(group.id) ?? [];
    ids.push(task.id);
    perGroup.set(group.id, ids);
  }

  const moves: { taskId: string; groupId: string }[] = [];
  for (const [groupId, ids] of perGroup) {
    // .is guard: never clobber a task the user re-grouped mid-sort.
    const { error } = await supabase
      .from("tasks")
      .update({ group_id: groupId })
      .in("id", ids)
      .is("group_id", null);
    if (!error) moves.push(...ids.map((taskId) => ({ taskId, groupId })));
  }

  if (moves.length > 0) revalidatePath("/", "layout");
  return { error: null, moves, left: tasks.length - moves.length };
}
