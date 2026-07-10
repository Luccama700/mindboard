// Pure stock-update batch logic shared by the MCP server, the in-app assistant,
// and the /inventory capture bar. One batch = one proposal = one confirm.
//
// Flow: validateStockOps (shape) → resolveStockOps (names → ids against a live
// item list, computes before/after with running quantities) → the resolved ops
// are what gets stored on the proposal (ids, not names, so renames between
// propose and confirm can't retarget a write) → renderStockReceipt (preview).
// Execution lives in writes.ts and re-reads live quantities; deltas re-apply,
// recounts overwrite.

import type { Result } from "./validate";

export const MAX_STOCK_OPS = 50;

export type UsagePeriod = "day" | "week" | "custom";

export type StockOp =
  | { op: "add"; item: string; amount: number }
  | { op: "remove"; item: string; amount: number }
  | { op: "set"; item: string; quantity: number }
  | {
      op: "create";
      name: string;
      quantity: number;
      unit?: string;
      group?: string;
      price?: number;
    }
  | { op: "archive"; item: string }
  | { op: "restore"; item: string }
  | { op: "set_priority"; item: string; priority: "low" | "med" | "high" }
  | { op: "set_threshold"; item: string; threshold: number | null }
  | {
      op: "set_usage";
      item: string;
      amount: number;
      period: UsagePeriod;
      intervalDays?: number;
    }
  | { op: "clear_usage"; item: string }
  | { op: "rename"; item: string; name: string }
  | { op: "move"; item: string; group?: string }
  | { op: "create_group"; name: string }
  | { op: "pin_shopping"; item: string; price?: number; buyAmount?: number }
  | { op: "unpin_shopping"; item: string }
  | { op: "set_price"; item: string; price: number | null }
  // Planned purchase amount in the item's own unit; null = one typical package.
  | { op: "set_buy"; item: string; buyAmount: number | null };

// What gets stored on the proposal and executed on confirm. groupId null +
// pendingGroup set means the group is created by a create_group op earlier in
// the same batch; the executor resolves it after that insert.
export type ResolvedStockOp =
  | { kind: "adjust"; itemId: string; name: string; unit: string; delta: number; before: number; after: number }
  | { kind: "recount"; itemId: string; name: string; unit: string; quantity: number; before: number }
  | {
      kind: "create";
      name: string;
      quantity: number;
      unit: string;
      groupId: string | null;
      groupName: string | null;
      pendingGroup?: string | null;
      // Agent-supplied estimated price, stored as an 'ai' price on insert.
      price?: number | null;
    }
  | { kind: "archive"; itemId: string; name: string }
  | { kind: "restore"; itemId: string; name: string }
  | {
      kind: "priority";
      itemId: string;
      name: string;
      priority: "low" | "med" | "high";
    }
  | { kind: "threshold"; itemId: string; name: string; unit: string; threshold: number | null }
  | {
      kind: "usage";
      itemId: string;
      name: string;
      unit: string;
      amount: number;
      period: UsagePeriod;
      intervalDays: number | null;
    }
  | { kind: "clear_usage"; itemId: string; name: string }
  | { kind: "rename"; itemId: string; from: string; to: string }
  | {
      kind: "move";
      itemId: string;
      name: string;
      groupId: string | null;
      groupName: string | null;
      pendingGroup?: string | null;
    }
  | { kind: "create_group"; name: string }
  // itemId null + pendingItem set means the item is created by a create op
  // earlier in the same batch; the executor resolves the id after that insert
  // (the pendingGroup pattern). price only applies when pinned is true and is
  // stored as an 'ai' price.
  | {
      kind: "pin";
      itemId: string | null;
      name: string;
      pinned: boolean;
      price?: number | null;
      buyAmount?: number | null;
      pendingItem?: string | null;
    }
  // A deliberate correction: stored as a 'manual' price (null clears it).
  | { kind: "price"; itemId: string; name: string; price: number | null }
  // Planned purchase amount (null clears back to "one typical package").
  | { kind: "buy"; itemId: string; name: string; unit: string; amount: number | null };

const ITEM_PRIORITIES = new Set(["low", "med", "high"]);

export type ResolvableItem = {
  id: string;
  name: string;
  quantity: number;
  unit: string;
  archived: boolean;
};

