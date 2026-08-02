"use client";

// The shelf: a calm picture of what you HAVE. Active items render grouped and
// alphabetical; items at zero stay on the shelf showing 0 with a greyed icon
// and a quiet ! badge (restock is the normal + stepper); "stop tracking"
// archives (reversible, in "not tracking") and hard delete only lives there.
// The omnibox on top is search + capture in one field: plain text filters,
// "12 eggs" / "+2 milk" apply instantly on enter, and anything else goes to
// Claude and comes back as a propose → confirm receipt (ProposalCard).
// The shopping panel (toolbar button, right aside) is the derived buy list:
// out/low/running-out-soon items plus manual pins, with estimated prices that
// feed the finance forecast's grocery layer.

import {
  useEffect,
  useMemo,
  useOptimistic,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
} from "react";
import { useRouter } from "next/navigation";
import { ColorPicker, PALETTE } from "@/app/_components/color-picker";
import { UnitPicker } from "@/app/_components/unit-picker";
import {
  activeModelFor,
  readImageGenSettings,
} from "@/app/_components/image-gen-settings";
import {
  adjustInventoryQuantity,
  createInventoryGroup,
  createInventoryItem,
  createInventoryUsage,
  deleteInventoryGroup,
  deleteInventoryItem,
  deleteInventoryUsage,
  setInventoryItemArchived,
  updateInventoryGroup,
  updateInventoryItem,
  updateInventoryUsage,
} from "@/app/actions/inventory";
import { generateItemIcon } from "@/app/actions/inventory-icon";
import { lookupItemPrices } from "@/app/actions/shopping";
import { saveShoppingSettings } from "@/app/actions/settings";
import {
  proposeStockFromText,
  proposeStockOps,
} from "@/app/actions/stock-capture";
import { cancelProposal, confirmProposal } from "@/app/actions/assistant";
import type {
  InventoryGroup,
  InventoryItem,
  InventoryUsage,
} from "@/app/_components/inventory-types";
import { InventoryCalendar } from "@/app/_components/inventory-calendar";
import {
  daysBetween,
  effectiveDailyRate,
  runOutDateKey,
  stockStatus,
  type StockStatus,
  type UsagePeriod,
  type UsageRule,
} from "@/app/_components/inventory-projection";
import { parseStockText } from "@/app/_components/stock-capture-parse";
import {
  buildShoppingList,
  shoppingTotal,
  type ShoppingEntry,
} from "@/app/_components/shopping-list";
import {
  hasRefCandidate,
  resolveItemRef,
  resolveItemRefIncludingArchived,
  type ResolvableItem,
  type StockOp,
} from "@/app/lib/mcp/inventory-ops";
import { ProposalCard } from "@/app/_components/proposal-card";
import { todayISO } from "@/app/_components/date-utils";
import { createClient } from "@/utils/supabase/client";

type GroupAction =
  | { kind: "update"; id: string; patch: Partial<InventoryGroup> }
  | { kind: "remove"; id: string };

type ItemAction =
  | { kind: "add"; item: InventoryItem }
  | { kind: "replace"; tempId: string; item: InventoryItem }
  | { kind: "update"; id: string; patch: Partial<InventoryItem> }
  | { kind: "remove"; id: string };

type UsageAction =
  | { kind: "add"; usage: InventoryUsage }
  | { kind: "replace"; tempId: string; usage: InventoryUsage }
  | { kind: "update"; id: string; patch: Partial<InventoryUsage> }
  | { kind: "remove"; id: string };

const ICON_BUCKET = "inventory-icons";
const ARCHIVE_SUGGEST_DAYS = 14;

type ViewMode = "list" | "grid";
const VIEW_KEY = "inventory-view";
const viewListeners = new Set<() => void>();

function readViewMode(): ViewMode {
  if (typeof window === "undefined") return "list";
  return window.localStorage.getItem(VIEW_KEY) === "grid" ? "grid" : "list";
}

function setViewMode(mode: ViewMode) {
  if (typeof window !== "undefined") {
    window.localStorage.setItem(VIEW_KEY, mode);
  }
  for (const cb of viewListeners) cb();
}

function subscribeViewMode(cb: () => void) {
  viewListeners.add(cb);
  return () => viewListeners.delete(cb);
}

function useViewMode(): ViewMode {
  return useSyncExternalStore(subscribeViewMode, readViewMode, () => "list");
}

type CountMode = "items" | "totals";
const COUNT_KEY = "inventory-count-mode";
const countListeners = new Set<() => void>();

function readCountMode(): CountMode {
  if (typeof window === "undefined") return "items";
  return window.localStorage.getItem(COUNT_KEY) === "totals"
    ? "totals"
    : "items";
}

function setCountMode(mode: CountMode) {
  if (typeof window !== "undefined") {
    window.localStorage.setItem(COUNT_KEY, mode);
  }
  for (const cb of countListeners) cb();
}

function subscribeCountMode(cb: () => void) {
  countListeners.add(cb);
  return () => countListeners.delete(cb);
}

function useCountMode(): CountMode {
  return useSyncExternalStore(subscribeCountMode, readCountMode, () => "items");
}

function hexToRgba(hex: string, alpha: number): string {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return `rgba(127, 127, 127, ${alpha})`;
  const int = parseInt(match[1], 16);
  const r = (int >> 16) & 255;
  const g = (int >> 8) & 255;
  const b = int & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function formatQty(value: number): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return "0";
  return String(Math.round(n * 1000) / 1000);
}

function formatRunOut(key: string): string {
  return new Date(`${key}T00:00:00`)
    .toLocaleDateString("en-US", { month: "short", day: "numeric" })
    .toLowerCase();
}

function summarizeByUnit(items: InventoryItem[]): string {
  const order: string[] = [];
  const data = new Map<string, { unit: string; sum: number; count: number }>();
  for (const it of items) {
    const unit = it.unit.trim();
    const key = unit.toLowerCase();
    const existing = data.get(key);
    if (existing) {
      existing.sum += Number(it.quantity) || 0;
      existing.count += 1;
    } else {
      data.set(key, { unit, sum: Number(it.quantity) || 0, count: 1 });
      order.push(key);
    }
  }
  if (order.length === 0) return "0";
  return order
    .map((k) => data.get(k)!)
    .sort((a, b) => b.count - a.count)
    .map((e) => `${formatQty(e.sum)}${e.unit ? ` ${e.unit}` : ""}`)
    .join(", ");
}

// The date an item has been sitting at zero since, best-effort: the last
// restock if we saw one, else creation.
function zeroSinceKey(item: InventoryItem): string {
  return (item.last_restocked_at ?? item.created_at).slice(0, 10);
}

type StockProposalState = { proposalId: string; preview: string };

