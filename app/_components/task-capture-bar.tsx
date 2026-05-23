"use client";

import { useEffect, useRef, useState } from "react";
import { createTask } from "@/app/actions/tasks";
import { formatDue, todayISO } from "./date-utils";
import type { GroupOption } from "./task-row";
import type { Task } from "./types";

export function TaskCaptureBar({
  groupId,
  groups,
  defaultDueDate = null,
  onOptimisticAdd,
  onReplace,
}: {
  groupId: string | null;
  groups: GroupOption[];
  defaultDueDate?: string | null;
  onOptimisticAdd: (task: Task) => void;
  onReplace: (tempId: string, task: Task) => void;
}) {
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [dueDate, setDueDate] = useState<string | null>(defaultDueDate);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(
    groupId,
  );
  const [groupOpen, setGroupOpen] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const formRef = useRef<HTMLFormElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dateInputRef = useRef<HTMLInputElement>(null);

  const today = todayISO();
  const isToday = dueDate === today;
  const isCustomDate = dueDate !== null && !isToday;
  const hasNotes = Boolean(notes.trim());
  const selectedGroup =
    groups.find((group) => group.id === selectedGroupId) ?? null;

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!groupOpen) return;

    function onPointerDown(e: PointerEvent) {
      if (!formRef.current?.contains(e.target as Node)) {
        setGroupOpen(false);
      }
    }

    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [groupOpen]);

  function openDatePicker() {
    const el = dateInputRef.current;
    if (!el) return;
    if (typeof el.showPicker === "function") {
      try {
        el.showPicker();
        return;
      } catch {
        // Fallback below.
      }
    }
    el.focus();
    el.click();
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const t = title.trim();
    const markdownNotes = notes.trim() || null;
    if (!t || busy) return;

    setBusy(true);
    setTitle("");
    setNotes("");

    const tempId = `temp-${crypto.randomUUID()}`;
    const optimisticTask: Task = {
      id: tempId,
      title: t,
      due_date: dueDate,
      status: "todo",
      priority: "med",
      notes: markdownNotes,
      group_id: selectedGroupId,
      created_at: new Date().toISOString(),
      completed_at: null,
    };

    onOptimisticAdd(optimisticTask);

    const result = await createTask({
      title: t,
      groupId: selectedGroupId,
      dueDate,
      notes: markdownNotes,
    });

    if (!result.error && result.task) {
      onReplace(tempId, result.task as Task);
    }

    setBusy(false);
    inputRef.current?.focus();
  }

  return (
    <form
      ref={formRef}
      onSubmit={onSubmit}
      className="fixed z-40 left-4 right-4 bottom-[max(env(safe-area-inset-bottom),1rem)] bg-page/95 border border-line p-3 shadow-[0_0_28px_rgba(0,0,0,0.65)] lg:right-auto lg:w-[calc(50vw-3rem)] lg:max-w-2xl xl:left-[calc((100vw-80rem)/2+2rem)]"
    >
      <div>
        {groupOpen && (
          <div className="absolute left-0 right-0 bottom-full mb-2 border border-line bg-popover p-2 shadow-[0_0_28px_rgba(0,0,0,0.65)]">
            <div className="max-h-56 overflow-y-auto">
              <button
                type="button"
                onClick={() => {
                  setSelectedGroupId(null);
                  setGroupOpen(false);
                  inputRef.current?.focus();
                }}
                className={`flex min-h-11 w-full items-center gap-2 px-3 text-left text-xs tracking-widest uppercase transition-colors ${
                  selectedGroupId === null
                    ? "bg-accent text-accent-fg"
                    : "text-fg hover:bg-card"
                }`}
              >
                <span
                  className="h-3 w-3 flex-shrink-0 border border-muted border-dashed"
                  aria-hidden
                />
                inbox
              </button>
              {groups.map((group) => (
                <button
                  key={group.id}
                  type="button"
                  onClick={() => {
                    setSelectedGroupId(group.id);
                    setGroupOpen(false);
                    inputRef.current?.focus();
                  }}
                  className={`flex min-h-11 w-full items-center gap-2 px-3 text-left text-xs tracking-widest uppercase transition-colors ${
                    selectedGroupId === group.id
                      ? "bg-accent text-accent-fg"
                      : "text-fg hover:bg-card"
                  }`}
                >
                  <span
                    className="h-3 w-3 flex-shrink-0"
                    style={{ backgroundColor: group.color }}
                    aria-hidden
                  />
                  <span className="truncate">{group.name}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="flex items-center flex-wrap gap-2 mb-2">
          <button
            type="button"
            onClick={() => setGroupOpen((v) => !v)}
            aria-expanded={groupOpen}
            className={`flex min-h-11 max-w-full items-center gap-2 border px-3 py-2 text-[10px] tracking-widest uppercase transition-colors ${
              selectedGroup
                ? "border-line-strong text-fg hover:border-fg"
                : "border-line-strong text-muted hover:border-fg hover:text-fg"
            }`}
          >
            <span
              className={`h-2.5 w-2.5 flex-shrink-0 ${
                selectedGroup ? "" : "border border-muted border-dashed"
              }`}
              style={{
                backgroundColor: selectedGroup?.color ?? "transparent",
              }}
              aria-hidden
            />
            <span className="truncate">
              {selectedGroup?.name ?? "inbox"}
            </span>
          </button>

          <button
            type="button"
            onClick={() => setDueDate(isToday ? null : today)}
            className={`min-h-11 text-[10px] tracking-widest uppercase px-3 py-2 border transition-colors ${
              isToday
                ? "bg-accent text-accent-fg border-accent"
                : "border-line-strong text-muted hover:border-fg hover:text-fg"
            }`}
          >
            {isToday ? "✓ today" : "today"}
          </button>

          <button
            type="button"
            onClick={openDatePicker}
            className={`min-h-11 text-[10px] tracking-widest uppercase px-3 py-2 border transition-colors ${
              isCustomDate
                ? "bg-accent text-accent-fg border-accent"
                : "border-line-strong text-muted hover:border-fg hover:text-fg"
            }`}
          >
            {isCustomDate ? `✓ ${formatDue(dueDate!)}` : "+ date"}
          </button>

          <input
            ref={dateInputRef}
            type="date"
            value={dueDate ?? ""}
            onChange={(e) => setDueDate(e.target.value || null)}
            tabIndex={-1}
            aria-hidden
            className="sr-only"
          />

          {isCustomDate && (
            <button
              type="button"
              onClick={() => setDueDate(null)}
              aria-label="clear date"
              className="text-muted text-lg leading-none hover:text-fg transition-colors px-1.5 py-1"
            >
              ×
            </button>
          )}

          <button
            type="button"
            onClick={() => setNotesOpen((v) => !v)}
            aria-expanded={notesOpen}
            className={`min-h-11 text-[10px] tracking-widest uppercase px-3 py-2 border transition-colors ${
              notesOpen || hasNotes
                ? "bg-accent text-accent-fg border-accent"
                : "border-line-strong text-muted hover:border-fg hover:text-fg"
            }`}
          >
            {hasNotes ? "✓ notes" : "+ notes"}
          </button>
        </div>

        {notesOpen && (
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="markdown notes..."
            aria-label="task notes markdown"
            maxLength={5000}
            rows={4}
            className="mb-2 w-full resize-y bg-card border border-line-strong focus:border-accent text-fg placeholder-muted text-sm leading-relaxed px-3 py-2 focus:outline-none transition-colors"
          />
        )}

        <div className="flex items-center gap-2">
          <input
            ref={inputRef}
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="new task…"
            autoComplete="off"
            autoCapitalize="sentences"
            enterKeyHint="done"
            maxLength={200}
            className="flex-1 bg-card border border-line-strong focus:border-accent text-fg placeholder-muted text-base px-3 py-3 focus:outline-none transition-colors"
          />
          <button
            type="submit"
            disabled={!title.trim() || busy}
            className="bg-accent text-accent-fg text-sm font-bold px-4 py-3 hover:opacity-90 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          >
            add
          </button>
        </div>
      </div>
    </form>
  );
}
