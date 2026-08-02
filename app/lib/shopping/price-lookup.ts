import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";

import { readProviderKey } from "@/app/lib/connections/keys";
import { todayKey } from "@/app/lib/mcp/config";
import {
  resolveItemRef,
  type ResolvableItem,
} from "@/app/lib/mcp/inventory-ops";
import {
  buildShoppingList,
  type ShoppingListItem,
} from "@/app/_components/shopping-list";
import type { UsageRule } from "@/app/_components/inventory-projection";

// AI price lookup for shopping-list items: est_price is the estimated TOTAL
// for the item's planned purchase (buy_amount in its own unit, null = one
// typical package) — the model does the pack math, since stores sell packs
// that don't map 1:1 to tracked units. One web-search-enabled Claude call
// per item against the user's chosen store (user_settings.shopping_store),
// billed to their stored Anthropic key (cents per item — same spend category
// as the capture bar's free-form parsing). Prices are cache metadata, not user
// data: writes are direct and source-labeled. Fill rule: only NULL prices are
// written unless force, and a 'manual' price is never overwritten — human
// edits always win.

const PRICE_MODEL = "claude-haiku-4-5-20251001";
export const MAX_LOOKUP_ITEMS = 10;
const CONCURRENCY = 3;

const RECORD_PRICE_TOOL: Anthropic.Tool = {
  name: "record_price",
  description:
    "Record the looked-up price. Always call this exactly once as your final action, even when nothing was found.",
  input_schema: {
    type: "object",
    properties: {
      found: { type: "boolean" },
      price: {
        type: "number",
        description:
          "Estimated TOTAL for the planned purchase in the store's local currency: when a planned amount is given, the cost of the cheapest sensible package combination covering it; otherwise the price of one typical package. Omit when found is false.",
      },
      product_name: {
        type: "string",
        description: "The exact product the price refers to.",
      },
      confidence: { type: "string", enum: ["high", "medium", "low"] },
    },
    required: ["found"],
    additionalProperties: false,
  },
};

export type PriceLookupResult = {
  itemId: string;
  name: string;
  price: number | null;
  productName?: string;
  skipped?: "has-price" | "manual-price";
  error?: string;
};

type LookupRow = {
  id: string;
  name: string;
  unit: string;
  buy_amount: number | null;
  est_price: number | null;
  price_source: "ai" | "manual" | null;
};

async function lookupOne(
  anthropic: Anthropic,
  store: string,
  item: LookupRow,
): Promise<{ price: number | null; productName?: string; error?: string }> {
  const unitHint = item.unit ? ` (tracked in ${item.unit})` : "";
  const buyAmount = item.buy_amount === null ? null : Number(item.buy_amount);
  const wanted =
    buyAmount !== null && Number.isFinite(buyAmount) && buyAmount > 0
      ? `\nPlanned purchase: about ${buyAmount}${item.unit ? ` ${item.unit}` : ""}.`
      : "";
  const ask = wanted
    ? "Estimate the TOTAL cost of buying that planned amount at this store. Packages often contain multiples (e.g. chicken sold in packs of 2/4/6), so pick the cheapest sensible package combination that covers the planned amount — this is usually NOT a per-unit price times the amount."
    : "Find the current price of one typical package of this item at that store.";
  try {
    const response = await anthropic.messages.create({
      model: PRICE_MODEL,
      max_tokens: 2000,
      system: `You look up a single grocery/household item's current price at a specific store. Search the store's own website or listings for it (a flyer/aggregator is an acceptable fallback). When several close matches exist, prefer the cheapest ordinary option, not a premium brand. When a planned purchase amount is given, record the total for the realistic package combination covering it; otherwise record one typical package's price. Finish by calling record_price exactly once — with found: false if you cannot find a plausible price.`,
      messages: [
        {
          role: "user",
          content: `Store: ${store}\nItem: ${item.name}${unitHint}${wanted}\n\n${ask}`,
        },
      ],
      tools: [
        {
          type: "web_search_20250305",
          name: "web_search",
          max_uses: 3,
        },
        RECORD_PRICE_TOOL,
      ],
    });
    const toolUse = [...response.content]
      .reverse()
      .find(
        (block): block is Anthropic.ToolUseBlock =>
          block.type === "tool_use" && block.name === "record_price",
      );
    if (!toolUse) return { price: null, error: "no price recorded" };
    const input = toolUse.input as {
      found?: boolean;
      price?: number;
      product_name?: string;
    };
    const price = Number(input.price);
    if (input.found !== true || !Number.isFinite(price) || price <= 0) {
      return { price: null, error: "not found" };
    }
    return {
      price: Math.round(price * 100) / 100,
      productName:
        typeof input.product_name === "string" ? input.product_name : undefined,
    };
  } catch (error) {
    const message =
      error instanceof Anthropic.APIError
        ? `anthropic: ${error.message}`
        : "lookup failed";
    return { price: null, error: message };
  }
}