export type ResolvableGroup = { id: string; name: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function positiveNumber(v: unknown): number | null {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 1000) / 1000;
}

function nonNegativeNumber(v: unknown): number | null {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 1000) / 1000;
}

function refString(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s ? s : null;
}

function moneyNumber(v: unknown): number | null {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || n > 100000) return null;
  return Math.round(n * 100) / 100;
}

// ---------- shape validation ----------

export function validateStockOps(raw: unknown): Result<StockOp[]> {
  const operations = isRecord(raw) ? raw.operations : undefined;
  if (!Array.isArray(operations) || operations.length === 0) {
    return { ok: false, error: "operations must be a non-empty array" };
  }
  if (operations.length > MAX_STOCK_OPS) {
    return { ok: false, error: `too many operations (max ${MAX_STOCK_OPS})` };
  }

  const ops: StockOp[] = [];
  for (let i = 0; i < operations.length; i++) {
    const entry = operations[i];
    if (!isRecord(entry)) {
      return { ok: false, error: `operation ${i + 1} must be an object` };
    }
    const op = entry.op;
    switch (op) {
      case "add":
      case "remove": {
        const item = refString(entry.item);
        if (!item) return { ok: false, error: `operation ${i + 1} (${op}): item is required` };
        const amount = positiveNumber(entry.amount);
        if (amount === null) {
          return { ok: false, error: `operation ${i + 1} (${op} ${item}): amount must be a positive number` };
        }
        ops.push({ op, item, amount });
        break;
      }
      case "set": {
        const item = refString(entry.item);
        if (!item) return { ok: false, error: `operation ${i + 1} (set): item is required` };
        const quantity = nonNegativeNumber(entry.quantity);
        if (quantity === null) {
          return { ok: false, error: `operation ${i + 1} (set ${item}): quantity must be a non-negative number` };
        }
        ops.push({ op, item, quantity });
        break;
      }
      case "create": {
        const name = refString(entry.name);
        if (!name) return { ok: false, error: `operation ${i + 1} (create): name is required` };
        if (name.length > 120) {
          return { ok: false, error: `operation ${i + 1} (create): name too long` };
        }
        const quantity = nonNegativeNumber(entry.quantity);
        if (quantity === null) {
          return { ok: false, error: `operation ${i + 1} (create ${name}): quantity must be a non-negative number` };
        }
        const unit = typeof entry.unit === "string" ? entry.unit.trim() : "";
        const group = refString(entry.group) ?? undefined;
        let price: number | undefined;
        if (entry.price !== undefined && entry.price !== null) {
          const p = moneyNumber(entry.price);
          if (p === null) {
            return { ok: false, error: `operation ${i + 1} (create ${name}): price must be a positive number` };
          }
          price = p;
        }
        ops.push({ op, name, quantity, unit, group, price });
        break;
      }
      case "archive":
      case "restore": {
        const item = refString(entry.item);
        if (!item) return { ok: false, error: `operation ${i + 1} (${op}): item is required` };
        ops.push({ op, item });
        break;
      }
      case "set_priority": {
        const item = refString(entry.item);
        if (!item) return { ok: false, error: `operation ${i + 1} (set_priority): item is required` };
        const priority = entry.priority;
        if (typeof priority !== "string" || !ITEM_PRIORITIES.has(priority)) {
          return {
            ok: false,
            error: `operation ${i + 1} (set_priority ${item}): priority must be low, med, or high`,
          };
        }
        ops.push({
          op,
          item,
          priority: priority as "low" | "med" | "high",
        });
        break;
      }
      case "set_threshold": {
        const item = refString(entry.item);
        if (!item) return { ok: false, error: `operation ${i + 1} (set_threshold): item is required` };
        let threshold: number | null = null;
        if (entry.threshold !== undefined && entry.threshold !== null) {
          threshold = positiveNumber(entry.threshold);
          if (threshold === null) {
            return { ok: false, error: `operation ${i + 1} (set_threshold ${item}): threshold must be a positive number or null` };
          }
        }
        ops.push({ op, item, threshold });
        break;
      }
      case "set_usage": {
        const item = refString(entry.item);
        if (!item) return { ok: false, error: `operation ${i + 1} (set_usage): item is required` };
        const amount = positiveNumber(entry.amount);
        if (amount === null) {
          return { ok: false, error: `operation ${i + 1} (set_usage ${item}): amount must be a positive number` };
        }
        const period = entry.period;
        if (period !== "day" && period !== "week" && period !== "custom") {
          return { ok: false, error: `operation ${i + 1} (set_usage ${item}): period must be day, week, or custom` };
        }
        let intervalDays: number | undefined;
        if (period === "custom") {
          const n = Math.trunc(Number(entry.intervalDays));
          if (!Number.isInteger(n) || n < 1) {
            return { ok: false, error: `operation ${i + 1} (set_usage ${item}): custom period needs intervalDays of 1+` };
          }
          intervalDays = n;
        }
        ops.push({ op, item, amount, period, intervalDays });
        break;
      }
      case "clear_usage": {
        const item = refString(entry.item);
        if (!item) return { ok: false, error: `operation ${i + 1} (clear_usage): item is required` };
        ops.push({ op, item });
        break;
      }
      case "rename": {
        const item = refString(entry.item);
        if (!item) return { ok: false, error: `operation ${i + 1} (rename): item is required` };
        const name = refString(entry.name);
        if (!name || name.length > 120) {
          return { ok: false, error: `operation ${i + 1} (rename ${item}): name is required (max 120 chars)` };
        }
        ops.push({ op, item, name });
        break;
      }
      case "move": {
        const item = refString(entry.item);
        if (!item) return { ok: false, error: `operation ${i + 1} (move): item is required` };
        const group = refString(entry.group) ?? undefined;
        ops.push({ op, item, group });
        break;
      }
      case "create_group": {
        const name = refString(entry.name);
        if (!name || name.length > 120) {
          return { ok: false, error: `operation ${i + 1} (create_group): name is required (max 120 chars)` };
        }
        ops.push({ op, name });
        break;
      }
      case "pin_shopping": {
        const item = refString(entry.item);
        if (!item) return { ok: false, error: `operation ${i + 1} (pin_shopping): item is required` };
        let price: number | undefined;
        if (entry.price !== undefined && entry.price !== null) {
          const p = moneyNumber(entry.price);
          if (p === null) {
            return { ok: false, error: `operation ${i + 1} (pin_shopping ${item}): price must be a positive number` };
          }
          price = p;
        }
        let buyAmount: number | undefined;
        if (entry.buyAmount !== undefined && entry.buyAmount !== null) {
          const b = positiveNumber(entry.buyAmount);
          if (b === null) {
            return { ok: false, error: `operation ${i + 1} (pin_shopping ${item}): buyAmount must be a positive number` };
          }
          buyAmount = b;
        }
        ops.push({ op, item, price, buyAmount });
        break;
      }
      case "set_buy": {
        const item = refString(entry.item);
        if (!item) return { ok: false, error: `operation ${i + 1} (set_buy): item is required` };
        let buyAmount: number | null = null;
        if (entry.buyAmount !== undefined && entry.buyAmount !== null) {
          buyAmount = positiveNumber(entry.buyAmount);
          if (buyAmount === null) {
            return { ok: false, error: `operation ${i + 1} (set_buy ${item}): buyAmount must be a positive number or null` };
          }
        }
        ops.push({ op, item, buyAmount });
        break;
      }
      case "unpin_shopping": {
        const item = refString(entry.item);
        if (!item) return { ok: false, error: `operation ${i + 1} (unpin_shopping): item is required` };
        ops.push({ op, item });
        break;
      }
      case "set_price": {
        const item = refString(entry.item);
        if (!item) return { ok: false, error: `operation ${i + 1} (set_price): item is required` };
        let price: number | null = null;
        if (entry.price !== undefined && entry.price !== null) {
          price = moneyNumber(entry.price);
          if (price === null) {
            return { ok: false, error: `operation ${i + 1} (set_price ${item}): price must be a positive number or null` };
          }
        }
        ops.push({ op, item, price });
        break;
      }
      default:
        return {
          ok: false,
          error: `operation ${i + 1}: unknown op "${String(op)}" (expected add/remove/set/create/archive/restore/set_priority/set_threshold/set_usage/clear_usage/rename/move/create_group/pin_shopping/unpin_shopping/set_price/set_buy)`,
        };
    }
  }
  return { ok: true, value: ops };
}