export function InventoryClient({
  userId,
  initialGroups,
  initialItems,
  initialUsages,
  initialShoppingStore,
  initialShoppingDay,
}: {
  userId: string;
  initialGroups: InventoryGroup[];
  initialItems: InventoryItem[];
  initialUsages: InventoryUsage[];
  initialShoppingStore: string | null;
  initialShoppingDay: number | null;
}) {
  const router = useRouter();

  const [groups, dispatchGroups] = useOptimistic<
    InventoryGroup[],
    GroupAction
  >(initialGroups, (state, action) => {
    switch (action.kind) {
      case "update":
        return state.map((g) =>
          g.id === action.id ? { ...g, ...action.patch } : g,
        );
      case "remove":
        return state.filter((g) => g.id !== action.id);
    }
  });

  const [items, dispatchItems] = useOptimistic<InventoryItem[], ItemAction>(
    initialItems,
    (state, action) => {
      switch (action.kind) {
        case "add":
          return [...state, action.item];
        case "replace":
          return state.map((it) =>
            it.id === action.tempId ? action.item : it,
          );
        case "update":
          return state.map((it) =>
            it.id === action.id ? { ...it, ...action.patch } : it,
          );
        case "remove":
          return state.filter((it) => it.id !== action.id);
      }
    },
  );

  const [usages, dispatchUsages] = useOptimistic<InventoryUsage[], UsageAction>(
    initialUsages,
    (state, action) => {
      switch (action.kind) {
        case "add":
          return [...state, action.usage];
        case "replace":
          return state.map((u) =>
            u.id === action.tempId ? action.usage : u,
          );
        case "update":
          return state.map((u) =>
            u.id === action.id ? { ...u, ...action.patch } : u,
          );
        case "remove":
          return state.filter((u) => u.id !== action.id);
      }
    },
  );

  const [, startTransition] = useTransition();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [groupFormOpen, setGroupFormOpen] = useState(false);

  const [query, setQuery] = useState("");
  const [captureBusy, setCaptureBusy] = useState(false);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [proposal, setProposal] = useState<StockProposalState | null>(null);
  const [proposalPending, setProposalPending] = useState(false);
  const [proposalError, setProposalError] = useState<string | null>(null);

  // Every server action here returns { error }. Dropping it leaves the
  // optimistic value on screen until the transition settles and then snaps back
  // with no explanation, so the user acts on a number the DB never accepted.
  const [actionError, setActionError] = useState<string | null>(null);
  const failureCount = useRef(0);

  const [selectMode, setSelectMode] = useState(false);
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());
  const [dismissedSuggestions, setDismissedSuggestions] = useState<Set<string>>(
    new Set(),
  );

  const [shoppingOpen, setShoppingOpen] = useState(false);
  const [shoppingStore, setShoppingStore] = useState(initialShoppingStore);
  const [shoppingDay, setShoppingDay] = useState(initialShoppingDay);

  const asideRef = useRef<HTMLDivElement>(null);
  const view = useViewMode();
  const countMode = useCountMode();

  const activeItems = useMemo(
    () => items.filter((it) => !it.archived),
    [items],
  );
  const archivedItems = useMemo(
    () =>
      items
        .filter((it) => it.archived)
        .sort((a, b) => (b.archived_at ?? "").localeCompare(a.archived_at ?? "")),
    [items],
  );

  const groupColors = useMemo(() => {
    const map = new Map<string, string>();
    for (const g of groups) map.set(g.id, g.color);
    return map;
  }, [groups]);

  const recentUnits = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const it of activeItems) {
      const u = it.unit.trim();
      if (u && !seen.has(u.toLowerCase())) {
        seen.add(u.toLowerCase());
        out.push(u);
      }
    }
    return out;
  }, [activeItems]);

  const rulesByItem = useMemo(() => {
    const map = new Map<string, UsageRule[]>();
    for (const u of usages) {
      const rule: UsageRule = {
        amount: Number(u.amount),
        period: u.period,
        interval_days: u.interval_days,
      };
      const bucket = map.get(u.inventory_item_id);
      if (bucket) bucket.push(rule);
      else map.set(u.inventory_item_id, [rule]);
    }
    return map;
  }, [usages]);

  // Quiet, opt-in attention: a hint only exists when the user set a usage rule
  // (projected run-out date) or a reorder threshold ("low") — plus "out" at 0.
  const hints = useMemo(() => {
    const today = todayISO(null);
    const map = new Map<string, { status: StockStatus; runOut: string | null }>();
    for (const item of activeItems) {
      const qty = Number(item.quantity);
      const status = stockStatus(qty, item.reorder_threshold);
      const rate = effectiveDailyRate(rulesByItem.get(item.id) ?? []);
      const runOut = qty > 0 && rate > 0 ? runOutDateKey(today, qty, rate) : null;
      map.set(item.id, { status, runOut });
    }
    return map;
  }, [activeItems, rulesByItem]);

  const shoppingEntries = useMemo(
    () =>
      buildShoppingList({
        items: activeItems,
        rulesByItem,
        today: todayISO(null),
      }),
    [activeItems, rulesByItem],
  );

  // Omnibox doubles as search: when the text parses as a stock command, filter
  // by the item reference it names, not the raw "+2 milk".
  const needle = useMemo(() => {
    const parsed = parseStockText(query);
    const raw = parsed ? (parsed[parsed.length - 1]?.ref ?? query) : query;
    return raw.trim().toLowerCase();
  }, [query]);

  const matchesNeedle = (it: InventoryItem) =>
    !needle || it.name.toLowerCase().includes(needle);

  const shelfSections = useMemo(() => {
    const shelf = activeItems
      .filter(matchesNeedle)
      .sort((a, b) => a.name.localeCompare(b.name));
    const byGroup = new Map<string | null, InventoryItem[]>();
    for (const it of shelf) {
      const key = it.inventory_group_id;
      const bucket = byGroup.get(key);
      if (bucket) bucket.push(it);
      else byGroup.set(key, [it]);
    }
    const sections: { group: InventoryGroup | null; items: InventoryItem[] }[] =
      [];
    for (const g of groups) {
      const bucket = byGroup.get(g.id);
      if (bucket) sections.push({ group: g, items: bucket });
    }
    const ungrouped = byGroup.get(null);
    if (ungrouped) sections.push({ group: null, items: ungrouped });
    return sections;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeItems, groups, needle]);

  const shelfItems = useMemo(
    () => shelfSections.flatMap((s) => s.items),
    [shelfSections],
  );

  // Still needed for the gentle "stop tracking?" nudge below, even though
  // zero-quantity items now render inline on the shelf.
  const ranOutAll = useMemo(
    () =>
      activeItems
        .filter((it) => Number(it.quantity) <= 0)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [activeItems],
  );
  const archivedFiltered = archivedItems.filter(matchesNeedle);

  // At most one gentle nudge, and only when an item has sat at zero for weeks:
  // the question is "stop tracking?", never "go buy this".
  const suggestion = useMemo(() => {
    if (needle) return null;
    const today = todayISO(null);
    for (const item of ranOutAll) {
      if (dismissedSuggestions.has(item.id)) continue;
      const days = daysBetween(zeroSinceKey(item), today);
      if (days >= ARCHIVE_SUGGEST_DAYS) return { item, days };
    }
    return null;
  }, [ranOutAll, dismissedSuggestions, needle]);

  const selectedItem =
    activeItems.find((it) => it.id === selectedId) ?? null;

  function scrollDetailIntoView() {
    if (typeof window === "undefined") return;
    if (window.innerWidth >= 1024) return;
    requestAnimationFrame(() =>
      asideRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }),
    );
  }

  function onSelect(id: string) {
    setAdding(false);
    setShoppingOpen(false);
    setSelectedId(id);
    scrollDetailIntoView();
  }

  function startAdd() {
    setAdding(true);
    setShoppingOpen(false);
    setSelectedId(null);
    scrollDetailIntoView();
  }

  function openShopping() {
    setAdding(false);
    setSelectedId(null);
    setShoppingOpen(true);
    scrollDetailIntoView();
  }

  // Runs one server action and reports a rejected write. The optimistic patch
  // itself needs no manual undo: useOptimistic drops it when the transition
  // settles, and a failed action never revalidates, so the shelf falls back to
  // the last server truth. What was missing was saying so.
  async function runAction<T extends { error: string | null }>(
    label: string,
    call: Promise<T>,
  ): Promise<T> {
    // Transitions are not serialized — each tap starts its own — so a success
    // already in flight must not clear a failure that landed while it waited.
    const seenFailures = failureCount.current;
    const result = await call;
    if (result?.error) {
      failureCount.current += 1;
      setActionError(`${label} — ${result.error}`);
    } else if (failureCount.current === seenFailures) {
      setActionError(null);
    }
    return result;
  }

  function onCreateItem(input: {
    name: string;
    quantity: number;
    unit: string;
    groupId: string | null;
  }) {
    const tempId = `temp-${crypto.randomUUID()}`;
    const optimistic: InventoryItem = {
      id: tempId,
      name: input.name,
      quantity: input.quantity,
      unit: input.unit,
      notes: null,
      image_url: null,
      inventory_group_id: input.groupId,
      reorder_threshold: null,
      priority: "med",
      archived: false,
      archived_at: null,
      last_restocked_at: null,
      shopping_pinned: false,
      buy_amount: null,
      est_price: null,
      price_source: null,
      price_checked_at: null,
      created_at: new Date().toISOString(),
    };
    setAdding(false);
    setSelectedId(tempId);
    startTransition(async () => {
      dispatchItems({ kind: "add", item: optimistic });
      const result = await runAction(
        `couldn't add ${input.name}`,
        createInventoryItem({
          groupId: input.groupId,
          name: input.name,
          quantity: input.quantity,
          unit: input.unit,
        }),
      );
      if (!result.error && result.item) {
        const real = result.item as InventoryItem;
        dispatchItems({ kind: "replace", tempId, item: real });
        setSelectedId(real.id);
      } else {
        // The optimistic row is about to disappear; don't leave the detail
        // panel pointed at an id that never existed.
        setSelectedId((prev) => (prev === tempId ? null : prev));
      }
    });
  }

  // Every +/− on the page — shelf rows, grid tiles, the detail panel's stepper,
  // "+2 milk" in the omnibox — lands here. The delta is what travels; the
  // server applies it to the live row (compare-and-swap), so a stale tab or a
  // concurrent agent write can't be overwritten by this view's arithmetic. The
  // quantity passed along is optimistic paint only, and recounts do NOT come
  // through here.
  function onStepQuantity(id: string, delta: number) {
    const current = items.find((it) => it.id === id);
    if (!current) return;
    // No "nothing changed, skip the write" guard: that call would be made from
    // this view's possibly-stale number. A − on a shelf showing 0 still means
    // "one less than whatever is really there".
    const next = Math.max(
      0,
      Math.round((Number(current.quantity) + delta) * 1000) / 1000,
    );
    onUpdateItem(id, { quantity: next }, delta);
  }

  // The one write path for an item row. `delta` marks a relative quantity
  // change (a stepper, "+2 milk") and is applied server-side; everything else,
  // including a recount, is an absolute patch.
  //
  // The step path shares this transition deliberately: pulling it into its own
  // startTransition — or routing both through a discriminated-union helper —
  // makes the React Compiler give up on this whole component
  // (react-hooks/preserve-manual-memoization, an error here; both shapes were
  // tried and reproduce it). The overload signatures blunt the extra
  // parameter: with a delta the patch may declare `{ quantity }` and nothing
  // else, so a fresh literal carrying any other field is a compile error. That
  // is excess-property checking, not a guarantee — a pre-built variable still
  // slips through and its extra fields are dropped at runtime. Every call site
  // here passes a literal; keep it that way.
  function onUpdateItem(id: string, patch: Partial<InventoryItem>): void;
  function onUpdateItem(
    id: string,
    patch: { quantity: number },
    delta: number,
  ): void;
  function onUpdateItem(
    id: string,
    patch: Partial<InventoryItem>,
    delta?: number,
  ) {
    const label = items.find((it) => it.id === id)?.name ?? "item";
    startTransition(async () => {
      dispatchItems({ kind: "update", id, patch });
      await runAction(
        `couldn't update ${label}`,
        delta === undefined
          ? updateInventoryItem({
              id,
              name: patch.name,
              quantity: patch.quantity,
              unit: patch.unit,
              notes: patch.notes,
              groupId: patch.inventory_group_id,
              imageUrl: patch.image_url,
              reorderThreshold: patch.reorder_threshold,
              priority: patch.priority,
              shoppingPinned: patch.shopping_pinned,
              buyAmount: patch.buy_amount,
              estPrice: patch.est_price,
            })
          : adjustInventoryQuantity({ id, delta }),
      );
      // Pinning can trigger a post-response AI price lookup server-side;
      // refresh so the filled price lands without a manual reload.
      if (patch.shopping_pinned === true) {
        setTimeout(() => router.refresh(), 12000);
      }
    });
  }

  function onSaveShoppingSettings(input: {
    store?: string | null;
    shoppingDay?: number | null;
  }) {
    if (input.store !== undefined) setShoppingStore(input.store);
    if (input.shoppingDay !== undefined) setShoppingDay(input.shoppingDay);
    startTransition(async () => {
      await runAction(
        "couldn't save shopping settings",
        saveShoppingSettings(input),
      );
    });
  }

  function onSetArchived(id: string, archived: boolean) {
    const label = items.find((it) => it.id === id)?.name ?? "item";
    startTransition(async () => {
      if (archived && selectedId === id) setSelectedId(null);
      dispatchItems({
        kind: "update",
        id,
        patch: {
          archived,
          archived_at: archived ? new Date().toISOString() : null,
        },
      });
      await runAction(
        `couldn't ${archived ? "stop tracking" : "restore"} ${label}`,
        setInventoryItemArchived(id, archived),
      );
    });
  }

  function onCreateUsage(
    itemId: string,
    input: { amount: number; period: UsagePeriod; intervalDays: number | null },
  ) {
    if (itemId.startsWith("temp-")) return;
    const tempId = `temp-${crypto.randomUUID()}`;
    const optimistic: InventoryUsage = {
      id: tempId,
      inventory_item_id: itemId,
      amount: input.amount,
      period: input.period,
      interval_days: input.intervalDays,
      created_at: new Date().toISOString(),
    };
    startTransition(async () => {
      dispatchUsages({ kind: "add", usage: optimistic });
      const result = await runAction(
        "couldn't save the usage rule",
        createInventoryUsage({
          itemId,
          amount: input.amount,
          period: input.period,
          intervalDays: input.intervalDays,
        }),
      );
      if (!result.error && result.usage) {
        dispatchUsages({
          kind: "replace",
          tempId,
          usage: result.usage as InventoryUsage,
        });
      }
    });
  }

  function onUpdateUsage(
    id: string,
    input: { amount: number; period: UsagePeriod; intervalDays: number | null },
  ) {
    startTransition(async () => {
      dispatchUsages({
        kind: "update",
        id,
        patch: {
          amount: input.amount,
          period: input.period,
          interval_days: input.intervalDays,
        },
      });
      await runAction(
        "couldn't save the usage rule",
        updateInventoryUsage({
          id,
          amount: input.amount,
          period: input.period,
          intervalDays: input.intervalDays,
        }),
      );
    });
  }

  function onDeleteUsage(id: string) {
    startTransition(async () => {
      dispatchUsages({ kind: "remove", id });
      await runAction(
        "couldn't clear the usage rule",
        deleteInventoryUsage(id),
      );
    });
  }

  function onDeleteItem(id: string) {
    const label = items.find((it) => it.id === id)?.name ?? "item";
    startTransition(async () => {
      if (selectedId === id) setSelectedId(null);
      dispatchItems({ kind: "remove", id });
      await runAction(`couldn't delete ${label}`, deleteInventoryItem(id));
    });
  }

  function onUpdateGroup(id: string, patch: Partial<InventoryGroup>) {
    startTransition(async () => {
      dispatchGroups({ kind: "update", id, patch });
      await runAction(
        "couldn't update the group",
        updateInventoryGroup({
          id,
          name: patch.name,
          color: patch.color,
        }),
      );
    });
  }

  function onDeleteGroup(id: string) {
    startTransition(async () => {
      dispatchGroups({ kind: "remove", id });
      for (const it of items) {
        if (it.inventory_group_id === id) {
          dispatchItems({
            kind: "update",
            id: it.id,
            patch: { inventory_group_id: null },
          });
        }
      }
      await runAction("couldn't delete the group", deleteInventoryGroup(id));
    });
  }

  function onCreateGroup(input: { name: string; color: string }) {
    return createInventoryGroup(input);
  }

  // ---------- select mode ----------

  function toggleChecked(id: string) {
    setCheckedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function exitSelectMode() {
    setSelectMode(false);
    setCheckedIds(new Set());
  }

  function bulkArchive() {
    const ids = [...checkedIds];
    exitSelectMode();
    startTransition(async () => {
      const now = new Date().toISOString();
      for (const id of ids) {
        if (selectedId === id) setSelectedId(null);
        dispatchItems({
          kind: "update",
          id,
          patch: { archived: true, archived_at: now },
        });
      }
      for (const id of ids) {
        const result = await runAction(
          "couldn't stop tracking every selected item",
          setInventoryItemArchived(id, true),
        );
        if (result.error) return;
      }
    });
  }

  function bulkMove(groupId: string | null) {
    const ids = [...checkedIds];
    exitSelectMode();
    startTransition(async () => {
      for (const id of ids) {
        dispatchItems({
          kind: "update",
          id,
          patch: { inventory_group_id: groupId },
        });
      }
      for (const id of ids) {
        const result = await runAction(
          "couldn't move every selected item",
          updateInventoryItem({ id, groupId }),
        );
        if (result.error) return;
      }
    });
  }

  function bulkDelete() {
    const ids = [...checkedIds];
    if (
      !window.confirm(
        `delete ${ids.length} item${ids.length === 1 ? "" : "s"} forever? "stop tracking" keeps them recoverable.`,
      )
    ) {
      return;
    }
    exitSelectMode();
    startTransition(async () => {
      for (const id of ids) {
        if (selectedId === id) setSelectedId(null);
        dispatchItems({ kind: "remove", id });
      }
      for (const id of ids) {
        const result = await runAction(
          "couldn't delete every selected item",
          deleteInventoryItem(id),
        );
        if (result.error) return;
      }
    });
  }

  // ---------- omnibox capture ----------

  async function runPropose(fn: () => Promise<{
    error: string | null;
    proposalId?: string;
    preview?: string;
  }>) {
    setCaptureBusy(true);
    setCaptureError(null);
    try {
      const result = await fn();
      if (result.error || !result.proposalId || !result.preview) {
        setCaptureError(result.error ?? "could not build an inventory update");
        return;
      }
      setProposal({ proposalId: result.proposalId, preview: result.preview });
      setProposalError(null);
      setQuery("");
    } finally {
      setCaptureBusy(false);
    }
  }

  function onOmniSubmit(e: React.FormEvent) {
    e.preventDefault();
    const text = query.trim();
    if (!text || captureBusy) return;
    setCaptureError(null);

    const segments = parseStockText(text);
    if (!segments) {
      // Free-form: one Claude call → proposal receipt. Never applies silently.
      void runPropose(() => proposeStockFromText({ text }));
      return;
    }

    const toResolvable = (it: InventoryItem): ResolvableItem => ({
      id: it.id,
      name: it.name,
      quantity: Number(it.quantity),
      unit: it.unit,
      archived: it.archived,
    });
    const activePool = activeItems.map(toResolvable);
    // Archived items are considered too, so "12 rice" against something you
    // stopped tracking restores that row instead of creating a second rice.
    const archivedPool = archivedItems.map(toResolvable);

    // Per item: the net relative change, or an absolute value once a recount in
    // the same line pins one. Relative changes are what get sent, so a stale
    // shelf can't overwrite a concurrent write.
    const pending = new Map<string, { delta: number; absolute: number | null }>();
    const ops: StockOp[] = [];
    // Creates and archived matches both change more than a number, so they go
    // through the receipt instead of applying silently.
    let needsReceipt = false;
    for (const seg of segments) {
      const found = resolveItemRefIncludingArchived(
        seg.ref,
        activePool,
        archivedPool,
      );
      if (found.ok) {
        const it = found.value;
        if (it.archived) needsReceipt = true;
        const acc = pending.get(it.id) ?? { delta: 0, absolute: null };
        if (seg.sign === null) {
          // A recount inside the same line pins the value from here on.
          acc.absolute = seg.value;
          acc.delta = 0;
        } else {
          const signed = seg.sign === "+" ? seg.value : -seg.value;
          if (acc.absolute === null) acc.delta += signed;
          else acc.absolute = Math.max(0, acc.absolute + signed);
        }
        pending.set(it.id, acc);
        ops.push(
          seg.sign === "+"
            ? { op: "add", item: it.id, amount: seg.value }
            : seg.sign === "-"
              ? { op: "remove", item: it.id, amount: seg.value }
              : { op: "set", item: it.id, quantity: seg.value },
        );
      } else if (seg.sign === null && !hasRefCandidate(seg.ref, activePool)) {
        // Nothing on the shelf matches, so a bare recount is naming a new item
        // — which deserves a receipt (typo guard) instead of a silent create.
        // This also covers an archive that matched several ("rice" against a
        // hidden "brown rice" + "white rice"): a candidate list of rows the
        // collapsed "not tracking" section keeps invisible, remediable only by
        // typing a uuid, is worse than proposing the create the user meant.
        needsReceipt = true;
        ops.push({ op: "create", name: seg.ref, quantity: seg.value });
      } else {
        setCaptureError(found.error);
        return;
      }
    }

    if (needsReceipt) {
      void runPropose(() => proposeStockOps({ operations: ops }));
      return;
    }

    // Every ref resolved to an item already on the shelf: the user typed the
    // exact edit, apply it instantly (same trust level as tapping the
    // steppers). "+2"/"-2" send their delta; only a recount overwrites — and a
    // recount is sent even when it matches the number on screen, because the
    // user just asserted ground truth and this view may be stale.
    for (const [id, acc] of pending) {
      if (acc.absolute !== null) {
        onUpdateItem(id, { quantity: acc.absolute });
      } else if (acc.delta !== 0) {
        onStepQuantity(id, acc.delta);
      }
    }
    setQuery("");
  }

  function onConfirmProposal() {
    if (!proposal) return;
    setProposalPending(true);
    setProposalError(null);
    startTransition(async () => {
      const result = await confirmProposal(proposal.proposalId);
      setProposalPending(false);
      if (result.error) {
        setProposalError(result.error);
        return;
      }
      setProposal(null);
      router.refresh();
    });
  }

  function onSkipProposal() {
    if (!proposal) return;
    const id = proposal.proposalId;
    setProposal(null);
    setProposalError(null);
    startTransition(async () => {
      await cancelProposal(id);
    });
  }

  const hasActiveItems = activeItems.length > 0;

  return (
    <div className="grid gap-8 lg:grid-cols-2 lg:gap-24 lg:items-start">
      <section className="min-w-0 space-y-6">
        <form onSubmit={onOmniSubmit} className="space-y-1">
          <div
            className="flex items-stretch overflow-hidden bg-glass-well rounded-field border border-line-strong focus-within:border-accent transition-colors"
            data-tour="omnibox"
          >
            <input
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                if (captureError) setCaptureError(null);
              }}
              type="text"
              placeholder='search · "12 eggs" · "+2 milk" · or say what you got'
              autoComplete="off"
              aria-label="search or update inventory"
              className="min-h-11 flex-1 min-w-0 bg-transparent px-3 text-sm text-fg placeholder-muted focus:outline-none"
            />
            {query.trim() && (
              <button
                type="submit"
                disabled={captureBusy}
                className="px-4 text-action lowercase border-l border-line-strong text-muted hover:text-fg hover:bg-card-hover transition-colors disabled:opacity-50"
              >
                {captureBusy ? "…" : "apply"}
              </button>
            )}
          </div>
          {captureError && <p className="text-danger text-xs">{captureError}</p>}
        </form>

        {proposal && (
          <ProposalCard
            title="inventory update"
            confirmLabel="apply"
            onConfirm={onConfirmProposal}
            onSkip={onSkipProposal}
            pending={proposalPending}
            error={proposalError}
          >
            <pre className="whitespace-pre-wrap text-sm text-fg leading-relaxed">
              {proposal.preview}
            </pre>
          </ProposalCard>
        )}

        {hasActiveItems && (
          <div className="flex justify-end gap-2 flex-wrap">
            <button
              type="button"
              data-tour="shopping"
              onClick={() => (shoppingOpen ? setShoppingOpen(false) : openShopping())}
              aria-pressed={shoppingOpen}
              className={`min-h-11 px-3 rounded-full text-[10px] tracking-widest uppercase border transition-colors mr-auto ${
                shoppingOpen
                  ? "border-accent bg-accent text-accent-fg"
                  : "border-line bg-page text-muted hover:text-fg"
              }`}
            >
              shopping{shoppingEntries.length > 0 ? ` · ${shoppingEntries.length}` : ""}
            </button>
            <button
              type="button"
              onClick={() => (selectMode ? exitSelectMode() : setSelectMode(true))}
              aria-pressed={selectMode}
              className={`min-h-11 px-3 rounded-full text-[10px] tracking-widest uppercase border transition-colors ${
                selectMode
                  ? "border-accent bg-accent text-accent-fg"
                  : "border-line bg-page text-muted hover:text-fg"
              }`}
            >
              select
            </button>
            {view === "list" && (
              <div className="flex gap-px rounded-full overflow-hidden border border-line bg-line">
                {(["items", "totals"] as CountMode[]).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setCountMode(m)}
                    aria-pressed={countMode === m}
                    className={`min-h-11 px-3 text-[10px] tracking-widest uppercase transition-colors ${
                      countMode === m
                        ? "bg-accent text-accent-fg"
                        : "bg-page text-muted hover:text-fg"
                    }`}
                  >
                    {m}
                  </button>
                ))}
              </div>
            )}
            <div className="flex gap-px rounded-full overflow-hidden border border-line bg-line">
              {(["list", "grid"] as ViewMode[]).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setViewMode(m)}
                  aria-pressed={view === m}
                  className={`min-h-11 px-3 text-[10px] tracking-widest uppercase transition-colors ${
                    view === m
                      ? "bg-accent text-accent-fg"
                      : "bg-page text-muted hover:text-fg"
                  }`}
                >
                  {m}
                </button>
              ))}
            </div>
          </div>
        )}

        {!hasActiveItems ? (
          <p
            className="border border-dashed border-line-strong text-muted text-sm px-4 py-10 text-center"
            data-tour="shelf"
          >
            nothing on the shelf yet. add your first item.
          </p>
        ) : shelfItems.length === 0 ? (
          <p className="border border-dashed border-line-strong text-muted text-sm px-4 py-10 text-center">
            no matches.
          </p>
        ) : view === "grid" ? (
          <div
            className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-8"
            data-tour="shelf"
          >
            {shelfItems.map((it) => (
              <ItemTile
                key={it.id}
                item={it}
                color={
                  it.inventory_group_id
                    ? (groupColors.get(it.inventory_group_id) ?? null)
                    : null
                }
                selected={it.id === selectedId}
                onSelect={onSelect}
                onAdjust={onStepQuantity}
              />
            ))}
          </div>
        ) : (
          <div className="space-y-6" data-tour="shelf">
            {shelfSections.map((section) => (
              <div key={section.group?.id ?? "ungrouped"} className="space-y-2">
                <div className="flex items-center gap-2 text-label uppercase text-muted select-none">
                  {section.group && (
                    <span
                      className="w-2 h-2 flex-shrink-0"
                      style={{ backgroundColor: section.group.color }}
                      aria-hidden
                    />
                  )}
                  <span>{section.group?.name ?? "ungrouped"}</span>
                  <span className="flex-1 border-t border-hairline" aria-hidden />
                  <span className="tabular-nums">
                    {countMode === "items"
                      ? section.items.length
                      : summarizeByUnit(section.items)}
                  </span>
                </div>
                <ul className="glass-panel overflow-hidden divide-y divide-hairline">
                  {section.items.map((it) => {
                    const hint = hints.get(it.id) ?? {
                      status: "ok" as StockStatus,
                      runOut: null,
                    };
                    return (
                      <ItemRow
                        key={it.id}
                        item={it}
                        hint={hint}
                        selected={it.id === selectedId}
                        selectMode={selectMode}
                        checked={checkedIds.has(it.id)}
                        onToggleCheck={toggleChecked}
                        onSelect={onSelect}
                        onAdjust={onStepQuantity}
                        onArchive={(id) => onSetArchived(id, true)}
                      />
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
        )}

        {suggestion && (
          <div className="flex flex-wrap items-center gap-2 border border-dashed border-hairline px-3 py-2 text-xs text-muted">
            <span className="flex-1 min-w-0">
              {suggestion.item.name} has been out for{" "}
              {suggestion.days >= 21
                ? `${Math.floor(suggestion.days / 7)} weeks`
                : `${suggestion.days} days`}{" "}
              — stop tracking?
            </span>
            <button
              type="button"
              onClick={() => onSetArchived(suggestion.item.id, true)}
              className="min-h-11 px-3 rounded-full text-[10px] tracking-widest uppercase border border-line-strong text-fg hover:border-accent transition-colors"
            >
              stop tracking
            </button>
            <button
              type="button"
              onClick={() =>
                setDismissedSuggestions((prev) =>
                  new Set(prev).add(suggestion.item.id),
                )
              }
              className="min-h-11 px-3 text-[10px] tracking-widest uppercase text-muted hover:text-fg transition-colors"
            >
              keep
            </button>
          </div>
        )}

        <button
          type="button"
          onClick={startAdd}
          className="flex w-full min-h-11 items-center px-3 rounded-full text-action lowercase border border-hairline text-muted hover:text-fg hover:border-accent transition-colors"
        >
          + add item
        </button>

        {archivedItems.length > 0 && (
          <details className="glass-panel px-3 py-2">
            <summary className="text-label uppercase text-muted cursor-pointer min-h-11 flex items-center list-none [&::-webkit-details-marker]:hidden">
              not tracking · {archivedItems.length} ▸
            </summary>
            <ul className="divide-y divide-hairline border-t border-hairline pb-1">
              {archivedFiltered.map((it) => (
                <ArchivedRow
                  key={it.id}
                  item={it}
                  onRestore={(id) => onSetArchived(id, false)}
                  onDelete={(id) => {
                    if (
                      window.confirm(`delete "${it.name}" forever? this cannot be undone.`)
                    ) {
                      onDeleteItem(id);
                    }
                  }}
                />
              ))}
            </ul>
          </details>
        )}

        <details className="glass-panel px-3 py-2">
          <summary className="text-label uppercase text-muted cursor-pointer min-h-11 flex items-center list-none [&::-webkit-details-marker]:hidden">
            groups · {groups.length} ▸
          </summary>
          <div className="space-y-3 pb-2">
            {groups.map((g) => (
              <GroupManageRow
                key={g.id}
                group={g}
                onUpdate={onUpdateGroup}
                onDelete={onDeleteGroup}
              />
            ))}
            {groupFormOpen ? (
              <GroupForm
                onCreate={onCreateGroup}
                onClose={() => setGroupFormOpen(false)}
              />
            ) : (
              <button
                type="button"
                onClick={() => setGroupFormOpen(true)}
                className="flex w-full min-h-11 items-center px-3 rounded-full text-action lowercase border border-dashed border-hairline text-muted hover:text-fg hover:border-accent transition-colors"
              >
                + new group
              </button>
            )}
          </div>
        </details>

        {(actionError || selectMode) && (
          <div className="sticky bottom-64 z-50 lg:bottom-52 space-y-2">
            {actionError && (
              <button
                type="button"
                onClick={() => setActionError(null)}
                className="block w-full min-h-11 text-left text-meta text-danger glass rounded-2xl px-3 py-2"
              >
                {actionError} · tap to dismiss
              </button>
            )}
            {selectMode && (
              <div className="flex flex-wrap items-center gap-2 glass rounded-2xl px-3 py-2">
                <span className="text-label uppercase text-muted tabular-nums">
                  {checkedIds.size} selected
                </span>
                <button
                  type="button"
                  onClick={bulkArchive}
                  disabled={checkedIds.size === 0}
                  className="min-h-11 px-3 rounded-full text-[10px] tracking-widest uppercase border border-line-strong text-fg hover:border-accent transition-colors disabled:opacity-40"
                >
                  stop tracking
                </button>
                <select
                  value=""
                  onChange={(e) => {
                    if (e.target.value === "") return;
                    bulkMove(e.target.value === "__none" ? null : e.target.value);
                  }}
                  disabled={checkedIds.size === 0}
                  aria-label="move selected to group"
                  className="min-h-11 bg-glass-well rounded-field border border-line-strong text-[10px] uppercase tracking-widest text-muted px-2 focus:outline-none focus:border-accent transition-colors disabled:opacity-40"
                >
                  <option value="">move to…</option>
                  <option value="__none">ungrouped</option>
                  {groups.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={bulkDelete}
                  disabled={checkedIds.size === 0}
                  className="min-h-11 px-3 text-[10px] tracking-widest uppercase text-danger hover:text-danger-hover transition-colors disabled:opacity-40"
                >
                  delete
                </button>
                <button
                  type="button"
                  onClick={exitSelectMode}
                  className="ml-auto min-h-11 px-3 text-[10px] tracking-widest uppercase text-muted hover:text-fg transition-colors"
                >
                  done
                </button>
              </div>
            )}
          </div>
        )}
      </section>

      <aside ref={asideRef} className="min-w-0 lg:sticky lg:top-8">
        {shoppingOpen ? (
          <ShoppingListPanel
            entries={shoppingEntries}
            items={activeItems}
            store={shoppingStore}
            shoppingDay={shoppingDay}
            onOpenItem={onSelect}
            onUpdateItem={onUpdateItem}
            onSaveSettings={onSaveShoppingSettings}
            onRefresh={() => router.refresh()}
          />
        ) : adding ? (
          <AddItemForm
            groups={groups}
            defaultGroupId={groups[0]?.id ?? null}
            recentUnits={recentUnits}
            onCreate={onCreateItem}
            onCancel={() => setAdding(false)}
          />
        ) : selectedItem ? (
          <ItemDetail
            key={selectedItem.id}
            userId={userId}
            item={selectedItem}
            groups={groups}
            recentUnits={recentUnits}
            usages={usages.filter(
              (u) => u.inventory_item_id === selectedItem.id,
            )}
            onUpdate={onUpdateItem}
            onStep={onStepQuantity}
            onArchive={(id) => onSetArchived(id, true)}
            onDelete={onDeleteItem}
            onCreateUsage={onCreateUsage}
            onUpdateUsage={onUpdateUsage}
            onDeleteUsage={onDeleteUsage}
          />
        ) : (
          <p className="glass-panel text-muted text-sm px-4 py-16 text-center">
            select an item to see its details, or add a new one.
          </p>
        )}
      </aside>
    </div>
  );
}

function GroupForm({
  onCreate,
  onClose,
}: {
  onCreate: (input: {
    name: string;
    color: string;
  }) => Promise<{ error: string | null }>;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [color, setColor] = useState<string>(PALETTE[0]);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const n = name.trim();
    if (!n) {
      setError("name required");
      return;
    }
    startTransition(async () => {
      const result = await onCreate({ name: n, color });
      if (result.error) {
        setError(result.error);
        return;
      }
      onClose();
    });
  }

  return (
    <form
      onSubmit={submit}
      className="glass-panel p-4 space-y-5"
    >
      <input
        ref={nameRef}
        value={name}
        onChange={(e) => setName(e.target.value)}
        type="text"
        placeholder="group name"
        maxLength={64}
        autoComplete="off"
        className="w-full bg-transparent text-fg placeholder-muted text-base font-bold focus:outline-none border-b border-line-strong focus:border-accent pb-2 transition-colors"
      />
      <ColorPicker value={color} onChange={setColor} />
      {error && <p className="text-danger text-xs">{error}</p>}
      <div className="flex gap-2 pt-2">
        <button
          type="submit"
          disabled={isPending}
          className="flex-1 rounded-full shadow-[inset_0_1px_0_rgba(255,255,255,0.25)] bg-accent text-accent-fg text-sm font-bold py-3 hover:opacity-90 transition-colors disabled:opacity-50"
        >
          create
        </button>
        <button
          type="button"
          onClick={onClose}
          className="px-4 text-muted text-sm hover:text-fg transition-colors"
        >
          cancel
        </button>
      </div>
    </form>
  );
}

function GroupManageRow({
  group,
  onUpdate,
  onDelete,
}: {
  group: InventoryGroup;
  onUpdate: (id: string, patch: Partial<InventoryGroup>) => void;
  onDelete: (id: string) => void;
}) {
  const [editOpen, setEditOpen] = useState(false);

  return (
    <div>
      <div className="flex items-stretch glass-panel overflow-hidden">
        <div className="flex-1 flex items-center gap-3 px-3 py-2 min-w-0">
          <span
            className="w-2 h-8 flex-shrink-0"
            style={{ backgroundColor: group.color }}
            aria-hidden
          />
          <span className="flex-1 truncate text-fg text-sm font-bold">
            {group.name}
          </span>
        </div>
        <button
          onClick={() => setEditOpen((v) => !v)}
          aria-label="group actions"
          className="px-3 border-l border-line text-muted hover:text-fg hover:bg-card-hover transition-colors text-lg"
        >
          ···
        </button>
      </div>

      {editOpen && (
        <GroupEditPanel
          group={group}
          onUpdate={onUpdate}
          onDelete={(id) => {
            setEditOpen(false);
            onDelete(id);
          }}
        />
      )}
    </div>
  );
}

function GroupEditPanel({
  group,
  onUpdate,
  onDelete,
}: {
  group: InventoryGroup;
  onUpdate: (id: string, patch: Partial<InventoryGroup>) => void;
  onDelete: (id: string) => void;
}) {
  const [nameDraft, setNameDraft] = useState(group.name);

  function commitName() {
    const next = nameDraft.trim();
    if (!next || next === group.name) {
      setNameDraft(group.name);
      return;
    }
    onUpdate(group.id, { name: next });
  }

  return (
    <div className="glass-panel p-4 space-y-5">
      <input
        type="text"
        value={nameDraft}
        onChange={(e) => setNameDraft(e.target.value)}
        onBlur={commitName}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            e.currentTarget.blur();
          }
          if (e.key === "Escape") {
            setNameDraft(group.name);
            e.currentTarget.blur();
          }
        }}
        maxLength={64}
        aria-label="group name"
        className="w-full bg-transparent text-fg text-base font-bold focus:outline-none border-b border-line-strong focus:border-accent pb-2 transition-colors"
      />
      <ColorPicker
        value={group.color}
        onChange={(c) => onUpdate(group.id, { color: c })}
      />
      <div className="flex justify-end pt-2">
        <button
          onClick={() => onDelete(group.id)}
          className="text-danger text-xs tracking-widest uppercase hover:text-danger-hover transition-colors py-2 px-3"
        >
          delete group
        </button>
      </div>
    </div>
  );
}

// A shelf row: tap to open details, steppers on the right, swipe left (touch)
// or hover (desktop) to reveal "stop tracking" without opening anything.
function ItemRow({
  item,
  hint,
  selected,
  selectMode,
  checked,
  onToggleCheck,
  onSelect,
  onAdjust,
  onArchive,
}: {
  item: InventoryItem;
  hint: { status: StockStatus; runOut: string | null };
  selected: boolean;
  selectMode: boolean;
  checked: boolean;
  onToggleCheck: (id: string) => void;
  onSelect: (id: string) => void;
  onAdjust: (id: string, delta: number) => void;
  onArchive: (id: string) => void;
}) {
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{
    x: number;
    y: number;
    base: number;
    decided: boolean;
  } | null>(null);
  const suppressClick = useRef(false);

  function onPointerDown(e: React.PointerEvent) {
    if (selectMode) return;
    drag.current = { x: e.clientX, y: e.clientY, base: offset, decided: false };
  }

  function onPointerMove(e: React.PointerEvent) {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.decided) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      if (Math.abs(dx) <= Math.abs(dy)) {
        drag.current = null;
        return;
      }
      d.decided = true;
      setDragging(true);
      suppressClick.current = true;
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    }
    setOffset(Math.min(0, Math.max(-96, d.base + dx)));
  }

  function onPointerEnd() {
    if (drag.current?.decided) {
      setOffset((o) => (o < -48 ? -96 : 0));
    }
    drag.current = null;
    setDragging(false);
  }

  function onClickCapture(e: React.MouseEvent) {
    if (suppressClick.current) {
      suppressClick.current = false;
      e.preventDefault();
      e.stopPropagation();
    }
  }

  const out = hint.status === "out";
  const statusLabel = out
    ? "out"
    : hint.status === "low"
      ? "low"
      : hint.runOut !== null
        ? `≈ ${formatRunOut(hint.runOut)}`
        : null;

  return (
    <li
      className={`relative overflow-hidden group/row transition-colors ${
        selected ? "bg-card-hover" : ""
      }`}
    >
      {offset < 0 && (
        <button
          type="button"
          onClick={() => {
            setOffset(0);
            onArchive(item.id);
          }}
          className="absolute inset-y-0 right-0 w-24 flex items-center justify-center bg-line text-[10px] tracking-widest uppercase text-fg"
        >
          stop
        </button>
      )}
      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onClickCapture={onClickCapture}
        style={{
          transform: `translateX(${offset}px)`,
          touchAction: "pan-y",
        }}
        className={`flex items-stretch bg-page ${dragging ? "" : "transition-transform duration-150"} ${
          selected ? "bg-card-hover" : ""
        }`}
      >
        {selectMode && (
          <button
            type="button"
            onClick={() => onToggleCheck(item.id)}
            aria-label={`select ${item.name}`}
            aria-pressed={checked}
            className="w-11 flex items-center justify-center flex-shrink-0"
          >
            <span
              className={`w-4 h-4 border transition-colors ${
                checked ? "bg-accent border-accent" : "border-line-strong"
              }`}
              aria-hidden
            />
          </button>
        )}
        <button
          onClick={() =>
            selectMode ? onToggleCheck(item.id) : onSelect(item.id)
          }
          className="flex-1 min-w-0 text-left flex items-center gap-3 px-3 min-h-11 py-2 hover:bg-card-hover transition-colors"
        >
          <span className="relative w-8 h-8 flex-shrink-0">
            {item.image_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={item.image_url}
                alt=""
                className={`w-8 h-8 object-cover border border-line bg-page ${
                  out ? "grayscale opacity-40" : ""
                }`}
              />
            ) : (
              <span
                className={`block w-8 h-8 border border-dashed border-line-subtle ${
                  out ? "opacity-40" : ""
                }`}
                aria-hidden
              />
            )}
            {out && (
              <span
                className="absolute -top-1 -right-1 w-3.5 h-3.5 flex items-center justify-center bg-danger text-white text-[9px] leading-none"
                aria-hidden
              >
                !
              </span>
            )}
          </span>
          <span
            className={`flex-1 min-w-0 truncate text-sm ${out ? "text-muted" : "text-fg"}`}
          >
            {item.name}
            {item.priority === "high" && (
              <span className="ml-2 text-[10px] text-danger" aria-label="high priority">
                !!!
              </span>
            )}
          </span>
          {statusLabel !== null && (
            <span
              className={`flex-shrink-0 max-w-[45%] truncate text-meta ${
                hint.status !== "ok" ? "text-danger" : "text-muted"
              }`}
            >
              {statusLabel}
            </span>
          )}
        </button>
        {!selectMode && (
          <button
            type="button"
            onClick={() => onArchive(item.id)}
            aria-label={`stop tracking ${item.name}`}
            title="stop tracking"
            className="hidden lg:flex w-11 items-center justify-center border-l border-line text-muted text-[10px] tracking-widest uppercase opacity-0 group-hover/row:opacity-100 focus:opacity-100 hover:text-fg hover:bg-card-hover transition-all"
          >
            ⏏
          </button>
        )}
        <div className="flex items-stretch flex-shrink-0 border-l border-line">
          <button
            type="button"
            onClick={() => onAdjust(item.id, -1)}
            aria-label={`decrease ${item.name}`}
            className="w-11 flex items-center justify-center text-muted text-lg leading-none hover:text-fg hover:bg-card-hover transition-colors"
          >
            −
          </button>
          <span className="flex w-16 items-center justify-center text-fg text-xs tabular-nums text-center px-1">
            {formatQty(item.quantity)}
            {item.unit ? ` ${item.unit}` : ""}
          </span>
          <button
            type="button"
            onClick={() => onAdjust(item.id, 1)}
            aria-label={`increase ${item.name}`}
            className="w-11 flex items-center justify-center border-l border-line text-muted text-lg leading-none hover:text-fg hover:bg-card-hover transition-colors"
          >
            +
          </button>
        </div>
      </div>
    </li>
  );
}

