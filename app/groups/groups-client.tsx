"use client";

import Link from "next/link";
import { useOptimistic, useRef, useState, useTransition } from "react";
import { archiveGroup, createGroup } from "@/app/actions/groups";
import type { Group } from "./page";

const TYPES: Group["type"][] = ["course", "project", "work", "personal"];

const PALETTE = [
  "#B5FF3C",
  "#FF6B9D",
  "#3CD9FF",
  "#FFB73C",
  "#C892FF",
  "#FF6B6B",
];

export function GroupsClient({ initial }: { initial: Group[] }) {
  const [groups, removeOptimistic] = useOptimistic(
    initial,
    (state, archivedId: string) => state.filter((g) => g.id !== archivedId),
  );

  const [formOpen, setFormOpen] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const formRef = useRef<HTMLFormElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const [pickedType, setPickedType] = useState<Group["type"]>("project");
  const [pickedColor, setPickedColor] = useState<string>(PALETTE[0]);

  function openForm() {
    setFormOpen(true);
    setFormError(null);
    setTimeout(() => nameRef.current?.focus(), 50);
  }

  function closeForm() {
    setFormOpen(false);
    setFormError(null);
    formRef.current?.reset();
    setPickedType("project");
    setPickedColor(PALETTE[0]);
  }

  async function onSubmit(formData: FormData) {
    formData.set("type", pickedType);
    formData.set("color", pickedColor);

    const result = await createGroup(formData);
    if (result.error) {
      setFormError(result.error);
      return;
    }
    closeForm();
  }

  function onArchive(id: string) {
    startTransition(async () => {
      removeOptimistic(id);
      await archiveGroup(id);
    });
  }

  return (
    <div className="space-y-6">
      {/* Inbox card (virtual group) */}
      <Link
        href="/inbox"
        className="block border border-[#1f1f1f] bg-[#141414] hover:bg-[#1a1a1a] transition-colors"
      >
        <div className="flex items-center gap-3 px-4 py-4">
          <span
            className="w-2 h-10 flex-shrink-0 border-2 border-dashed border-[#3a3a3a]"
            aria-hidden
          />
          <div className="flex-1 min-w-0">
            <p className="text-[#f5f0e8] text-base font-bold">inbox</p>
            <p className="text-[#6b6b6b] text-xs tracking-widest uppercase mt-0.5">
              unsorted
            </p>
          </div>
          <span className="text-[#6b6b6b] text-xs">›</span>
        </div>
      </Link>

      {/* New group button / inline form */}
      {!formOpen ? (
        <button
          onClick={openForm}
          className="w-full text-left bg-transparent border border-dashed border-[#2a2a2a] hover:border-[#b5ff3c] hover:text-[#b5ff3c] text-[#6b6b6b] text-sm font-bold py-5 px-4 transition-colors"
        >
          + new group
        </button>
      ) : (
        <form
          ref={formRef}
          action={onSubmit}
          className="border border-[#1f1f1f] bg-[#141414] p-4 space-y-5"
        >
          <input
            ref={nameRef}
            name="name"
            type="text"
            placeholder="group name"
            required
            maxLength={64}
            autoComplete="off"
            className="w-full bg-transparent text-[#f5f0e8] placeholder-[#6b6b6b] text-base font-bold focus:outline-none border-b border-[#2a2a2a] focus:border-[#b5ff3c] pb-2 transition-colors"
          />

          <div>
            <p className="text-[10px] tracking-widest uppercase text-[#6b6b6b] mb-2">
              type
            </p>
            <div className="flex flex-wrap gap-2">
              {TYPES.map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setPickedType(t)}
                  className={`text-xs px-3 py-2 border transition-colors ${
                    pickedType === t
                      ? "bg-[#f5f0e8] text-[#0d0d0d] border-[#f5f0e8]"
                      : "border-[#2a2a2a] text-[#6b6b6b] hover:border-[#f5f0e8] hover:text-[#f5f0e8]"
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>

          <div>
            <p className="text-[10px] tracking-widest uppercase text-[#6b6b6b] mb-2">
              color
            </p>
            <div className="flex flex-wrap gap-3">
              {PALETTE.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setPickedColor(c)}
                  aria-label={`pick color ${c}`}
                  className={`w-10 h-10 transition-transform ${
                    pickedColor === c
                      ? "ring-2 ring-[#f5f0e8] ring-offset-2 ring-offset-[#141414] scale-110"
                      : ""
                  }`}
                  style={{ backgroundColor: c }}
                />
              ))}
            </div>
          </div>

          {formError && (
            <p className="text-[#ff6b6b] text-xs">{formError}</p>
          )}

          <div className="flex gap-2 pt-2">
            <button
              type="submit"
              disabled={isPending}
              className="flex-1 bg-[#b5ff3c] text-[#0d0d0d] text-sm font-bold py-3 hover:bg-[#f5f0e8] transition-colors disabled:opacity-50"
            >
              create
            </button>
            <button
              type="button"
              onClick={closeForm}
              className="px-4 text-[#6b6b6b] text-sm hover:text-[#f5f0e8] transition-colors"
            >
              cancel
            </button>
          </div>
        </form>
      )}

      {/* List */}
      <ul className="space-y-2">
        {groups.map((g) => (
          <GroupRow key={g.id} group={g} onArchive={onArchive} />
        ))}
      </ul>
    </div>
  );
}

function GroupRow({
  group,
  onArchive,
}: {
  group: Group;
  onArchive: (id: string) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <li className="border border-[#1f1f1f] bg-[#141414]">
      <div className="flex items-stretch">
        <Link
          href={`/groups/${group.id}`}
          className="flex-1 flex items-center gap-3 px-4 py-4 hover:bg-[#1a1a1a] transition-colors min-w-0"
        >
          <span
            className="w-2 h-10 flex-shrink-0"
            style={{ backgroundColor: group.color }}
            aria-hidden
          />
          <div className="flex-1 min-w-0">
            <p className="text-[#f5f0e8] text-base font-bold truncate">
              {group.name}
            </p>
            <p className="text-[#6b6b6b] text-xs tracking-widest uppercase mt-0.5">
              {group.type}
            </p>
          </div>
          <span className="text-[#6b6b6b] text-xs">›</span>
        </Link>

        <button
          onClick={() => setMenuOpen((v) => !v)}
          aria-label="group actions"
          className="px-4 border-l border-[#1f1f1f] text-[#6b6b6b] hover:text-[#f5f0e8] hover:bg-[#1a1a1a] transition-colors text-lg"
        >
          ···
        </button>
      </div>

      {menuOpen && (
        <div className="border-t border-[#1f1f1f] px-4 py-3 flex justify-end">
          <button
            onClick={() => {
              setMenuOpen(false);
              onArchive(group.id);
            }}
            className="text-[#ff6b6b] text-xs tracking-widest uppercase hover:text-[#ff8b8b] transition-colors py-2 px-3"
          >
            archive
          </button>
        </div>
      )}
    </li>
  );
}