// Look up and store prices for the given items. Returns per-item outcomes;
// only the overall preconditions (no store, no key) are a hard error.
export async function lookupPrices(params: {
  supabase: SupabaseClient;
  userId: string;
  itemIds: string[];
  force?: boolean;
}): Promise<
  | { ok: true; results: PriceLookupResult[] }
  | { ok: false; error: string }
> {
  const { supabase, userId, force } = params;
  const itemIds = [...new Set(params.itemIds)].slice(0, MAX_LOOKUP_ITEMS);
  if (itemIds.length === 0) return { ok: true, results: [] };

  const { data: settings } = await supabase
    .from("user_settings")
    .select("shopping_store")
    .eq("user_id", userId)
    .maybeSingle();
  const store = (settings?.shopping_store as string | null)?.trim();
  if (!store) {
    return { ok: false, error: "set your grocery store first (shopping list panel or update_settings)" };
  }

  const apiKey = await readProviderKey(supabase, userId, "anthropic");
  if (!apiKey) {
    return { ok: false, error: "add your anthropic api key in settings to use price lookup" };
  }

  const { data: rows } = await supabase
    .from("inventory_items")
    .select("id, name, unit, buy_amount, est_price, price_source")
    .eq("user_id", userId)
    .in("id", itemIds);
  const items = (rows ?? []) as LookupRow[];

  const anthropic = new Anthropic({ apiKey });
  const results: PriceLookupResult[] = [];
  const queue = [...items];

  async function worker() {
    for (;;) {
      const item = queue.shift();
      if (!item) return;
      if (item.price_source === "manual") {
        results.push({
          itemId: item.id,
          name: item.name,
          price: item.est_price,
          skipped: "manual-price",
        });
        continue;
      }
      if (item.est_price !== null && !force) {
        results.push({
          itemId: item.id,
          name: item.name,
          price: item.est_price,
          skipped: "has-price",
        });
        continue;
      }
      const outcome = await lookupOne(anthropic, store as string, item);
      if (outcome.price !== null) {
        const { error } = await supabase
          .from("inventory_items")
          .update({
            est_price: outcome.price,
            price_source: "ai",
            price_checked_at: new Date().toISOString(),
          })
          .eq("id", item.id)
          .eq("user_id", userId);
        results.push({
          itemId: item.id,
          name: item.name,
          price: error ? null : outcome.price,
          productName: outcome.productName,
          error: error?.message,
        });
      } else {
        results.push({
          itemId: item.id,
          name: item.name,
          price: null,
          error: outcome.error,
        });
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker),
  );
  return { ok: true, results };
}

// Agent-facing entry: items may be ids or fuzzy names (the update_stock
// resolution semantics); with no items given, targets the current shopping
// list's unpriced entries (all non-manual entries when force).
export async function lookupPricesByRefs(params: {
  supabase: SupabaseClient;
  userId: string;
  items?: string[];
  force?: boolean;
}): Promise<
  | { ok: true; results: PriceLookupResult[] }
  | { ok: false; error: string }
> {
  const { supabase, userId, force } = params;

  const { data: rows } = await supabase
    .from("inventory_items")
    .select(
      "id, name, quantity, unit, reorder_threshold, archived, shopping_pinned, buy_amount, est_price, price_source",
    )
    .eq("user_id", userId)
    .eq("archived", false);
  const pool = (rows ?? []) as (ShoppingListItem & ResolvableItem)[];

  let itemIds: string[];
  if (params.items && params.items.length > 0) {
    itemIds = [];
    for (const ref of params.items) {
      const found = resolveItemRef(String(ref), pool);
      if (!found.ok) return found;
      itemIds.push(found.value.id);
    }
  } else {
    const { data: usageRows } = await supabase
      .from("inventory_usages")
      .select("inventory_item_id, amount, period, interval_days")
      .eq("user_id", userId);
    const rulesByItem = new Map<string, UsageRule[]>();
    for (const row of (usageRows ?? []) as (UsageRule & {
      inventory_item_id: string;
    })[]) {
      const rules = rulesByItem.get(row.inventory_item_id) ?? [];
      rules.push(row);
      rulesByItem.set(row.inventory_item_id, rules);
    }
    const today = await todayKey(supabase, userId);
    itemIds = buildShoppingList({ items: pool, rulesByItem, today })
      .filter((entry) =>
        force ? entry.priceSource !== "manual" : entry.estPrice === null,
      )
      .map((entry) => entry.id);
    if (itemIds.length === 0) {
      return { ok: true, results: [] };
    }
  }

  return lookupPrices({ supabase, userId, itemIds, force });
}