function ArchivedRow({
  item,
  onRestore,
  onDelete,
}: {
  item: InventoryItem;
  onRestore: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const since = item.archived_at
    ? new Date(item.archived_at)
        .toLocaleDateString("en-US", { month: "short", day: "numeric" })
        .toLowerCase()
    : null;

  return (
    <li className="flex items-center gap-2 min-h-11">
      <span className="flex-1 min-w-0 truncate text-sm text-muted">
        {item.name}
        {since && <span className="text-meta"> · since {since}</span>}
      </span>
      <button
        type="button"
        onClick={() => onRestore(item.id)}
        className="min-h-11 px-3 rounded-full text-[10px] tracking-widest uppercase border border-line-strong text-fg hover:border-accent transition-colors"
      >
        restore
      </button>
      <button
        type="button"
        onClick={() => onDelete(item.id)}
        className="min-h-11 px-3 text-[10px] tracking-widest uppercase text-danger hover:text-danger-hover transition-colors"
      >
        delete forever
      </button>
    </li>
  );
}

function ItemTile({
  item,
  color,
  selected,
  onSelect,
  onAdjust,
}: {
  item: InventoryItem;
  color: string | null;
  selected: boolean;
  onSelect: (id: string) => void;
  onAdjust: (id: string, delta: number) => void;
}) {
  const out = Number(item.quantity) <= 0;
  return (
    <div
      className={`relative flex aspect-square flex-col overflow-hidden glass-panel transition-colors ${
        selected ? "border-accent ring-1 ring-accent" : "hover:border-fg"
      }`}
      style={color ? { backgroundColor: hexToRgba(color, 0.1) } : undefined}
    >
      <span
        className="h-1.5 w-full flex-shrink-0"
        style={{ backgroundColor: color ?? "var(--border-subtle)" }}
        aria-hidden
      />
      <button
        type="button"
        onClick={() => onSelect(item.id)}
        title={item.name}
        aria-pressed={selected}
        className="flex min-h-0 flex-1 flex-col text-left"
      >
        <span className="relative min-h-0 flex-1">
          {item.image_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={item.image_url}
              alt=""
              className={`absolute inset-0 h-full w-full object-cover ${
                out ? "grayscale opacity-40" : ""
              }`}
            />
          ) : (
            <span
              className={`absolute inset-0 flex items-center justify-center text-2xl font-bold text-muted ${
                out ? "opacity-40" : ""
              }`}
            >
              {item.name.slice(0, 1).toUpperCase()}
            </span>
          )}
          {out && (
            <span
              className="absolute top-1 right-1 w-4 h-4 flex items-center justify-center bg-danger text-white text-[10px] leading-none"
              aria-hidden
            >
              !
            </span>
          )}
          <span className="absolute bottom-1 right-1 rounded-full border border-line bg-page/85 px-1 py-0.5 text-[10px] leading-none text-fg tabular-nums">
            {formatQty(item.quantity)}
            {item.unit ? ` ${item.unit}` : ""}
          </span>
        </span>
        <span className="truncate border-t border-line px-1.5 py-1 text-[10px] text-fg">
          {item.name}
        </span>
      </button>
      <div className="flex items-stretch border-t border-line text-fg">
        <button
          type="button"
          onClick={() => onAdjust(item.id, -1)}
          aria-label={`decrease ${item.name}`}
          className="flex-1 min-h-11 flex items-center justify-center border-r border-line text-base leading-none hover:bg-card-hover transition-colors"
        >
          −
        </button>
        <button
          type="button"
          onClick={() => onAdjust(item.id, 1)}
          aria-label={`increase ${item.name}`}
          className="flex-1 min-h-11 flex items-center justify-center text-base leading-none hover:bg-card-hover transition-colors"
        >
          +
        </button>
      </div>
    </div>
  );
}

