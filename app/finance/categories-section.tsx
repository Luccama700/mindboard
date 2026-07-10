"use client";

import { useState, useTransition } from "react";
import { ColorPicker, PALETTE } from "@/app/_components/color-picker";
import type { SpendingCategory } from "@/app/_components/finance-types";
import { CollapsibleSection } from "./finance-shared";

export function CategoriesManager({
  categories,
  onCreate,
  onUpdate,
  onArchive,
  variant = "page",
}: {
  categories: SpendingCategory[];
  onCreate: (input: {
    name: string;
    color: string;
  }) => Promise<SpendingCategory | null>;
  onUpdate: (id: string, patch: Partial<SpendingCategory>) => void;
  onArchive: (id: string) => void;
  // "sheet" drops the collapsible page chrome so the manager can embed in
  // the dock's groups sheet as a tab.
  variant?: "page" | "sheet";
}) {
  const [formOpen, setFormOpen] = useState(false);
  const [name, setName] = useState("");
  const [color, setColor] = useState<string>(PALETTE[0]);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function createCat(e: React.FormEvent) {
    e.preventDefault();
    const n = name.trim();
    if (!n) {
      setError("name required");
      return;
    }
    startTransition(async () => {
      const created = await onCreate({ name: n, color });
      if (!created) {
        setError("could not create category");
        return;
      }
      setName("");
      setColor(PALETTE[0]);
      setFormOpen(false);
      setError(null);
    });
  }

  const body = (
    <>
      <ul className="space-y-2">
        {categories.map((c) => (
          <CategoryRow
            key={c.id}
            category={c}
            onUpdate={onUpdate}
            onArchive={onArchive}
          />
        ))}
      </ul>

      {!formOpen ? (
        <button
          onClick={() => setFormOpen(true)}
          className="w-full text-left bg-transparent border border-dashed border-line-strong hover:border-accent hover:text-accent text-muted text-sm font-bold py-4 px-4 transition-colors"
        >
          + new category
        </button>
      ) : (
        <form
          onSubmit={createCat}
          className="border border-line bg-card p-4 space-y-5"
        >
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            type="text"
            placeholder="category name"
            maxLength={64}
            autoComplete="off"
            autoFocus
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
              onClick={() => setFormOpen(false)}
              className="px-4 text-muted text-sm hover:text-fg transition-colors"
            >
              cancel
            </button>
          </div>
        </form>
      )}
    </>
  );

  if (variant === "sheet") {
    return <div className="space-y-3">{body}</div>;
  }

  return (
    <CollapsibleSection title="spending categories" count={categories.length}>
      {body}
    </CollapsibleSection>
  );
}

function CategoryRow({
  category,
  onUpdate,
  onArchive,
}: {
  category: SpendingCategory;
  onUpdate: (id: string, patch: Partial<SpendingCategory>) => void;
  onArchive: (id: string) => void;
}) {
  const [editOpen, setEditOpen] = useState(false);
  const [nameDraft, setNameDraft] = useState(category.name);

  function commitName() {
    const next = nameDraft.trim();
    if (!next || next === category.name) {
      setNameDraft(category.name);
      return;
    }
    onUpdate(category.id, { name: next });
  }

  return (
    <li className="border border-line bg-card">
      <div className="flex items-stretch">
        <div className="flex flex-1 items-center gap-3 px-4 py-3 min-w-0">
          <span
            className="w-2 h-6 flex-shrink-0"
            style={{ backgroundColor: category.color }}
            aria-hidden
          />
          <span className="flex-1 truncate text-fg text-sm font-bold">
            {category.name}
          </span>
        </div>
        <button
          onClick={() => setEditOpen((v) => !v)}
          aria-label="category actions"
          className="px-4 border-l border-line text-muted hover:text-fg hover:bg-card-hover transition-colors text-lg"
        >
          ···
        </button>
      </div>

      {editOpen && (
        <div className="border-t border-line p-4 space-y-5">
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
                setNameDraft(category.name);
                e.currentTarget.blur();
              }
            }}
            maxLength={64}
            aria-label="category name"
            className="w-full bg-transparent text-fg text-base font-bold focus:outline-none border-b border-line-strong focus:border-accent pb-2 transition-colors"
          />
          <ColorPicker
            value={category.color}
            onChange={(c) => onUpdate(category.id, { color: c })}
          />
          <div className="flex justify-end pt-2">
            <button
              onClick={() => {
                setEditOpen(false);
                onArchive(category.id);
              }}
              className="text-danger text-xs tracking-widest uppercase hover:text-danger-hover transition-colors py-2 px-3"
            >
              archive
            </button>
          </div>
        </div>
      )}
    </li>
  );
}
