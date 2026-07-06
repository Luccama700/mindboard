"use client";

import { useState } from "react";
import type { SpendingCategory } from "@/app/_components/finance-types";

export const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function toCents(value: number): number {
  return Math.round(value * 100) / 100;
}

export type CategoryAction =
  | { kind: "add"; category: SpendingCategory }
  | { kind: "replace"; tempId: string; category: SpendingCategory }
  | { kind: "update"; id: string; patch: Partial<SpendingCategory> }
  | { kind: "remove"; id: string };

export function categoriesReducer(
  state: SpendingCategory[],
  action: CategoryAction,
): SpendingCategory[] {
  switch (action.kind) {
    case "add":
      return [action.category, ...state];
    case "replace":
      return state.map((c) =>
        c.id === action.tempId ? action.category : c,
      );
    case "update":
      return state.map((c) =>
        c.id === action.id ? { ...c, ...action.patch } : c,
      );
    case "remove":
      return state.filter((c) => c.id !== action.id);
  }
}

export function CollapsibleSection({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section className="border-t border-line pt-6">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between text-left"
      >
        <span className="text-[10px] tracking-widest uppercase text-muted">
          {title} · {count}
        </span>
        <span className="text-muted text-xs">{open ? "−" : "+"}</span>
      </button>
      {open && <div className="mt-4 space-y-3">{children}</div>}
    </section>
  );
}