// Two different writes wear one control. Typing a number is a RECOUNT and
// commits absolutely (onCommit). The −/+ buttons are a STEP: when the field is
// bound to a stored row, onStep sends the delta so the server applies it to the
// live quantity — without it those buttons read the on-screen number and write
// back an absolute, which is the stale overwrite this path exists to prevent.
// onStep is omitted only where there is no row yet (the add form), where the
// local draft is the only truth there is.
//
// Exported for __tests__/inventory-quantity-field.test.tsx — the recount/step
// split is silent in both directions when it breaks, so it is pinned directly
// rather than through the whole client.
export function QuantityField({
  value,
  onCommit,
  onStep,
}: {
  value: number;
  onCommit: (n: number) => void;
  onStep?: (delta: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  const [prevValue, setPrevValue] = useState(value);
  // Whether the draft is the user's own typing rather than a mirror of `value`.
  // It is what tells an assertion ("I counted 2") apart from a stray focus.
  //
  // Set from keydown as well as change, because re-typing the number already in
  // the box fires no change event — the DOM value never differs, so React
  // dedupes it away. That is browser behaviour, not a test artifact, and
  // select-all-then-retype is exactly how someone confirms a count.
  const [typed, setTyped] = useState(false);
  if (value !== prevValue) {
    setPrevValue(value);
    setDraft(String(value));
    setTyped(false);
  }

  // An emptied field means "I'm retyping", never "set this to zero" — Number("")
  // is 0, so without the blank guard clearing the box and tapping away silently
  // zeroes the item's real stock.
  function commit(raw: string) {
    const trimmed = raw.trim();
    const n = trimmed === "" ? NaN : Number(trimmed);
    if (!Number.isFinite(n) || n < 0) {
      setDraft(String(value));
      setTyped(false);
      return;
    }
    const rounded = Math.round(n * 1000) / 1000;
    // Deliberately NOT `if (rounded !== value)`. A recount is the user
    // asserting ground truth about the shelf, and this view's number may be
    // stale — typing 2 against a row an agent pushed to 5 has to land, and
    // comparing against the stale 2 would skip the write and leave the
    // divergence in place with no feedback. An untouched field asserts
    // nothing, so blurring without typing writes nothing (that would be the
    // stale overwrite in the other direction).
    if (typed) onCommit(rounded);
    setDraft(String(rounded));
    setTyped(false);
  }

  function step(delta: number) {
    if (onStep) {
      // The draft is deliberately left alone: the server decides the number
      // from the row, and the parent's optimistic update flows back through
      // `value`. Synthesizing a draft here strands it when the write doesn't
      // move `value` (a − clamped at 0), and the next blur would commit that
      // invented number as a recount nobody typed.
      onStep(delta);
      return;
    }
    const trimmed = draft.trim();
    const parsed = trimmed === "" ? NaN : Number(trimmed);
    const base = Number.isFinite(parsed) ? parsed : value;
    onCommit(Math.max(0, Math.round((base + delta) * 1000) / 1000));
  }

  return (
    <div className="flex items-stretch">
      <button
        type="button"
        onClick={() => step(-1)}
        aria-label="decrease quantity"
        className="min-h-11 w-11 rounded-l-full border border-line-strong text-fg text-lg leading-none hover:border-fg hover:bg-card-hover transition-colors press"
      >
        −
      </button>
      <input
        type="number"
        inputMode="decimal"
        step="any"
        min={0}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          setTyped(true);
        }}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            e.currentTarget.blur();
            return;
          }
          // Only keys that can alter the text count, so tabbing or arrowing
          // through the field is still not an assertion.
          if (e.key === "Backspace" || e.key === "Delete" || e.key.length === 1) {
            setTyped(true);
          }
        }}
        aria-label="quantity"
        className="min-h-11 w-24 text-center bg-glass-well border-y border-line-strong focus:border-accent text-fg text-base focus:outline-none transition-colors"
      />
      <button
        type="button"
        onClick={() => step(1)}
        aria-label="increase quantity"
        className="min-h-11 w-11 rounded-r-full border border-line-strong text-fg text-lg leading-none hover:border-fg hover:bg-card-hover transition-colors press"
      >
        +
      </button>
    </div>
  );
}