// ---------- name → id resolution ----------

// Exported for the /inventory capture bar, which resolves refs client-side to
// decide between an instant edit and a create proposal. Same semantics as the
// server resolve: id → exact name → unique substring; ambiguity fails loudly.
export function resolveItemRef(
  ref: string,
  pool: ResolvableItem[],
): Result<ResolvableItem> {
  const byId = pool.find((it) => it.id === ref);
  if (byId) return { ok: true, value: byId };

  const needle = ref.toLowerCase();
  const exact = pool.filter((it) => it.name.toLowerCase() === needle);
  if (exact.length === 1) return { ok: true, value: exact[0] };
  if (exact.length > 1) {
    return {
      ok: false,
      error: `"${ref}" matches multiple items: ${exact.map((it) => `${it.name} (${it.id})`).join(", ")} — use an id`,
    };
  }

  const partial = pool.filter((it) => it.name.toLowerCase().includes(needle));
  if (partial.length === 1) return { ok: true, value: partial[0] };
  if (partial.length > 1) {
    return {
      ok: false,
      error: `"${ref}" is ambiguous: ${partial.map((it) => `${it.name} (${it.id})`).join(", ")} — use an id`,
    };
  }
  return { ok: false, error: `no item matching "${ref}"` };
}

function matchGroup(ref: string, groups: ResolvableGroup[]): Result<ResolvableGroup> {
  const byId = groups.find((g) => g.id === ref);
  if (byId) return { ok: true, value: byId };
  const needle = ref.toLowerCase();
  const exact = groups.filter((g) => g.name.toLowerCase() === needle);
  if (exact.length === 1) return { ok: true, value: exact[0] };
  return {
    ok: false,
    error: `no group matching "${ref}"${groups.length ? ` (groups: ${groups.map((g) => g.name).join(", ")})` : ""}`,
  };
}

