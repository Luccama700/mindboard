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
    }
  | { op: "archive"; item: string }
  | { op: "restore"; item: string };

// What gets stored on the proposal and executed on confirm.
export type ResolvedStockOp =
  | { kind: "adjust"; itemId: string; name: string; unit: string; delta: number; before: number; after: number }
  | { kind: "recount"; itemId: string; name: string; unit: string; quantity: number; before: number }
  | { kind: "create"; name: string; quantity: number; unit: string; groupId: string | null; groupName: string | null }
  | { kind: "archive"; itemId: string; name: string }
  | { kind: "restore"; itemId: string; name: string };

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
        ops.push({ op, name, quantity, unit, group });
        break;
      }
      case "archive":
      case "restore": {
        const item = refString(entry.item);
        if (!item) return { ok: false, error: `operation ${i + 1} (${op}): item is required` };
        ops.push({ op, item });
        break;
      }
      default:
        return {
          ok: false,
          error: `operation ${i + 1}: unknown op "${String(op)}" (expected add/remove/set/create/archive/restore)`,
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
        if (op.group) {
          const g = matchGroup(op.group, groups);
          if (!g.ok) return g;
          groupId = g.value.id;
          groupName = g.value.name;
        }
        createdNames.add(needle);
        resolved.push({
          kind: "create",
          name: op.name,
          quantity: op.quantity,
          unit: op.unit ?? "",
          groupId,
          groupName,
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
      return `${op.name}  new · ${withUnit(op.quantity, op.unit)}${op.groupName ? ` · ${op.groupName}` : ""}`;
    case "archive":
      return `${op.name}  stop tracking`;
    case "restore":
      return `${op.name}  tracking again`;
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
        ops.push({
          kind: "create",
          name,
          quantity,
          unit: String(entry.unit ?? ""),
          groupId: typeof entry.groupId === "string" ? entry.groupId : null,
          groupName: typeof entry.groupName === "string" ? entry.groupName : null,
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
      default:
        return { ok: false, error: "malformed stored operation kind" };
    }
  }
  return { ok: true, value: ops };
}