function GroupSelect({
  value,
  groups,
  onChange,
}: {
  value: string | null;
  groups: InventoryGroup[];
  onChange: (id: string | null) => void;
}) {
  return (
    <select
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value || null)}
      aria-label="inventory group"
      className="w-full bg-glass-well rounded-field border border-line-strong focus:border-accent text-fg text-xs uppercase tracking-widest px-2 py-2 focus:outline-none transition-colors"
    >
      <option value="">ungrouped</option>
      {groups.map((g) => (
        <option key={g.id} value={g.id}>
          {g.name}
        </option>
      ))}
    </select>
  );
}

function AddItemForm({
  groups,
  defaultGroupId,
  recentUnits,
  onCreate,
  onCancel,
}: {
  groups: InventoryGroup[];
  defaultGroupId: string | null;
  recentUnits: string[];
  onCreate: (input: {
    name: string;
    quantity: number;
    unit: string;
    groupId: string | null;
  }) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [quantity, setQuantity] = useState(1);
  const [unit, setUnit] = useState("");
  const [groupId, setGroupId] = useState<string | null>(defaultGroupId);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const n = name.trim();
    if (!n) {
      setError("name required");
      return;
    }
    onCreate({ name: n, quantity, unit: unit.trim(), groupId });
  }

  return (
    <form
      onSubmit={submit}
      className="glass-panel p-4 space-y-5"
    >
      <p className="text-[10px] tracking-widest uppercase text-muted">
        new item
      </p>
      <input
        ref={nameRef}
        value={name}
        onChange={(e) => setName(e.target.value)}
        type="text"
        placeholder="item name"
        maxLength={120}
        autoComplete="off"
        className="w-full bg-transparent text-fg placeholder-muted text-base font-bold focus:outline-none border-b border-line-strong focus:border-accent pb-2 transition-colors"
      />

      <div className="space-y-2">
        <p className="text-[10px] tracking-widest uppercase text-muted">
          quantity
        </p>
        <QuantityField value={quantity} onCommit={setQuantity} />
      </div>

      <UnitPicker value={unit} onChange={setUnit} recent={recentUnits} />

      <div className="space-y-2">
        <p className="text-[10px] tracking-widest uppercase text-muted">
          group
        </p>
        <GroupSelect value={groupId} groups={groups} onChange={setGroupId} />
      </div>

      {error && <p className="text-danger text-xs">{error}</p>}

      <div className="flex gap-2 pt-2">
        <button
          type="submit"
          className="flex-1 rounded-full shadow-[inset_0_1px_0_rgba(255,255,255,0.25)] bg-accent text-accent-fg text-sm font-bold py-3 hover:opacity-90 transition-colors"
        >
          add
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="px-4 text-muted text-sm hover:text-fg transition-colors"
        >
          cancel
        </button>
      </div>
    </form>
  );
}

