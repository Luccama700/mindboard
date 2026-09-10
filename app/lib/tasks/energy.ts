import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";

import { readProviderKey } from "@/app/lib/connections/keys";

// The AI default for a task's energy cost (migration 0053). Same recipe as the
// inbox auto-sort and the people group suggester: one forced-tool Haiku call
// on the user's own stored key. Runs after the response (after()), so a
// capture never waits on it, and the write is guarded in SQL by
// energy_source IS NULL — a value the user tapped can never be replaced.
// No key, no network, a strange answer: the cost simply stays unset.

const ENERGY_MODEL = "claude-haiku-4-5-20251001";

export const ENERGY_LEVELS = [1, 2, 3, 4, 5] as const;

// Energy ≠ time. The anchors are what the prompt teaches the model, kept here
// beside the parser so a test can pin them without a network call.
export const ENERGY_SCALE =
  "1 = automatic, no thought (drop off a letter, a 90-minute commute)\n" +
  "2 = light, low friction (reply to a friendly message, a short errand)\n" +
  "3 = needs focus but familiar (read a chapter, a regular meeting)\n" +
  "4 = draining or high-friction (a call to a bureaucracy, a hard conversation, outlining an argument)\n" +
  "5 = deep or dreaded effort (drafting an essay body, a job interview, a difficult decision)";

const RATE_TOOL: Anthropic.Tool = {
  name: "rate_energy",
  description:
    "Rate how much energy — not time — the task costs the person, on a 1-5 scale.",
  input_schema: {
    type: "object",
    properties: {
      energyCost: {
        type: "integer",
        minimum: 1,
        maximum: 5,
        description: "1 automatic … 5 deep/dreaded effort",
      },
    },
    required: ["energyCost"],
    additionalProperties: false,
  },
};

export type EnergyRatingInput = {
  title: string;
  notes: string | null;
  estimatedMinutes: number | null;
  groupName: string | null;
};

// The model's tool payload → 1..5, or null when it is not a clean rating.
export function parseEnergyRating(raw: unknown): number | null {
  const value = (raw as { energyCost?: unknown } | null)?.energyCost;
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  if (value < 1 || value > 5) return null;
  return value;
}

export function energyPrompt(task: EnergyRatingInput): string {
  const lines = [`Task: ${task.title}`];
  if (task.groupName) lines.push(`Group: ${task.groupName}`);
  if (task.estimatedMinutes) lines.push(`Estimated time: ${task.estimatedMinutes} minutes`);
  if (task.notes) lines.push(`Notes: ${task.notes.replace(/\s+/g, " ").slice(0, 600)}`);
  return lines.join("\n");
}

export async function rateEnergy(
  anthropic: Anthropic,
  task: EnergyRatingInput,
): Promise<number | null> {
  const response = await anthropic.messages.create({
    model: ENERGY_MODEL,
    max_tokens: 200,
    system: `You rate the ENERGY a task costs a person, separate from how long it takes. A long easy thing is cheap; a short high-friction thing is expensive. Scale:\n${ENERGY_SCALE}\n\nCall rate_energy exactly once.`,
    messages: [{ role: "user", content: energyPrompt(task) }],
    tools: [RATE_TOOL],
    tool_choice: { type: "tool", name: "rate_energy" },
  });
  const toolUse = response.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
  );
  return parseEnergyRating(toolUse?.input);
}

type Rel<T> = T | T[] | null;

// Assign the AI default to one task, if nobody has set one yet. Every query
// pins user_id: callers pass the service client from session-less paths.
export async function assignEnergyIfUnset(
  supabase: SupabaseClient,
  userId: string,
  taskId: string,
): Promise<{ assigned: number | null; reason?: string }> {
  const { data } = await supabase
    .from("tasks")
    .select("id, title, notes, estimated_minutes, energy_source, groups(name)")
    .eq("id", taskId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!data) return { assigned: null, reason: "task not found" };
  const row = data as {
    title: string;
    notes: string | null;
    estimated_minutes: number | null;
    energy_source: "ai" | "user" | null;
    groups: Rel<{ name: string }>;
  };
  if (row.energy_source !== null) return { assigned: null, reason: "already set" };

  const apiKey = await readProviderKey(supabase, userId, "anthropic");
  if (!apiKey) return { assigned: null, reason: "no anthropic key" };

  let rating: number | null;
  try {
    rating = await rateEnergy(new Anthropic({ apiKey }), {
      title: row.title,
      notes: row.notes,
      estimatedMinutes: row.estimated_minutes,
      groupName: Array.isArray(row.groups)
        ? (row.groups[0]?.name ?? null)
        : (row.groups?.name ?? null),
    });
  } catch {
    return { assigned: null, reason: "rating failed" };
  }
  if (rating === null) return { assigned: null, reason: "no rating" };

  // The SQL guard IS the "never overwrite a user value" rule: if the user
  // tapped a dot while the model was thinking, this update matches no row.
  const { data: updated, error } = await supabase
    .from("tasks")
    .update({ energy_cost: rating, energy_source: "ai" })
    .eq("id", taskId)
    .eq("user_id", userId)
    .is("energy_source", null)
    .select("id");
  if (error) return { assigned: null, reason: error.message };
  if (!updated || updated.length === 0) return { assigned: null, reason: "set meanwhile" };
  return { assigned: rating };
}
