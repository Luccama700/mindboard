"use client";

import { useState } from "react";
import {
  archiveCategory,
  createCategory,
  updateCategory,
} from "@/app/actions/finance";
import { CategoriesManager } from "@/app/finance/categories-section";
import type { SpendingCategory } from "./finance-types";

// Dock-sheet tab around the finance CategoriesManager: keeps an optimistic
// local list and writes through the finance server actions, so the dock's
// spend-capture chips and /finance stay the source of truth on next render.
export function CategoriesSheet({ initial }: { initial: SpendingCategory[] }) {
  const [categories, setCategories] = useState(initial);

  return (
    <CategoriesManager
      variant="sheet"
      categories={categories}
      onCreate={async (input) => {
        const result = await createCategory(input);
        if (result.error || !result.category) return null;
        const created = result.category as SpendingCategory;
        setCategories((prev) =>
          [...prev, created].sort((a, b) => a.name.localeCompare(b.name)),
        );
        return created;
      }}
      onUpdate={(id, patch) => {
        setCategories((prev) =>
          prev.map((c) => (c.id === id ? { ...c, ...patch } : c)),
        );
        void updateCategory({ id, name: patch.name, color: patch.color });
      }}
      onArchive={(id) => {
        setCategories((prev) => prev.filter((c) => c.id !== id));
        void archiveCategory(id);
      }}
    />
  );
}
