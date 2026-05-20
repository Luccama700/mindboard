"use client";

import { useRef, useState } from "react";
import { formatDue, todayISO } from "./date-utils";
import type { Task, TaskWithGroup } from "./types";

export type GroupOption = {
  id: string;
  name: string;
  color: string;
};

type UpdatePatch = {
  title?: string;
  dueDate?: string | null;
  groupId?: string | null;
};

export function TaskRow({
  task,
  groups,
  onToggle,
  onDelete,
  onUpdate,
  variant = "default",
  hideDate = false,
}: {
  task: Task | TaskWithGroup;
  groups: GroupOption[];
  onToggle: (t: Task) => void;
  onDelete: (id: string) => void;
  onUpdate: (id: string, patch: UpdatePatch) => void;
  variant?: "default" | "overdue";
  hideDate?: boolean;
}) {
  const [open, setOpen] = useState(false);

  const isDone = task.status === "done";
  const isOverdue = variant === "overdue";

  const hasGroupInfo = "group_name" in task;
  const groupName = hasGroupInfo ? task.group_name : null;
  const groupColor = hasGroupInfo ? task.group_color : null;

  const showDate = task.due_date && !isDone && !hideDate;
  const showSubtitle = hasGroupInfo || showDate;

  return (
    <div className="border-b border-[#1f1f1f]">
      <div className="flex items-center gap-3 py-3">
        <button
          onClick={() => onToggle(task)}
          aria-label={isDone ? "mark as todo" : "mark as done"}
          className={`flex-shrink-0 w-7 h-7 border-2 transition-all flex items-center justify-center ${
            isDone
              ? "bg-[#b5ff3c] border-[#b5ff3c]"
              : isOverdue
                ? "border-[#ff6b6b] hover:border-[#ff8b8b]"
                : "border-[#3a3a3a] hover:border-[#f5f0e8]"
          }`}
        >
          {isDone && (
            <svg
              viewBox="0 0 16 16"
              width="14"
              height="14"
              fill="none"
              stroke="#0d0d0d"
              strokeWidth="3"
            >
              <path d="M3 8l3.5 3.5L13 5" />
            </svg>
          )}
        </button>

        <button
          onClick={() => setOpen((v) => !v)}
          className="flex-1 min-w-0 text-left py-1"
        >
          <p
            className={`text-base truncate transition-colors ${
              isDone
                ? "text-[#6b6b6b] line-through"
                : isOverdue
                  ? "text-[#f5f0e8] font-bold"
                  : "text-[#f5f0e8]"
            }`}
          >
            {task.title}
          </p>
          {showSubtitle && !isDone && (
            <p className="text-[10px] tracking-widest uppercase mt-0.5 flex items-center gap-1.5">
              {hasGroupInfo && (
                <span
                  style={{ color: groupColor ?? "#6b6b6b" }}
                  className={!groupName ? "italic" : ""}
                >
                  {groupName ?? "inbox"}
                </span>
              )}
              {hasGroupInfo && showDate && (
                <span className="text-[#3a3a3a]">·</span>
              )}
              {showDate && (
                <span className={isOverdue ? "text-[#ff6b6b]" : "text-[#6b6b6b]"}>
                  due {formatDue(task.due_date!)}
                </span>
              )}
            </p>
          )}
        </button>
      </div>

      {open && (
        <EditPanel
          task={task}
          groups={groups}
          onDelete={onDelete}
          onUpdate={onUpdate}
        />
      )}
    </div>
  );
}

function EditPanel({
  task,
  groups,
  onDelete,
  onUpdate,
}: {
  task: Task | TaskWithGroup;
  groups: GroupOption[];
  onDelete: (id: string) => void;
  onUpdate: (id: string, patch: UpdatePatch) => void;
}) {
  const [titleDraft, setTitleDraft] = useState(task.title);
  const dateInputRef = useRef<HTMLInputElement>(null);

  const today = todayISO();
  const isToday = task.due_date === today;
  const isCustomDate = task.due_date !== null && !isToday;

  function openDatePicker() {
    const el = dateInputRef.current;
    if (!el) return;
    if (typeof el.showPicker === "function") {
      try {
        el.showPicker();
        return;
      } catch {
        // fall through
      }
    }
    el.focus();
    el.click();
  }

  function commitTitle() {
    const next = titleDraft.trim();
    if (!next || next === task.title) {
      setTitleDraft(task.title);
      return;
    }
    onUpdate(task.id, { title: next });
  }

  return (
    <div className="pb-3 space-y-3">
      <input
        type="text"
        value={titleDraft}
        onChange={(e) => setTitleDraft(e.target.value)}
        onBlur={commitTitle}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            e.currentTarget.blur();
          }
          if (e.key === "Escape") {
            setTitleDraft(task.title);
            e.currentTarget.blur();
          }
        }}
        maxLength={200}
        aria-label="task title"
        className="w-full bg-[#141414] border border-[#2a2a2a] focus:border-[#b5ff3c] text-[#f5f0e8] text-sm px-3 py-2 focus:outline-none transition-colors"
      />

      <div className="flex items-center flex-wrap gap-2">
        <button
          type="button"
          onClick={() => onUpdate(task.id, { dueDate: isToday ? null : today })}
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
          {isCustomDate ? `✓ ${formatDue(task.due_date!)}` : "+ date"}
        </button>

        <input
          ref={dateInputRef}
          type="date"
          value={task.due_date ?? ""}
          onChange={(e) =>
            onUpdate(task.id, { dueDate: e.target.value || null })
          }
          tabIndex={-1}
          aria-hidden
          className="sr-only"
        />

        {task.due_date && (
          <button
            type="button"
            onClick={() => onUpdate(task.id, { dueDate: null })}
            aria-label="clear date"
            className="text-[#6b6b6b] text-lg leading-none hover:text-[#f5f0e8] transition-colors px-1.5 py-1"
          >
            ×
          </button>
        )}
      </div>

      <div className="flex items-center gap-2">
        <label className="text-[10px] tracking-widest uppercase text-[#6b6b6b]">
          group
        </label>
        <select
          value={task.group_id ?? ""}
          onChange={(e) =>
            onUpdate(task.id, { groupId: e.target.value || null })
          }
          aria-label="task group"
          className="flex-1 min-w-0 bg-[#141414] border border-[#2a2a2a] focus:border-[#b5ff3c] text-[#f5f0e8] text-xs uppercase tracking-widest px-2 py-1.5 focus:outline-none transition-colors"
        >
          <option value="">inbox</option>
          {groups.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        </select>
      </div>

      <div className="flex justify-end">
        <button
          onClick={() => onDelete(task.id)}
          className="text-[#ff6b6b] text-xs tracking-widest uppercase hover:text-[#ff8b8b] transition-colors py-1.5 px-3"
        >
          delete
        </button>
      </div>
    </div>
  );
}
