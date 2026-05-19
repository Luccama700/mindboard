"use client";

import { useState } from "react";
import { formatDue } from "./date-utils";
import type { Task, TaskWithGroup } from "./types";

export function TaskRow({
  task,
  onToggle,
  onDelete,
  variant = "default",
  hideDate = false,
}: {
  task: Task | TaskWithGroup;
  onToggle: (t: Task) => void;
  onDelete: (id: string) => void;
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
        <div className="pb-3 flex justify-end">
          <button
            onClick={() => onDelete(task.id)}
            className="text-[#ff6b6b] text-xs tracking-widest uppercase hover:text-[#ff8b8b] transition-colors py-1.5 px-3"
          >
            delete
          </button>
        </div>
      )}
    </div>
  );
}