function ItemDetail({
  userId,
  item,
  groups,
  recentUnits,
  usages,
  onUpdate,
  onStep,
  onArchive,
  onDelete,
  onCreateUsage,
  onUpdateUsage,
  onDeleteUsage,
}: {
  userId: string;
  item: InventoryItem;
  groups: InventoryGroup[];
  recentUnits: string[];
  usages: InventoryUsage[];
  onUpdate: (id: string, patch: Partial<InventoryItem>) => void;
  onStep: (id: string, delta: number) => void;
  onArchive: (id: string) => void;
  onDelete: (id: string) => void;
  onCreateUsage: (
    itemId: string,
    input: { amount: number; period: UsagePeriod; intervalDays: number | null },
  ) => void;
  onUpdateUsage: (
    id: string,
    input: { amount: number; period: UsagePeriod; intervalDays: number | null },
  ) => void;
  onDeleteUsage: (id: string) => void;
}) {
  const [nameDraft, setNameDraft] = useState(item.name);
  const [notesDraft, setNotesDraft] = useState(item.notes ?? "");
  const [genPrompt, setGenPrompt] = useState(item.name);
  const [busy, setBusy] = useState(false);
  const [iconError, setIconError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function commitName() {
    const next = nameDraft.trim();
    if (!next || next === item.name) {
      setNameDraft(item.name);
      return;
    }
    onUpdate(item.id, { name: next });
  }

  function commitNotes() {
    const next = notesDraft.trim();
    const current = item.notes ?? "";
    if (next === current) return;
    onUpdate(item.id, { notes: next || null });
  }

  async function onUpload(file: File) {
    setBusy(true);
    setIconError(null);
    try {
      const supabase = createClient();
      const rawExt = file.name.split(".").pop()?.toLowerCase() ?? "";
      const ext = /^[a-z0-9]{1,5}$/.test(rawExt) ? rawExt : "png";
      const path = `${userId}/${item.id}/${crypto.randomUUID()}.${ext}`;
      const { error } = await supabase.storage
        .from(ICON_BUCKET)
        .upload(path, file, {
          contentType: file.type || "image/png",
          upsert: false,
        });
      if (error) {
        setIconError(error.message);
        return;
      }
      const { data } = supabase.storage.from(ICON_BUCKET).getPublicUrl(path);
      onUpdate(item.id, { image_url: data.publicUrl });
    } finally {
      setBusy(false);
    }
  }

  async function onGenerate() {
    const settings = readImageGenSettings();
    const p = genPrompt.trim() || item.name;
    setBusy(true);
    setIconError(null);
    try {
      const result = await generateItemIcon({
        id: item.id,
        prompt: p,
        provider: settings.provider,
        model: activeModelFor(settings),
      });
      if (result.error || !result.url) {
        setIconError(result.error ?? "generation failed");
        return;
      }
      onUpdate(item.id, { image_url: result.url });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="glass-panel p-4 space-y-5">
      <div className="space-y-2 border-b border-hairline pb-4">
        <p className="text-[10px] tracking-widest uppercase text-muted">icon</p>
        <div className="flex gap-3">
          {item.image_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={item.image_url}
              alt=""
              className="w-20 h-20 flex-shrink-0 object-cover border border-line bg-page"
            />
          ) : (
            <div
              className="w-20 h-20 flex-shrink-0 border border-dashed border-line-subtle bg-page flex items-center justify-center text-muted text-[10px] tracking-widest uppercase"
              aria-hidden
            >
              none
            </div>
          )}
          <div className="flex-1 min-w-0 space-y-2">
            <input
              type="text"
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onBlur={commitName}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  e.currentTarget.blur();
                }
                if (e.key === "Escape") {
                  setNameDraft(item.name);
                  e.currentTarget.blur();
                }
              }}
              maxLength={120}
              aria-label="item name"
              className="w-full bg-transparent text-fg text-xl font-bold focus:outline-none border-b border-line-strong focus:border-accent pb-2 transition-colors"
            />
            <input
              type="text"
              value={genPrompt}
              onChange={(e) => setGenPrompt(e.target.value)}
              placeholder="describe the icon…"
              maxLength={300}
              aria-label="icon prompt"
              className="w-full bg-glass-well rounded-field border border-line-strong focus:border-accent text-fg placeholder-muted text-sm px-3 py-2 focus:outline-none transition-colors"
            />
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={onGenerate}
                disabled={busy}
                className="text-[10px] tracking-widest uppercase px-3 py-2 rounded-full border border-fg text-fg hover:bg-fg hover:text-page transition-colors disabled:opacity-50"
              >
                {busy ? "working…" : "generate"}
              </button>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={busy}
                className="text-[10px] tracking-widest uppercase px-3 py-2 rounded-full border border-line-strong text-muted hover:border-fg hover:text-fg transition-colors disabled:opacity-50"
              >
                upload
              </button>
              {item.image_url && (
                <button
                  type="button"
                  onClick={() => onUpdate(item.id, { image_url: null })}
                  disabled={busy}
                  className="text-[10px] tracking-widest uppercase px-3 py-2 text-danger hover:text-danger-hover transition-colors disabled:opacity-50"
                >
                  remove
                </button>
              )}
            </div>
          </div>
        </div>
        {iconError && <p className="text-danger text-xs">{iconError}</p>}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onUpload(f);
            e.target.value = "";
          }}
          tabIndex={-1}
          aria-hidden
          className="sr-only"
        />
      </div>

      <div className="space-y-2">
        <p className="text-[10px] tracking-widest uppercase text-muted">
          quantity
        </p>
        <QuantityField
          value={Number(item.quantity)}
          onCommit={(n) => onUpdate(item.id, { quantity: n })}
          onStep={(delta) => onStep(item.id, delta)}
        />
      </div>

      <UnitPicker
        value={item.unit}
        onChange={(u) => onUpdate(item.id, { unit: u })}
        recent={recentUnits}
      />

      <div className="border-t border-line pt-5">
        <InventoryCalendar
          item={item}
          usages={usages}
          onCreateUsage={(input) => onCreateUsage(item.id, input)}
          onUpdateUsage={onUpdateUsage}
          onDeleteUsage={onDeleteUsage}
          onUpdateThreshold={(value) =>
            onUpdate(item.id, { reorder_threshold: value })
          }
        />
      </div>

      <div className="space-y-2">
        <p className="text-[10px] tracking-widest uppercase text-muted">
          group
        </p>
        <GroupSelect
          value={item.inventory_group_id}
          groups={groups}
          onChange={(id) => onUpdate(item.id, { inventory_group_id: id })}
        />
      </div>

      <div className="space-y-2">
        <p className="text-[10px] tracking-widest uppercase text-muted">
          priority
        </p>
        <div className="flex items-center gap-2">
          {(["low", "med", "high"] as const).map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => onUpdate(item.id, { priority: p })}
              className={`min-h-11 rounded-full text-[10px] tracking-widest uppercase px-3 border transition-colors ${
                item.priority === p
                  ? p === "high"
                    ? "bg-danger text-white border-danger"
                    : "bg-accent text-accent-fg border-accent"
                  : p === "high"
                    ? "border-line-strong text-danger hover:border-danger"
                    : "border-line-strong text-muted hover:border-fg hover:text-fg"
              }`}
            >
              {p === "low" ? "!" : p === "med" ? "!!" : "!!!"}
            </button>
          ))}
        </div>
        <p className="text-[10px] text-muted leading-relaxed">
          high surfaces on home while running low · med only when out · low
          stays here
        </p>
      </div>

      <div className="space-y-2">
        <label
          htmlFor={`item-notes-${item.id}`}
          className="text-[10px] tracking-widest uppercase text-muted"
        >
          notes
        </label>
        <textarea
          id={`item-notes-${item.id}`}
          value={notesDraft}
          onChange={(e) => setNotesDraft(e.target.value)}
          onBlur={commitNotes}
          placeholder="add details…"
          maxLength={5000}
          rows={4}
          className="w-full resize-y bg-glass-well rounded-field border border-line-strong focus:border-accent text-fg placeholder-muted text-sm leading-relaxed px-3 py-2 focus:outline-none transition-colors"
        />
      </div>

      <div className="space-y-2">
        <p className="text-[10px] tracking-widest uppercase text-muted">
          shopping list
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() =>
              onUpdate(item.id, { shopping_pinned: !item.shopping_pinned })
            }
            aria-pressed={item.shopping_pinned}
            className={`min-h-11 rounded-full text-[10px] tracking-widest uppercase px-3 border transition-colors ${
              item.shopping_pinned
                ? "bg-accent text-accent-fg border-accent"
                : "border-line-strong text-muted hover:border-fg hover:text-fg"
            }`}
          >
            {item.shopping_pinned ? "on the list" : "add to list"}
          </button>
          <PriceField item={item} onUpdate={onUpdate} />
        </div>
        <p className="text-[10px] text-muted leading-relaxed">
          pinned items stay on the shopping list · price is per package and
          feeds the finance forecast
        </p>
      </div>

      <div className="flex items-center justify-between border-t border-hairline pt-3">
        <button
          type="button"
          onClick={() => onArchive(item.id)}
          className="min-h-11 px-3 rounded-full text-[10px] tracking-widest uppercase border border-line-strong text-fg hover:border-accent transition-colors"
        >
          stop tracking
        </button>
        <button
          type="button"
          onClick={() => {
            if (
              window.confirm(
                `delete "${item.name}" forever? "stop tracking" keeps it recoverable.`,
              )
            ) {
              onDelete(item.id);
            }
          }}
          className="min-h-11 px-3 text-[10px] tracking-widest uppercase text-danger hover:text-danger-hover transition-colors"
        >
          delete forever
        </button>
      </div>
    </div>
  );
}

