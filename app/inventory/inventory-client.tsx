"use client";

import {
  useEffect,
  useMemo,
  useOptimistic,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
} from "react";
import { ColorPicker, PALETTE } from "@/app/_components/color-picker";
import { UnitPicker } from "@/app/_components/unit-picker";
import {
  activeKeyFor,
  activeModelFor,
  readImageGenSettings,
} from "@/app/_components/image-gen-settings";
import {
  createInventoryGroup,
  createInventoryItem,
  createInventoryUsage,
  deleteInventoryGroup,
  deleteInventoryItem,
  deleteInventoryUsage,
  updateInventoryGroup,
  updateInventoryItem,
  updateInventoryUsage,
} from "@/app/actions/inventory";
import { generateItemIcon } from "@/app/actions/inventory-icon";
import type {
  InventoryGroup,
  InventoryItem,
  InventoryUsage,
} from "@/app/_components/inventory-types";
import { InventoryCalendar } from "@/app/_components/inventory-calendar";
import type { UsagePeriod } from "@/app/_components/inventory-projection";
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

export function InventoryClient({
  userId,
  initialGroups,
  initialItems,
  initialUsages,
}: {
  userId: string;
  initialGroups: InventoryGroup[];
  initialItems: InventoryItem[];
  initialUsages: InventoryUsage[];
}) {
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
  const asideRef = useRef<HTMLDivElement>(null);
  const view = useViewMode();
  const countMode = useCountMode();

  const groupColors = useMemo(() => {
    const map = new Map<string, string>();
    for (const g of groups) map.set(g.id, g.color);
    return map;
  }, [groups]);

  const recentUnits = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const it of items) {
      const u = it.unit.trim();
      if (u && !seen.has(u.toLowerCase())) {
        seen.add(u.toLowerCase());
        out.push(u);
      }
    }
    return out;
  }, [items]);

  const sections = useMemo(() => {
    const byGroup = new Map<string | null, InventoryItem[]>();
    for (const it of items) {
      const key = it.inventory_group_id;
      const bucket = byGroup.get(key);
      if (bucket) bucket.push(it);
      else byGroup.set(key, [it]);
    }
    const grouped = groups.map((g) => ({
      group: g,
      items: byGroup.get(g.id) ?? [],
    }));
    const ungrouped = byGroup.get(null) ?? [];
    return { grouped, ungrouped };
  }, [groups, items]);

  const selectedItem = items.find((it) => it.id === selectedId) ?? null;

  function scrollDetailIntoView() {
    if (typeof window === "undefined") return;
    if (window.innerWidth >= 1024) return;
    requestAnimationFrame(() =>
      asideRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }),
    );
  }

  function onSelect(id: string) {
    setAdding(false);
    setSelectedId(id);
    scrollDetailIntoView();
  }

  function startAdd() {
    setAdding(true);
    setSelectedId(null);
    scrollDetailIntoView();
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
      created_at: new Date().toISOString(),
    };
    setAdding(false);
    setSelectedId(tempId);
    startTransition(async () => {
      dispatchItems({ kind: "add", item: optimistic });
      const result = await createInventoryItem({
        groupId: input.groupId,
        name: input.name,
        quantity: input.quantity,
        unit: input.unit,
      });
      if (!result.error && result.item) {
        const real = result.item as InventoryItem;
        dispatchItems({ kind: "replace", tempId, item: real });
        setSelectedId(real.id);
      }
    });
  }

  function onAdjustQuantity(id: string, delta: number) {
    const current = items.find((it) => it.id === id);
    if (!current) return;
    const next = Math.max(
      0,
      Math.round((Number(current.quantity) + delta) * 1000) / 1000,
    );
    if (next === Number(current.quantity)) return;
    onUpdateItem(id, { quantity: next });
  }

  function onUpdateItem(id: string, patch: Partial<InventoryItem>) {
    startTransition(async () => {
      dispatchItems({ kind: "update", id, patch });
      await updateInventoryItem({
        id,
        name: patch.name,
        quantity: patch.quantity,
        unit: patch.unit,
        notes: patch.notes,
        groupId: patch.inventory_group_id,
        imageUrl: patch.image_url,
        reorderThreshold: patch.reorder_threshold,
      });
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
      const result = await createInventoryUsage({
        itemId,
        amount: input.amount,
        period: input.period,
        intervalDays: input.intervalDays,
      });
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
      await updateInventoryUsage({
        id,
        amount: input.amount,
        period: input.period,
        intervalDays: input.intervalDays,
      });
    });
  }

  function onDeleteUsage(id: string) {
    startTransition(async () => {
      dispatchUsages({ kind: "remove", id });
      await deleteInventoryUsage(id);
    });
  }

  function onDeleteItem(id: string) {
    startTransition(async () => {
      if (selectedId === id) setSelectedId(null);
      dispatchItems({ kind: "remove", id });
      await deleteInventoryItem(id);
    });
  }

  function onUpdateGroup(id: string, patch: Partial<InventoryGroup>) {
    startTransition(async () => {
      dispatchGroups({ kind: "update", id, patch });
      await updateInventoryGroup({
        id,
        name: patch.name,
        color: patch.color,
      });
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
      await deleteInventoryGroup(id);
    });
  }

  function onCreateGroup(input: { name: string; color: string }) {
    return createInventoryGroup(input);
  }

  const isEmpty = groups.length === 0 && items.length === 0;
  const flatItems = [
    ...sections.grouped.flatMap((s) => s.items),
    ...sections.ungrouped,
  ];

  return (
    <div className="grid gap-8 lg:grid-cols-2 lg:gap-24 lg:items-start">
      <section className="min-w-0 space-y-6">
        <div className="flex gap-2">
          <button
            onClick={startAdd}
            className="flex-1 bg-accent text-accent-fg text-sm font-bold py-3 hover:opacity-90 transition-colors"
          >
            + add item
          </button>
          <button
            onClick={() => setGroupFormOpen((v) => !v)}
            aria-expanded={groupFormOpen}
            className="px-4 border border-dashed border-line-strong text-muted text-sm hover:border-accent hover:text-accent transition-colors"
          >
            + group
          </button>
        </div>

        {groupFormOpen && (
          <GroupForm
            onCreate={onCreateGroup}
            onClose={() => setGroupFormOpen(false)}
          />
        )}

        {!isEmpty && (
          <div className="flex justify-end gap-2">
            {view === "list" && (
              <div className="flex gap-px border border-line bg-line">
                {(["items", "totals"] as CountMode[]).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setCountMode(m)}
                    aria-pressed={countMode === m}
                    className={`min-h-9 px-3 text-[10px] tracking-widest uppercase transition-colors ${
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
            <div className="flex gap-px border border-line bg-line">
              {(["list", "grid"] as ViewMode[]).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setViewMode(m)}
                  aria-pressed={view === m}
                  className={`min-h-9 px-3 text-[10px] tracking-widest uppercase transition-colors ${
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

        {isEmpty ? (
          <p className="border border-dashed border-line-strong text-muted text-sm px-4 py-10 text-center">
            no items yet. add your first one.
          </p>
        ) : view === "grid" ? (
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-8">
            {flatItems.map((it) => (
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
                onAdjust={onAdjustQuantity}
              />
            ))}
          </div>
        ) : (
          <div className="space-y-5">
            {sections.grouped.map(({ group, items: groupItems }) => (
              <GroupSection
                key={group.id}
                group={group}
                items={groupItems}
                countMode={countMode}
                selectedId={selectedId}
                onSelect={onSelect}
                onUpdateGroup={onUpdateGroup}
                onDeleteGroup={onDeleteGroup}
                onAdjust={onAdjustQuantity}
              />
            ))}

            {sections.ungrouped.length > 0 && (
              <div>
                <div className="flex items-center gap-3 border border-line bg-card px-3 py-2">
                  <span
                    className="w-2 h-8 border-2 border-dashed border-line-subtle"
                    aria-hidden
                  />
                  <span className="flex-1 truncate text-fg text-sm font-bold">
                    ungrouped
                  </span>
                  <span
                    className={`text-muted text-[10px] tabular-nums ${
                      countMode === "items" ? "tracking-widest uppercase" : ""
                    }`}
                  >
                    {countMode === "items"
                      ? sections.ungrouped.length
                      : summarizeByUnit(sections.ungrouped)}
                  </span>
                </div>
                <ul>
                  {sections.ungrouped.map((it) => (
                    <ItemRow
                      key={it.id}
                      item={it}
                      selected={it.id === selectedId}
                      onSelect={onSelect}
                      onAdjust={onAdjustQuantity}
                    />
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </section>

      <aside ref={asideRef} className="min-w-0 lg:sticky lg:top-8">
        {adding ? (
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
            onDelete={onDeleteItem}
            onCreateUsage={onCreateUsage}
            onUpdateUsage={onUpdateUsage}
            onDeleteUsage={onDeleteUsage}
          />
        ) : (
          <p className="border border-line text-muted text-sm px-4 py-16 text-center">
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
      className="border border-line bg-card p-4 space-y-5"
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
          className="flex-1 bg-accent text-accent-fg text-sm font-bold py-3 hover:opacity-90 transition-colors disabled:opacity-50"
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

function GroupSection({
  group,
  items,
  countMode,
  selectedId,
  onSelect,
  onUpdateGroup,
  onDeleteGroup,
  onAdjust,
}: {
  group: InventoryGroup;
  items: InventoryItem[];
  countMode: CountMode;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onUpdateGroup: (id: string, patch: Partial<InventoryGroup>) => void;
  onDeleteGroup: (id: string) => void;
  onAdjust: (id: string, delta: number) => void;
}) {
  const [editOpen, setEditOpen] = useState(false);

  return (
    <div>
      <div className="flex items-stretch border border-line bg-card">
        <div className="flex-1 flex items-center gap-3 px-3 py-2 min-w-0">
          <span
            className="w-2 h-8 flex-shrink-0"
            style={{ backgroundColor: group.color }}
            aria-hidden
          />
          <span className="flex-1 truncate text-fg text-sm font-bold">
            {group.name}
          </span>
          <span
            className={`text-muted text-[10px] tabular-nums ${
              countMode === "items" ? "tracking-widest uppercase" : ""
            }`}
          >
            {countMode === "items" ? items.length : summarizeByUnit(items)}
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
          onUpdate={onUpdateGroup}
          onDelete={(id) => {
            setEditOpen(false);
            onDeleteGroup(id);
          }}
        />
      )}

      {items.length > 0 ? (
        <ul>
          {items.map((it) => (
            <ItemRow
              key={it.id}
              item={it}
              selected={it.id === selectedId}
              onSelect={onSelect}
              onAdjust={onAdjust}
            />
          ))}
        </ul>
      ) : (
        <p className="text-muted text-xs px-3 py-3 border-x border-b border-line">
          empty
        </p>
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
    <div className="border-x border-b border-line p-4 space-y-5">
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

function ItemRow({
  item,
  selected,
  onSelect,
  onAdjust,
}: {
  item: InventoryItem;
  selected: boolean;
  onSelect: (id: string) => void;
  onAdjust: (id: string, delta: number) => void;
}) {
  return (
    <li
      className={`flex items-stretch border-x border-b border-line transition-colors ${
        selected ? "bg-card-hover" : ""
      }`}
    >
      <button
        onClick={() => onSelect(item.id)}
        className="flex-1 min-w-0 text-left flex items-center gap-3 px-3 min-h-11 py-2 hover:bg-card-hover transition-colors"
      >
        {item.image_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={item.image_url}
            alt=""
            className="w-8 h-8 flex-shrink-0 object-cover border border-line bg-page"
          />
        ) : (
          <span
            className="w-8 h-8 flex-shrink-0 border border-dashed border-line-subtle"
            aria-hidden
          />
        )}
        <span className="flex-1 min-w-0 truncate text-fg text-sm">
          {item.name}
        </span>
      </button>
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
  return (
    <div
      className={`relative flex aspect-square flex-col overflow-hidden border bg-card transition-colors ${
        selected ? "border-accent ring-1 ring-accent" : "border-line hover:border-fg"
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
              className="absolute inset-0 h-full w-full object-cover"
            />
          ) : (
            <span className="absolute inset-0 flex items-center justify-center text-2xl font-bold text-muted">
              {item.name.slice(0, 1).toUpperCase()}
            </span>
          )}
          <span className="absolute bottom-1 right-1 border border-line bg-page/85 px-1 py-0.5 text-[10px] leading-none text-fg tabular-nums">
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
          className="flex-1 min-h-9 flex items-center justify-center border-r border-line text-base leading-none hover:bg-card-hover transition-colors"
        >
          −
        </button>
        <button
          type="button"
          onClick={() => onAdjust(item.id, 1)}
          aria-label={`increase ${item.name}`}
          className="flex-1 min-h-9 flex items-center justify-center text-base leading-none hover:bg-card-hover transition-colors"
        >
          +
        </button>
      </div>
    </div>
  );
}

function QuantityField({
  value,
  onCommit,
}: {
  value: number;
  onCommit: (n: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  const [prevValue, setPrevValue] = useState(value);
  if (value !== prevValue) {
    setPrevValue(value);
    setDraft(String(value));
  }

  function commit(raw: string) {
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) {
      setDraft(String(value));
      return;
    }
    const rounded = Math.round(n * 1000) / 1000;
    if (rounded !== value) onCommit(rounded);
    setDraft(String(rounded));
  }

  function step(delta: number) {
    const base = Number.isFinite(Number(draft)) ? Number(draft) : value;
    const next = Math.max(0, Math.round((base + delta) * 1000) / 1000);
    onCommit(next);
  }

  return (
    <div className="flex items-stretch">
      <button
        type="button"
        onClick={() => step(-1)}
        aria-label="decrease quantity"
        className="min-h-11 w-11 border border-line-strong text-fg text-lg leading-none hover:border-fg hover:bg-card-hover transition-colors"
      >
        −
      </button>
      <input
        type="number"
        inputMode="decimal"
        step="any"
        min={0}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            e.currentTarget.blur();
          }
        }}
        aria-label="quantity"
        className="min-h-11 w-24 text-center bg-card border-y border-line-strong focus:border-accent text-fg text-base focus:outline-none transition-colors"
      />
      <button
        type="button"
        onClick={() => step(1)}
        aria-label="increase quantity"
        className="min-h-11 w-11 border border-line-strong text-fg text-lg leading-none hover:border-fg hover:bg-card-hover transition-colors"
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
      className="w-full bg-card border border-line-strong focus:border-accent text-fg text-xs uppercase tracking-widest px-2 py-2 focus:outline-none transition-colors"
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
      className="border border-line bg-card p-4 space-y-5"
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
          className="flex-1 bg-accent text-accent-fg text-sm font-bold py-3 hover:opacity-90 transition-colors"
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
    const apiKey = activeKeyFor(settings);
    if (!apiKey) {
      setIconError(`add your ${settings.provider} api key in settings`);
      return;
    }
    const p = genPrompt.trim() || item.name;
    setBusy(true);
    setIconError(null);
    try {
      const result = await generateItemIcon({
        id: item.id,
        prompt: p,
        provider: settings.provider,
        apiKey,
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
    <div className="border border-line bg-card p-4 space-y-5">
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

      <div className="space-y-2">
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
              value={genPrompt}
              onChange={(e) => setGenPrompt(e.target.value)}
              placeholder="describe the icon…"
              maxLength={300}
              aria-label="icon prompt"
              className="w-full bg-card border border-line-strong focus:border-accent text-fg placeholder-muted text-sm px-3 py-2 focus:outline-none transition-colors"
            />
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={onGenerate}
                disabled={busy}
                className="text-[10px] tracking-widest uppercase px-3 py-2 border border-fg text-fg hover:bg-fg hover:text-page transition-colors disabled:opacity-50"
              >
                {busy ? "working…" : "generate"}
              </button>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={busy}
                className="text-[10px] tracking-widest uppercase px-3 py-2 border border-line-strong text-muted hover:border-fg hover:text-fg transition-colors disabled:opacity-50"
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
        />
      </div>

      <UnitPicker
        value={item.unit}
        onChange={(u) => onUpdate(item.id, { unit: u })}
        recent={recentUnits}
      />

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
          className="w-full resize-y bg-card border border-line-strong focus:border-accent text-fg placeholder-muted text-sm leading-relaxed px-3 py-2 focus:outline-none transition-colors"
        />
      </div>

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

      <div className="flex justify-end">
        <button
          onClick={() => onDelete(item.id)}
          className="text-danger text-xs tracking-widest uppercase hover:text-danger-hover transition-colors py-1.5 px-3"
        >
          delete
        </button>
      </div>
    </div>
  );
}
