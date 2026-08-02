"use server";

import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@/utils/supabase/server";
import { decryptSecret } from "@/app/lib/assistant/crypto";
import { proposeUpdateStockFor } from "@/app/lib/mcp/writes";
import { MAX_STOCK_OPS } from "@/app/lib/mcp/inventory-ops";
import { todayKey } from "@/app/lib/mcp/config";

// The /inventory capture bar's server side. Two entry points, one outcome: a
// propose-only stock proposal (receipt preview + proposalId) that the page
// confirms via confirmProposal (app/actions/assistant.ts) — the same
// propose → confirm rail as the assistant and the MCP server.

export type StockProposal = {
  error: string | null;
  proposalId?: string;
  preview?: string;
};

// Direct path: the capture bar already parsed segments into ops (e.g. a "12
// eggs" recount that needs a create). No AI involved; the receipt is the
// typo guard.
export async function proposeStockOps(input: {
  operations: unknown[];
}): Promise<StockProposal> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "not authenticated" };

  const outcome = await proposeUpdateStockFor(
    supabase,
    user.id,
    { operations: input.operations },
    { source: "assistant" },
  );
  if (!outcome.ok) return { error: outcome.error };
  return { error: null, ...outcome.value };
}

const NL_MODEL = "claude-haiku-4-5-20251001";

const STOCK_TOOL: Anthropic.Tool = {
  name: "update_stock",
  description: "Translate the user's stock note into inventory operations.",
  input_schema: {
    type: "object",
    properties: {
      operations: {
        type: "array",
        minItems: 1,
        maxItems: MAX_STOCK_OPS,
        items: {
          type: "object",
          properties: {
            op: {
              type: "string",
              enum: ["add", "remove", "set", "create", "archive", "restore"],
            },
            item: { type: "string" },
            amount: { type: "number" },
            quantity: { type: "number" },
            name: { type: "string" },
            unit: { type: "string" },
            group: { type: "string" },
          },
          required: ["op"],
          additionalProperties: false,
        },
      },
    },
    required: ["operations"],
    additionalProperties: false,
  },
};

// Natural-language path: one forced-tool Claude call maps free text onto the
// same ops vocabulary, then the shared propose step validates and builds the
// receipt. The model only ever proposes — nothing applies without the confirm.
export async function proposeStockFromText(input: {
  text: string;
}): Promise<StockProposal> {
  const text = input.text?.trim();
  if (!text) return { error: "nothing to parse" };
  if (text.length > 2000) return { error: "that note is too long" };

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
    return { error: "add your anthropic api key in settings to use free-form inventory notes" };
  }
  let apiKey: string;
  try {
    apiKey = decryptSecret(encrypted);
  } catch {
    return { error: "key unreadable — paste it again in settings" };
  }

  const [itemsRes, groupsRes] = await Promise.all([
    supabase
      .from("inventory_items")
      .select("name, quantity, unit, archived")
      .order("name", { ascending: true }),
    supabase.from("inventory_groups").select("name").order("name", { ascending: true }),
  ]);
  type Row = { name: string; quantity: number; unit: string; archived: boolean };
  const items = (itemsRes.data ?? []) as Row[];
  const catalog = items
    .map(
      (it) =>
        `- ${it.name}: ${Number(it.quantity)}${it.unit ? ` ${it.unit}` : ""}${it.archived ? " (not tracked — needs restore first)" : ""}`,
    )
    .join("\n");
  const groups = ((groupsRes.data ?? []) as { name: string }[])
    .map((g) => g.name)
    .join(", ");

  const system = `You translate a user's quick stock note into inventory operations. Today is ${await todayKey(supabase, user.id)}.

Current inventory:
${catalog || "(empty)"}
Groups: ${groups || "(none)"}

Rules:
- "bought/got/picked up N X" → add. "used/ate/finished N X" → remove.
- "we have N X" / "counted N X" → set. "out of X" / "no more X" → set quantity 0.
- Words like "a dozen" = 12, "a couple" = 2, "a few" = 3.
- Reference existing items by their exact name from the list above. Only use create for items not in the list; give create ops a sensible short name (singular or the common plural, lowercase) and, when obvious, a unit and one of the existing groups.
- If the note mentions an item marked "not tracked", emit a restore op for it before its adjustment.
- Never invent items or amounts the note doesn't state.`;

  try {
    const anthropic = new Anthropic({ apiKey });
    const response = await anthropic.messages.create({
      model: NL_MODEL,
      max_tokens: 1500,
      system,
      messages: [{ role: "user", content: text }],
      tools: [STOCK_TOOL],
      tool_choice: { type: "tool", name: "update_stock" },
    });
    const toolUse = response.content.find(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
    );
    if (!toolUse) return { error: "could not parse that note" };

    const outcome = await proposeUpdateStockFor(supabase, user.id, toolUse.input, {
      source: "assistant",
    });
    if (!outcome.ok) return { error: outcome.error };
    return { error: null, ...outcome.value };
  } catch (error) {
    const message =
      error instanceof Anthropic.APIError
        ? `anthropic: ${error.message}`
        : "could not parse that note";
    return { error: message };
  }
}