const DAY_LABELS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

// The buy list: derived entries (out/low/soon) plus manual pins, with editable
// per-package prices. The store + shopping day it shows feed the AI price
// lookups and the finance forecast's grocery layer.
function ShoppingListPanel({
  entries,
  items,
  store,
  shoppingDay,
  onOpenItem,
  onUpdateItem,
  onSaveSettings,
  onRefresh,
}: {
  entries: ShoppingEntry[];
  items: InventoryItem[];
  store: string | null;
  shoppingDay: number | null;
  onOpenItem: (id: string) => void;
  onUpdateItem: (id: string, patch: Partial<InventoryItem>) => void;
  onSaveSettings: (input: { store?: string | null; shoppingDay?: number | null }) => void;
  onRefresh: () => void;
}) {
  const [storeDraft, setStoreDraft] = useState(store ?? "");
  const [prevStore, setPrevStore] = useState(store);
  if (store !== prevStore) {
    setPrevStore(store);
    setStoreDraft(store ?? "");
  }
  const [addDraft, setAddDraft] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [lookingUp, setLookingUp] = useState(false);
  const [lookupNote, setLookupNote] = useState<string | null>(null);

  const imageById = useMemo(
    () => new Map(items.map((it) => [it.id, it.image_url])),
    [items],
  );
  const { total, unpricedCount } = shoppingTotal(entries);

  function commitStore() {
    const next = storeDraft.trim() || null;
    if (next === store) return;
    onSaveSettings({ store: next });
  }

  function onAddSubmit(e: React.FormEvent) {
    e.preventDefault();
    const ref = addDraft.trim();
    if (!ref) return;
    const pool: ResolvableItem[] = items.map((it) => ({
      id: it.id,
      name: it.name,
      quantity: Number(it.quantity),
      unit: it.unit,
      archived: it.archived,
    }));
    const found = resolveItemRef(ref, pool);
    if (!found.ok) {
      setAddError(found.error);
      return;
    }
    setAddError(null);
    setAddDraft("");
    onUpdateItem(found.value.id, { shopping_pinned: true });
  }

  async function refreshPrices() {
    const unpriced = entries
      .filter((entry) => entry.estPrice === null)
      .map((entry) => entry.id);
    if (unpriced.length === 0) {
      setLookupNote("everything has a price already");
      return;
    }
    setLookingUp(true);
    setLookupNote(null);
    try {
      const result = await lookupItemPrices({ itemIds: unpriced.slice(0, 10) });
      if (result.error) {
        setLookupNote(result.error);
      } else {
        const found =
          result.results?.filter((r) => r.price !== null).length ?? 0;
        setLookupNote(
          found === 0 ? "no prices found" : `${found} price${found === 1 ? "" : "s"} found`,
        );
        onRefresh();
      }
    } finally {
      setLookingUp(false);
    }
  }

  return (
    <div className="glass-panel p-4 space-y-4">
      <h2 className="text-title text-fg border-b border-hairline pb-2">
        shopping list
      </h2>

      <div className="space-y-2">
        <label
          htmlFor="shopping-store"
          className="text-[10px] tracking-widest uppercase text-muted"
        >
          store
        </label>
        <input
          id="shopping-store"
          type="text"
          value={storeDraft}
          onChange={(e) => setStoreDraft(e.target.value)}
          onBlur={commitStore}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              e.currentTarget.blur();
            }
          }}
          placeholder='e.g. "Save-On-Foods Wesbrook, Vancouver"'
          maxLength={200}
          className="w-full bg-glass-well rounded-field border border-line-strong focus:border-accent text-fg placeholder-muted text-sm px-3 py-2 focus:outline-none transition-colors"
        />
        <div className="flex items-center gap-2">
          <label
            htmlFor="shopping-day"
            className="text-[10px] tracking-widest uppercase text-muted"
          >
            shops on
          </label>
          <select
            id="shopping-day"
            value={shoppingDay === null ? "" : String(shoppingDay)}
            onChange={(e) =>
              onSaveSettings({
                shoppingDay: e.target.value === "" ? null : Number(e.target.value),
              })
            }
            className="min-h-9 bg-glass-well rounded-field border border-line-strong text-[10px] uppercase tracking-widest text-fg px-2 focus:outline-none focus:border-accent transition-colors"
          >
            <option value="">not set</option>
            {DAY_LABELS.map((label, day) => (
              <option key={label} value={day}>
                {label}s
              </option>
            ))}
          </select>
        </div>
        <p className="text-[10px] text-muted leading-relaxed">
          the store powers price look-ups · the day anchors grocery spend on the
          finance calendar
        </p>
      </div>

      {entries.length === 0 ? (
        <p className="border border-dashed border-line-strong text-muted text-sm px-4 py-10 text-center">
          nothing to buy.
        </p>
      ) : (
        <ul className="border-y border-hairline divide-y divide-hairline">
          {entries.map((entry) => (
            <li key={entry.id} className="flex items-center gap-2 min-h-11 py-1">
              <span className="relative w-6 h-6 flex-shrink-0">
                {imageById.get(entry.id) ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={imageById.get(entry.id) as string}
                    alt=""
                    className={`w-6 h-6 object-cover border border-line bg-page ${
                      entry.reason === "out" ? "grayscale opacity-40" : ""
                    }`}
                  />
                ) : (
                  <span
                    className="block w-6 h-6 border border-dashed border-line-subtle"
                    aria-hidden
                  />
                )}
              </span>
              <button
                type="button"
                onClick={() => onOpenItem(entry.id)}
                className="flex-1 min-w-0 text-left truncate text-sm text-fg hover:underline"
              >
                {entry.name}
                <span className="ml-2 text-meta text-muted tabular-nums">
                  {formatQty(entry.quantity)}
                  {entry.unit ? ` ${entry.unit}` : ""}
                </span>
              </button>
              <span
                className={`flex-shrink-0 text-meta ${
                  entry.reason === "out" || entry.reason === "low"
                    ? "text-danger"
                    : "text-muted"
                }`}
              >
                {entry.reason === "soon"
                  ? `≈ ${formatRunOut(entry.buyBy ?? entry.runOutDate ?? "")}`
                  : entry.reason}
              </span>
              <BuyQty
                entry={entry}
                onUpdateItem={onUpdateItem}
                onRefresh={onRefresh}
              />
              <RowPrice entry={entry} onUpdateItem={onUpdateItem} />
              {entry.pinned && (
                <button
                  type="button"
                  onClick={() => onUpdateItem(entry.id, { shopping_pinned: false })}
                  aria-label={`remove ${entry.name} from shopping list`}
                  className="min-h-9 px-2 text-[10px] tracking-widest uppercase text-muted hover:text-fg transition-colors"
                >
                  unpin
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {entries.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-fg tabular-nums">
            total ~${total.toFixed(2)}
          </span>
          {unpricedCount > 0 && (
            <span className="text-meta text-muted">
              · {unpricedCount} unpriced
            </span>
          )}
          <button
            type="button"
            onClick={refreshPrices}
            disabled={lookingUp}
            className="ml-auto min-h-9 px-3 rounded-full text-[10px] tracking-widest uppercase border border-line-strong text-fg hover:border-accent transition-colors disabled:opacity-50"
          >
            {lookingUp ? "looking up…" : "look up prices"}
          </button>
        </div>
      )}
      {lookupNote && <p className="text-[10px] text-muted">{lookupNote}</p>}

      <form onSubmit={onAddSubmit} className="space-y-1">
        <div className="flex gap-2">
          <input
            type="text"
            value={addDraft}
            onChange={(e) => setAddDraft(e.target.value)}
            placeholder="pin an item by name…"
            aria-label="pin an item to the shopping list"
            className="flex-1 min-w-0 bg-glass-well rounded-field border border-line-strong focus:border-accent text-fg placeholder-muted text-sm px-3 py-2 focus:outline-none transition-colors"
          />
          <button
            type="submit"
            className="min-h-9 px-3 rounded-full text-[10px] tracking-widest uppercase border border-line-strong text-fg hover:border-accent transition-colors"
          >
            pin
          </button>
        </div>
        {addError && <p className="text-danger text-xs">{addError}</p>}
      </form>
    </div>
  );
}

// How much of the item the user plans to buy, in its own unit. Changing it
// re-fetches an AI price for the new plan (the model does the pack math —
// chicken comes in packs of 2/4/6, so the total isn't price × amount). Manual
// prices are left alone.
function BuyQty({
  entry,
  onUpdateItem,
  onRefresh,
}: {
  entry: ShoppingEntry;
  onUpdateItem: (id: string, patch: Partial<InventoryItem>) => void;
  onRefresh: () => void;
}) {
  const [draft, setDraft] = useState(
    entry.buyAmount === null ? "" : String(entry.buyAmount),
  );
  const [prevBuy, setPrevBuy] = useState(entry.buyAmount);
  if (entry.buyAmount !== prevBuy) {
    setPrevBuy(entry.buyAmount);
    setDraft(entry.buyAmount === null ? "" : String(entry.buyAmount));
  }
  const [looking, setLooking] = useState(false);

  async function commit() {
    const trimmed = draft.trim();
    let next: number | null;
    if (trimmed === "") {
      next = null;
    } else {
      const n = Number(trimmed);
      if (!Number.isFinite(n) || n <= 0) {
        setDraft(entry.buyAmount === null ? "" : String(entry.buyAmount));
        return;
      }
      next = Math.round(n * 1000) / 1000;
    }
    if (next === entry.buyAmount) return;
    onUpdateItem(entry.id, { buy_amount: next });
    if (entry.priceSource !== "manual") {
      setLooking(true);
      try {
        await lookupItemPrices({ itemIds: [entry.id], force: true });
        onRefresh();
      } finally {
        setLooking(false);
      }
    }
  }

  return (
    <input
      type="number"
      inputMode="decimal"
      min={0}
      step="any"
      value={draft}
      disabled={looking}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          e.currentTarget.blur();
        }
        if (e.key === "Escape") {
          setDraft(entry.buyAmount === null ? "" : String(entry.buyAmount));
          e.currentTarget.blur();
        }
      }}
      placeholder="qty"
      title={`how many ${entry.unit || "of this"} you'll buy`}
      aria-label={`planned buy amount for ${entry.name}`}
      className="w-12 min-h-9 bg-glass-well rounded-field border border-line-strong focus:border-accent text-fg text-sm text-center placeholder-muted focus:outline-none transition-colors disabled:opacity-50"
    />
  );
}