// Resolves a whole batch or nothing: any ambiguity or miss fails the proposal so
// the caller can retry precisely. Running quantities let one batch touch the
// same item twice.
export function resolveStockOps(
  ops: StockOp[],
  items: ResolvableItem[],
  groups: ResolvableGroup[],
): Result<ResolvedStockOp[]> {
  const active = items.filter((it) => !it.archived);
  const archived = items.filter((it) => it.archived);
  const running = new Map<string, number>();
  for (const it of items) running.set(it.id, Number(it.quantity) || 0);
  // Names created earlier in the same batch, so duplicate creates fail fast.
  const createdNames = new Set<string>();
  // Groups created earlier in the same batch (name, no id yet); later ops
  // referencing one resolve to pendingGroup and the executor fills the id in.
  const createdGroups = new Map<string, string>(); // lowercased → display name

  const groupRef = (
    ref: string,
  ): Result<{ groupId: string | null; groupName: string | null; pendingGroup: string | null }> => {
    const pending = createdGroups.get(ref.toLowerCase());
    if (pending) return { ok: true, value: { groupId: null, groupName: pending, pendingGroup: pending } };
    const g = matchGroup(ref, groups);
    if (!g.ok) return g;
    return { ok: true, value: { groupId: g.value.id, groupName: g.value.name, pendingGroup: null } };
  };

  const resolved: ResolvedStockOp[] = [];
  for (const op of ops) {
    switch (op.op) {
      case "add":
      case "remove": {
        const found = resolveItemRef(op.item, active);
        if (!found.ok) {
          const inArchive = resolveItemRef(op.item, archived);
          if (inArchive.ok) {
            return {
              ok: false,
              error: `"${inArchive.value.name}" is not being tracked — add a restore op first`,
            };
          }
          return found;
        }
        const it = found.value;
        const before = running.get(it.id) ?? 0;
        const delta = op.op === "add" ? op.amount : -op.amount;
        const after = Math.max(0, Math.round((before + delta) * 1000) / 1000);
        running.set(it.id, after);
        resolved.push({
          kind: "adjust",
          itemId: it.id,
          name: it.name,
          unit: it.unit,
          delta,
          before,
          after,
        });
        break;
      }
      case "set": {
        const found = resolveItemRef(op.item, active);
        if (!found.ok) return found;
        const it = found.value;
        const before = running.get(it.id) ?? 0;
        running.set(it.id, op.quantity);
        resolved.push({
          kind: "recount",
          itemId: it.id,
          name: it.name,
          unit: it.unit,
          quantity: op.quantity,
          before,
        });
        break;
      }
      case "create": {
        const needle = op.name.toLowerCase();
        const existing = active.find((it) => it.name.toLowerCase() === needle);
        if (existing) {
          return {
            ok: false,
            error: `"${existing.name}" already exists — use add/set instead of create`,
          };
        }
        if (createdNames.has(needle)) {
          return { ok: false, error: `duplicate create for "${op.name}"` };
        }
        let groupId: string | null = null;
        let groupName: string | null = null;
        let pendingGroup: string | null = null;
        if (op.group) {
          const g = groupRef(op.group);
          if (!g.ok) return g;
          groupId = g.value.groupId;
          groupName = g.value.groupName;
          pendingGroup = g.value.pendingGroup;
        }
        createdNames.add(needle);
        resolved.push({
          kind: "create",
          name: op.name,
          quantity: op.quantity,
          unit: op.unit ?? "",
          groupId,
          groupName,
          pendingGroup,
          price: op.price ?? null,
        });
        break;
      }
      case "archive": {
        const found = resolveItemRef(op.item, active);
        if (!found.ok) return found;
        resolved.push({ kind: "archive", itemId: found.value.id, name: found.value.name });
        break;
      }
      case "restore": {
        const found = resolveItemRef(op.item, archived);
        if (!found.ok) return found;
        resolved.push({ kind: "restore", itemId: found.value.id, name: found.value.name });
        break;
      }
      case "set_priority": {
        const found = resolveItemRef(op.item, active);
        if (!found.ok) return found;
        resolved.push({
          kind: "priority",
          itemId: found.value.id,
          name: found.value.name,
          priority: op.priority,
        });
        break;
      }
      case "set_threshold": {
        const found = resolveItemRef(op.item, active);
        if (!found.ok) return found;
        resolved.push({
          kind: "threshold",
          itemId: found.value.id,
          name: found.value.name,
          unit: found.value.unit,
          threshold: op.threshold,
        });
        break;
      }
      case "set_usage": {
        const found = resolveItemRef(op.item, active);
        if (!found.ok) return found;
        resolved.push({
          kind: "usage",
          itemId: found.value.id,
          name: found.value.name,
          unit: found.value.unit,
          amount: op.amount,
          period: op.period,
          intervalDays: op.period === "custom" ? (op.intervalDays ?? null) : null,
        });
        break;
      }
      case "clear_usage": {
        const found = resolveItemRef(op.item, active);
        if (!found.ok) return found;
        resolved.push({
          kind: "clear_usage",
          itemId: found.value.id,
          name: found.value.name,
        });
        break;
      }
      case "rename": {
        const found = resolveItemRef(op.item, active);
        if (!found.ok) return found;
        const taken = active.find(
          (it) =>
            it.id !== found.value.id &&
            it.name.toLowerCase() === op.name.toLowerCase(),
        );
        if (taken) {
          return { ok: false, error: `an item named "${taken.name}" already exists` };
        }
        resolved.push({
          kind: "rename",
          itemId: found.value.id,
          from: found.value.name,
          to: op.name,
        });
        break;
      }
      case "move": {
        const found = resolveItemRef(op.item, active);
        if (!found.ok) return found;
        let groupId: string | null = null;
        let groupName: string | null = null;
        let pendingGroup: string | null = null;
        if (op.group) {
          const g = groupRef(op.group);
          if (!g.ok) return g;
          groupId = g.value.groupId;
          groupName = g.value.groupName;
          pendingGroup = g.value.pendingGroup;
        }
        resolved.push({
          kind: "move",
          itemId: found.value.id,
          name: found.value.name,
          groupId,
          groupName,
          pendingGroup,
        });
        break;
      }
      case "create_group": {
        const needle = op.name.toLowerCase();
        const existing = groups.find((g) => g.name.toLowerCase() === needle);
        if (existing) {
          return { ok: false, error: `group "${existing.name}" already exists` };
        }
        if (createdGroups.has(needle)) {
          return { ok: false, error: `duplicate create_group for "${op.name}"` };
        }
        createdGroups.set(needle, op.name);
        resolved.push({ kind: "create_group", name: op.name });
        break;
      }
      case "pin_shopping":
      case "unpin_shopping": {
        const pinned = op.op === "pin_shopping";
        // An item created earlier in this batch has no id yet; the executor
        // fills it in after the insert (the pendingGroup pattern).
        if (createdNames.has(op.item.toLowerCase())) {
          resolved.push({
            kind: "pin",
            itemId: null,
            name: op.item,
            pinned,
            price: pinned ? (op.price ?? null) : null,
            buyAmount: pinned ? (op.buyAmount ?? null) : null,
            pendingItem: op.item,
          });
          break;
        }
        const found = resolveItemRef(op.item, active);
        if (!found.ok) {
          const inArchive = resolveItemRef(op.item, archived);
          if (inArchive.ok) {
            return {
              ok: false,
              error: `"${inArchive.value.name}" is not being tracked — add a restore op first`,
            };
          }
          return found;
        }
        resolved.push({
          kind: "pin",
          itemId: found.value.id,
          name: found.value.name,
          pinned,
          price: pinned ? (op.price ?? null) : null,
          buyAmount: pinned ? (op.buyAmount ?? null) : null,
          pendingItem: null,
        });
        break;
      }
      case "set_buy": {
        const found = resolveItemRef(op.item, active);
        if (!found.ok) return found;
        resolved.push({
          kind: "buy",
          itemId: found.value.id,
          name: found.value.name,
          unit: found.value.unit,
          amount: op.buyAmount,
        });
        break;
      }
      case "set_price": {
        const found = resolveItemRef(op.item, active);
        if (!found.ok) return found;
        resolved.push({
          kind: "price",
          itemId: found.value.id,
          name: found.value.name,
          price: op.price,
        });
        break;
      }
    }
  }
  return { ok: true, value: resolved };
}

