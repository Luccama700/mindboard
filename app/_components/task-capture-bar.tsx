"use client";

import { useEffect, useRef, useState } from "react";
import { createTask } from "@/app/actions/tasks";
import { formatDue, todayISO } from "./date-utils";
import type { Task } from "./types";

export function TaskCaptureBar({
  groupId,
  defaultDueDate = null,
  onOptimisticAdd,
  onReplace,
}: {
  groupId: string | null;
  defaultDueDate?: string | null;
  onOptimisticAdd: (task: Task) => void;
  onReplace: (tempId: string, task: Task) => void;
}) {
  const [title, setTitle] = useState("");
  const [dueDate, setDueDate] = useState<string | null>(defaultDueDate);
  const [busy, setBusy] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const dateInputRef = useRef<HTMLInputElement>(null);

  const today = todayISO();
  const isToday = dueDate === today;
  const isCustomDate = dueDate !== null && !isToday;

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

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
    if (!t || busy) return;

    setBusy(true);
    setTitle("");

    const tempId = `temp-${crypto.randomUUID()}`;
    const optimisticTask: Task = {
      id: tempId,
      title: t,
      due_date: dueDate,
      status: "todo",
      priority: "med",
      group_id: groupId,
      created_at: new Date().toISOString(),
      completed_at: null,
    };

    onOptimisticAdd(optimisticTask);

    const result = await createTask({
      title: t,
      groupId,
      dueDate,
    });

    if (!result.error && result.task) {
      onReplace(tempId, result.task as Task);
    }

    setBusy(false);
    inputRef.current?.focus();
  }

  return (
    <form
      onSubmit={onSubmit}
      className="fixed bottom-0 inset-x-0 bg-[#0d0d0d] border-t border-[#1f1f1f] px-4 pt-3 pb-[max(env(safe-area-inset-bottom),0.75rem)]"
    >
      <div className="max-w-2xl mx-auto">
        <div className="flex items-center gap-2 mb-2">
          <button
            type="button"
            onClick={() => setDueDate(isToday ? null : today)}
            className={`text-[10px] tracking-widest uppercase px-2.5 py-1.5 border transition-colors ${
              isToday
                ? "bg-[#b5ff3c] text-[#0d0d0d] border-[#b5ff3c]"
                : "border-[#2a2a2a] text-[#6b6b6b] hover:border-[#f5f0e8] hover:text-[#f5f0e8]"
            }`}
          >
            {isToday ? "✓ today" : "today"}
          </button>

          <button
            type="button"
            onClick={openDatePicker}
            className={`text-[10px] tracking-widest uppercase px-2.5 py-1.5 border transition-colors ${
              isCustomDate
                ? "bg-[#b5ff3c] text-[#0d0d0d] border-[#b5ff3c]"
                : "border-[#2a2a2a] text-[#6b6b6b] hover:border-[#f5f0e8] hover:text-[#f5f0e8]"
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
              className="text-[#6b6b6b] text-lg leading-none hover:text-[#f5f0e8] transition-colors px-1.5 py-1"
            >
              ×
            </button>
          )}
        </div>
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
            className="flex-1 bg-[#141414] border border-[#2a2a2a] focus:border-[#b5ff3c] text-[#f5f0e8] placeholder-[#6b6b6b] text-base px-3 py-3 focus:outline-none transition-colors"
          />
          <button
            type="submit"
            disabled={!title.trim() || busy}
            className="bg-[#b5ff3c] text-[#0d0d0d] text-sm font-bold px-4 py-3 hover:bg-[#f5f0e8] transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          >
            add
          </button>
        </div>
      </div>
    </form>
  );
}