function RowPrice({
  entry,
  onUpdateItem,
}: {
  entry: ShoppingEntry;
  onUpdateItem: (id: string, patch: Partial<InventoryItem>) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  function commit() {
    setEditing(false);
    const trimmed = draft.trim();
    if (trimmed === "") {
      if (entry.estPrice !== null) {
        onUpdateItem(entry.id, { est_price: null, price_source: null });
      }
      return;
    }
    const n = Number(trimmed);
    if (!Number.isFinite(n) || n <= 0) return;
    const rounded = Math.round(n * 100) / 100;
    if (rounded === entry.estPrice) return;
    onUpdateItem(entry.id, { est_price: rounded, price_source: "manual" });
  }

  if (editing) {
    return (
      <input
        autoFocus
        type="number"
        inputMode="decimal"
        min={0}
        step="0.01"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          }
          if (e.key === "Escape") setEditing(false);
        }}
        aria-label={`price for ${entry.name}`}
        className="w-20 min-h-9 bg-glass-well rounded-field border border-line-strong focus:border-accent text-fg text-sm text-center focus:outline-none transition-colors"
      />
    );
  }

  return (
    <button
      type="button"
      onClick={() => {
        setDraft(entry.estPrice === null ? "" : String(entry.estPrice));
        setEditing(true);
      }}
      aria-label={`edit price for ${entry.name}`}
      className={`min-h-9 px-2 text-sm tabular-nums transition-colors ${
        entry.estPrice === null
          ? "text-muted hover:text-fg"
          : entry.priceSource === "ai"
            ? "text-muted hover:text-fg"
            : "text-fg hover:text-accent"
      }`}
    >
      {entry.estPrice === null
        ? "price?"
        : `${entry.priceSource === "ai" ? "~" : ""}$${entry.estPrice.toFixed(2)}`}
    </button>
  );
}

// Per-package price in the item detail: manual edits stick (AI never
// overwrites them); "look up" force-fetches from the configured store.
function PriceField({
  item,
  onUpdate,
}: {
  item: InventoryItem;
  onUpdate: (id: string, patch: Partial<InventoryItem>) => void;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState(
    item.est_price === null ? "" : String(item.est_price),
  );
  const [prevPrice, setPrevPrice] = useState(item.est_price);
  if (item.est_price !== prevPrice) {
    setPrevPrice(item.est_price);
    setDraft(item.est_price === null ? "" : String(item.est_price));
  }
  const [buyDraft, setBuyDraft] = useState(
    item.buy_amount === null ? "" : String(item.buy_amount),
  );
  const [prevBuy, setPrevBuy] = useState(item.buy_amount);
  if (item.buy_amount !== prevBuy) {
    setPrevBuy(item.buy_amount);
    setBuyDraft(item.buy_amount === null ? "" : String(item.buy_amount));
  }
  const [looking, setLooking] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  function commitBuy() {
    const trimmed = buyDraft.trim();
    let next: number | null;
    if (trimmed === "") {
      next = null;
    } else {
      const n = Number(trimmed);
      if (!Number.isFinite(n) || n <= 0) {
        setBuyDraft(item.buy_amount === null ? "" : String(item.buy_amount));
        return;
      }
      next = Math.round(n * 1000) / 1000;
    }
    if (next === item.buy_amount) return;
    onUpdate(item.id, { buy_amount: next });
    // The plan changed, so an AI price is stale — re-fetch it. Manual prices
    // stay put (the user owns them).
    if (item.price_source !== "manual") void lookUp();
  }

  function commit() {
    const trimmed = draft.trim();
    if (trimmed === "") {
      if (item.est_price !== null) {
        onUpdate(item.id, { est_price: null, price_source: null });
      }
      return;
    }
    const n = Number(trimmed);
    if (!Number.isFinite(n) || n <= 0) {
      setDraft(item.est_price === null ? "" : String(item.est_price));
      return;
    }
    const rounded = Math.round(n * 100) / 100;
    if (rounded === item.est_price) return;
    onUpdate(item.id, { est_price: rounded, price_source: "manual" });
  }

  async function lookUp() {
    setLooking(true);
    setNote(null);
    try {
      const result = await lookupItemPrices({
        itemIds: [item.id],
        force: true,
      });
      if (result.error) {
        setNote(result.error);
        return;
      }
      const r = result.results?.[0];
      if (r?.skipped === "manual-price") {
        setNote("manual price kept — clear it to let AI update");
      } else if (r?.error) {
        setNote(r.error);
      } else if (r?.price != null) {
        setNote(r.productName ? `found: ${r.productName}` : null);
      }
      router.refresh();
    } finally {
      setLooking(false);
    }
  }

  return (
    <span className="flex flex-wrap items-center gap-2">
      <span className="flex items-center gap-1">
        <span className="text-[10px] tracking-widest uppercase text-muted">
          buy
        </span>
        <input
          type="number"
          inputMode="decimal"
          min={0}
          step="any"
          value={buyDraft}
          onChange={(e) => setBuyDraft(e.target.value)}
          onBlur={commitBuy}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              e.currentTarget.blur();
            }
            if (e.key === "Escape") {
              setBuyDraft(item.buy_amount === null ? "" : String(item.buy_amount));
              e.currentTarget.blur();
            }
          }}
          placeholder="qty"
          aria-label="planned buy amount"
          className="w-16 min-h-11 bg-glass-well rounded-field border border-line-strong focus:border-accent text-fg text-sm text-center placeholder-muted focus:outline-none transition-colors"
        />
        {item.unit && (
          <span className="text-meta text-muted">{item.unit}</span>
        )}
      </span>
      <span className="flex items-center gap-1">
        <span className="text-muted text-sm">
          {item.price_source === "ai" ? "~$" : "$"}
        </span>
        <input
          type="number"
          inputMode="decimal"
          min={0}
          step="0.01"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              e.currentTarget.blur();
            }
            if (e.key === "Escape") {
              setDraft(item.est_price === null ? "" : String(item.est_price));
              e.currentTarget.blur();
            }
          }}
          placeholder="price"
          aria-label="estimated price per package"
          className="w-24 min-h-11 bg-glass-well rounded-field border border-line-strong focus:border-accent text-fg text-sm text-center placeholder-muted focus:outline-none transition-colors"
        />
      </span>
      <button
        type="button"
        onClick={lookUp}
        disabled={looking}
        className="min-h-11 px-3 rounded-full text-[10px] tracking-widest uppercase border border-line-strong text-muted hover:border-fg hover:text-fg transition-colors disabled:opacity-50"
      >
        {looking ? "looking…" : "look up"}
      </button>
      {note && <span className="w-full text-[10px] text-muted">{note}</span>}
    </span>
  );
}