// ---------- receipt preview ----------

function formatQty(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

function withUnit(value: number, unit: string): string {
  return unit ? `${formatQty(value)} ${unit}` : formatQty(value);
}

export function receiptLine(op: ResolvedStockOp): string {
  switch (op.kind) {
    case "adjust": {
      const change = op.delta > 0 ? `+${formatQty(op.delta)}` : formatQty(op.delta);
      const note = op.after <= 0 ? "ran out" : change;
      return `${op.name}  ${formatQty(op.before)} → ${withUnit(op.after, op.unit)}  (${note})`;
    }
    case "recount":
      return `${op.name}  ${formatQty(op.before)} → ${withUnit(op.quantity, op.unit)}  (recount)`;
    case "create":
      return `${op.name}  new · ${withUnit(op.quantity, op.unit)}${op.groupName ? ` · ${op.groupName}` : ""}${op.price != null ? ` · ~$${op.price.toFixed(2)}` : ""}`;
    case "archive":
      return `${op.name}  stop tracking`;
    case "restore":
      return `${op.name}  tracking again`;
    case "priority":
      return `${op.name}  priority → ${op.priority}${op.priority === "high" ? " (!!!)" : ""}`;
    case "threshold":
      return op.threshold === null
        ? `${op.name}  reorder threshold cleared`
        : `${op.name}  reorder at ${withUnit(op.threshold, op.unit)}`;
    case "usage": {
      const cadence =
        op.period === "day"
          ? "per day"
          : op.period === "week"
            ? "per week"
            : `every ${op.intervalDays} days`;
      return `${op.name}  usage → ${withUnit(op.amount, op.unit)} ${cadence}`;
    }
    case "clear_usage":
      return `${op.name}  usage tracking cleared`;
    case "rename":
      return `${op.from} → renamed "${op.to}"`;
    case "move":
      return `${op.name}  moved to ${op.groupName ?? op.pendingGroup ?? "no group"}`;
    case "create_group":
      return `${op.name}  new group`;
    case "pin":
      return op.pinned
        ? `${op.name}  → shopping list${op.buyAmount != null ? ` · buy ${formatQty(op.buyAmount)}` : ""}${op.price != null ? ` · ~$${op.price.toFixed(2)}` : ""}`
        : `${op.name}  off shopping list`;
    case "price":
      return op.price === null
        ? `${op.name}  price cleared`
        : `${op.name}  price → $${op.price.toFixed(2)}`;
    case "buy":
      return op.amount === null
        ? `${op.name}  buy amount cleared (one package)`
        : `${op.name}  will buy ${withUnit(op.amount, op.unit)}`;
  }
}

export function renderStockReceipt(ops: ResolvedStockOp[]): string {
  return ops.map(receiptLine).join("\n");
}

// Structural re-validation of proposal input at execute time (the stored shape
// is ours, but the audit row is data — never trust it blindly).
export function validateResolvedOps(raw: unknown): Result<ResolvedStockOp[]> {
  const operations = isRecord(raw) ? raw.operations : undefined;
  if (!Array.isArray(operations) || operations.length === 0) {
    return { ok: false, error: "stored proposal has no operations" };
  }
  if (operations.length > MAX_STOCK_OPS) {
    return { ok: false, error: "stored proposal has too many operations" };
  }
  const ops: ResolvedStockOp[] = [];
  for (const entry of operations) {
    if (!isRecord(entry)) return { ok: false, error: "malformed stored operation" };
    switch (entry.kind) {
      case "adjust": {
        const delta = Number(entry.delta);
        if (typeof entry.itemId !== "string" || !Number.isFinite(delta) || delta === 0) {
          return { ok: false, error: "malformed adjust operation" };
        }
        ops.push({
          kind: "adjust",
          itemId: entry.itemId,
          name: String(entry.name ?? ""),
          unit: String(entry.unit ?? ""),
          delta,
          before: Number(entry.before) || 0,
          after: Number(entry.after) || 0,
        });
        break;
      }
      case "recount": {
        const quantity = nonNegativeNumber(entry.quantity);
        if (typeof entry.itemId !== "string" || quantity === null) {
          return { ok: false, error: "malformed recount operation" };
        }
        ops.push({
          kind: "recount",
          itemId: entry.itemId,
          name: String(entry.name ?? ""),
          unit: String(entry.unit ?? ""),
          quantity,
          before: Number(entry.before) || 0,
        });
        break;
      }
      case "create": {
        const name = refString(entry.name);
        const quantity = nonNegativeNumber(entry.quantity);
        if (!name || quantity === null) {
          return { ok: false, error: "malformed create operation" };
        }
        let createPrice: number | null = null;
        if (entry.price !== null && entry.price !== undefined) {
          createPrice = moneyNumber(entry.price);
          if (createPrice === null) {
            return { ok: false, error: "malformed create operation" };
          }
        }
        ops.push({
          kind: "create",
          name,
          quantity,
          unit: String(entry.unit ?? ""),
          groupId: typeof entry.groupId === "string" ? entry.groupId : null,
          groupName: typeof entry.groupName === "string" ? entry.groupName : null,
          pendingGroup:
            typeof entry.pendingGroup === "string" ? entry.pendingGroup : null,
          price: createPrice,
        });
        break;
      }
      case "archive":
      case "restore": {
        if (typeof entry.itemId !== "string") {
          return { ok: false, error: `malformed ${entry.kind} operation` };
        }
        ops.push({ kind: entry.kind, itemId: entry.itemId, name: String(entry.name ?? "") });
        break;
      }
      case "priority": {
        if (
          typeof entry.itemId !== "string" ||
          typeof entry.priority !== "string" ||
          !ITEM_PRIORITIES.has(entry.priority)
        ) {
          return { ok: false, error: "malformed priority operation" };
        }
        ops.push({
          kind: "priority",
          itemId: entry.itemId,
          name: String(entry.name ?? ""),
          priority: entry.priority as "low" | "med" | "high",
        });
        break;
      }
      case "threshold": {
        let threshold: number | null = null;
        if (entry.threshold !== null && entry.threshold !== undefined) {
          threshold = positiveNumber(entry.threshold);
          if (threshold === null) {
            return { ok: false, error: "malformed threshold operation" };
          }
        }
        if (typeof entry.itemId !== "string") {
          return { ok: false, error: "malformed threshold operation" };
        }
        ops.push({
          kind: "threshold",
          itemId: entry.itemId,
          name: String(entry.name ?? ""),
          unit: String(entry.unit ?? ""),
          threshold,
        });
        break;
      }
      case "usage": {
        const amount = positiveNumber(entry.amount);
        const period = entry.period;
        if (
          typeof entry.itemId !== "string" ||
          amount === null ||
          (period !== "day" && period !== "week" && period !== "custom")
        ) {
          return { ok: false, error: "malformed usage operation" };
        }
        let intervalDays: number | null = null;
        if (period === "custom") {
          const n = Math.trunc(Number(entry.intervalDays));
          if (!Number.isInteger(n) || n < 1) {
            return { ok: false, error: "malformed usage operation" };
          }
          intervalDays = n;
        }
        ops.push({
          kind: "usage",
          itemId: entry.itemId,
          name: String(entry.name ?? ""),
          unit: String(entry.unit ?? ""),
          amount,
          period,
          intervalDays,
        });
        break;
      }
      case "clear_usage": {
        if (typeof entry.itemId !== "string") {
          return { ok: false, error: "malformed clear_usage operation" };
        }
        ops.push({
          kind: "clear_usage",
          itemId: entry.itemId,
          name: String(entry.name ?? ""),
        });
        break;
      }
      case "rename": {
        const to = refString(entry.to);
        if (typeof entry.itemId !== "string" || !to) {
          return { ok: false, error: "malformed rename operation" };
        }
        ops.push({
          kind: "rename",
          itemId: entry.itemId,
          from: String(entry.from ?? ""),
          to,
        });
        break;
      }
      case "move": {
        if (typeof entry.itemId !== "string") {
          return { ok: false, error: "malformed move operation" };
        }
        ops.push({
          kind: "move",
          itemId: entry.itemId,
          name: String(entry.name ?? ""),
          groupId: typeof entry.groupId === "string" ? entry.groupId : null,
          groupName: typeof entry.groupName === "string" ? entry.groupName : null,
          pendingGroup:
            typeof entry.pendingGroup === "string" ? entry.pendingGroup : null,
        });
        break;
      }
      case "create_group": {
        const name = refString(entry.name);
        if (!name) return { ok: false, error: "malformed create_group operation" };
        ops.push({ kind: "create_group", name });
        break;
      }
      case "pin": {
        const itemId = typeof entry.itemId === "string" ? entry.itemId : null;
        const pendingItem =
          typeof entry.pendingItem === "string" ? entry.pendingItem : null;
        // Exactly one of itemId/pendingItem must identify the target.
        if (
          typeof entry.pinned !== "boolean" ||
          (itemId === null) === (pendingItem === null)
        ) {
          return { ok: false, error: "malformed pin operation" };
        }
        let pinPrice: number | null = null;
        if (entry.price !== null && entry.price !== undefined) {
          pinPrice = moneyNumber(entry.price);
          if (pinPrice === null) {
            return { ok: false, error: "malformed pin operation" };
          }
        }
        let pinBuy: number | null = null;
        if (entry.buyAmount !== null && entry.buyAmount !== undefined) {
          pinBuy = positiveNumber(entry.buyAmount);
          if (pinBuy === null) {
            return { ok: false, error: "malformed pin operation" };
          }
        }
        ops.push({
          kind: "pin",
          itemId,
          name: String(entry.name ?? ""),
          pinned: entry.pinned,
          price: pinPrice,
          buyAmount: pinBuy,
          pendingItem,
        });
        break;
      }
      case "buy": {
        if (typeof entry.itemId !== "string") {
          return { ok: false, error: "malformed buy operation" };
        }
        let amount: number | null = null;
        if (entry.amount !== null && entry.amount !== undefined) {
          amount = positiveNumber(entry.amount);
          if (amount === null) {
            return { ok: false, error: "malformed buy operation" };
          }
        }
        ops.push({
          kind: "buy",
          itemId: entry.itemId,
          name: String(entry.name ?? ""),
          unit: String(entry.unit ?? ""),
          amount,
        });
        break;
      }
      case "price": {
        if (typeof entry.itemId !== "string") {
          return { ok: false, error: "malformed price operation" };
        }
        let price: number | null = null;
        if (entry.price !== null && entry.price !== undefined) {
          price = moneyNumber(entry.price);
          if (price === null) {
            return { ok: false, error: "malformed price operation" };
          }
        }
        ops.push({
          kind: "price",
          itemId: entry.itemId,
          name: String(entry.name ?? ""),
          price,
        });
        break;
      }
      default:
        return { ok: false, error: "malformed stored operation kind" };
    }
  }
  return { ok: true, value: ops };
}
