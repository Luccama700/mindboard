"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { pushTaskToCalendar } from "@/app/actions/tasks";
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
  dueTime?: string | null;
  durationMin?: number | null;
  groupId?: string | null;
  notes?: string | null;
  priority?: "low" | "med" | "high";
};

export function TaskRow({
  task,
  groups,
  onToggle,
  onDelete,
  onUpdate,
  variant = "default",
  hideDate = false,
  open: openProp,
  onOpenChange,
  hideNotesInPanel = false,
}: {
  task: Task | TaskWithGroup;
  groups: GroupOption[];
  onToggle: (t: Task) => void;
  onDelete: (id: string) => void;
  onUpdate: (id: string, patch: UpdatePatch) => void;
  variant?: "default" | "overdue";
  hideDate?: boolean;
  open?: boolean;
  onOpenChange?: (next: boolean) => void;
  hideNotesInPanel?: boolean;
}) {
  const [openLocal, setOpenLocal] = useState(false);
  const isControlled = openProp !== undefined;
  const open = isControlled ? openProp : openLocal;

  function toggleOpen() {
    const next = !open;
    if (isControlled) {
      onOpenChange?.(next);
    } else {
      setOpenLocal(next);
    }
  }

  const isDone = task.status === "done";
  const isOverdue = variant === "overdue";

  const hasGroupInfo = "group_name" in task;
  const groupName = hasGroupInfo ? task.group_name : null;
  const groupColor = hasGroupInfo ? task.group_color : null;

  const showDate = task.due_date && !isDone && !hideDate;
  const hasNotes = Boolean(task.notes?.trim());
  const showSubtitle = hasGroupInfo || showDate || hasNotes;

  return (
    <div className="border-b border-line">
      <div className="flex items-center gap-3 py-3">
        <button
          onClick={() => onToggle(task)}
          aria-label={isDone ? "mark as todo" : "mark as done"}
          className={`flex-shrink-0 w-7 h-7 border-2 transition-all flex items-center justify-center ${
            isDone
              ? "bg-accent border-accent"
              : isOverdue
                ? "border-danger hover:border-danger-hover"
                : "border-line-subtle hover:border-fg"
          }`}
        >
          {isDone && (
            <svg
              viewBox="0 0 16 16"
              width="14"
              height="14"
              fill="none"
              stroke="var(--accent-fg)"
              strokeWidth="3"
            >
              <path d="M3 8l3.5 3.5L13 5" />
            </svg>
          )}
        </button>

        <button
          onClick={toggleOpen}
          className="flex-1 min-w-0 text-left py-1"
        >
          <p
            className={`text-base truncate transition-colors ${
              isDone
                ? "text-muted line-through"
                : isOverdue
                  ? "text-fg font-bold"
                  : "text-fg"
            }`}
          >
            {!isDone && task.priority !== "med" && (
              <span
                className={`mr-1.5 text-sm font-bold ${
                  task.priority === "high" ? "text-danger" : "text-muted"
                }`}
              >
                {task.priority === "high" ? "!!!" : "!"}
              </span>
            )}
            {task.title}
          </p>
          {showSubtitle && !isDone && (
            <p className="text-[10px] tracking-widest uppercase mt-0.5 flex items-center gap-1.5">
              {hasGroupInfo && (
                <span
                  style={{ color: groupColor ?? "var(--muted)" }}
                  className={!groupName ? "italic" : ""}
                >
                  {groupName ?? "inbox"}
                </span>
              )}
              {hasGroupInfo && showDate && (
                <span className="text-line-subtle">·</span>
              )}
              {showDate && (
                <span className={isOverdue ? "text-danger" : "text-muted"}>
                  due {formatDue(task.due_date!)}
                </span>
              )}
              {(hasGroupInfo || showDate) && hasNotes && (
                <span className="text-line-subtle">·</span>
              )}
              {hasNotes && <span className="text-muted">notes</span>}
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
          hideNotes={hideNotesInPanel}
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
  hideNotes = false,
}: {
  task: Task | TaskWithGroup;
  groups: GroupOption[];
  onDelete: (id: string) => void;
  onUpdate: (id: string, patch: UpdatePatch) => void;
  hideNotes?: boolean;
}) {
  const [titleDraft, setTitleDraft] = useState(task.title);
  const [notesDraft, setNotesDraft] = useState(task.notes ?? "");
  const [pushState, setPushState] = useState<string | null>(null);
  const [pushing, startPush] = useTransition();
  const dateInputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // The capture dock is a fixed island (~230px) pinned to the bottom of the
  // viewport. A panel that opens for a task low in the list expands directly
  // behind it, so its notes field and delete button are occluded and the whole
  // edit reads as unresponsive. Lift the panel into view on open when it lands
  // inside the dock's band; panels already clear of the dock are left in place.
  useEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const DOCK_CLEARANCE = 260;
    if (el.getBoundingClientRect().bottom > window.innerHeight - DOCK_CLEARANCE) {
      el.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, []);

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

  function commitNotes() {
    const next = notesDraft.trim();
    const current = task.notes ?? "";
    if (next === current) return;
    onUpdate(task.id, { notes: next || null });
  }

  return (
    <div ref={panelRef} className="pb-3 space-y-3">
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
        className="w-full min-h-11 bg-card border border-line-strong focus:border-accent text-fg text-sm px-3 py-2 focus:outline-none transition-colors"
      />

      <div className="flex items-center flex-wrap gap-2">
        <button
          type="button"
          onClick={() => onUpdate(task.id, { dueDate: isToday ? null : today })}
          className={`inline-flex items-center min-h-11 text-[10px] tracking-widest uppercase px-2.5 border transition-colors ${
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
          className={`inline-flex items-center min-h-11 text-[10px] tracking-widest uppercase px-2.5 border transition-colors ${
            isCustomDate
              ? "bg-accent text-accent-fg border-accent"
              : "border-line-strong text-muted hover:border-fg hover:text-fg"
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
            className="inline-flex items-center justify-center min-h-11 min-w-11 text-muted text-lg leading-none hover:text-fg transition-colors"
          >
            ×
          </button>
        )}
      </div>

      {task.due_date && (
        <div className="flex items-center flex-wrap gap-2">
          <label className="text-[10px] tracking-widest uppercase text-muted">
            time
          </label>
          <input
            type="time"
            step={900}
            value={task.due_time ? task.due_time.slice(0, 5) : ""}
            onChange={(e) =>
              onUpdate(task.id, { dueTime: e.target.value || null })
            }
            aria-label="due time"
            className="min-h-11 bg-card border border-line-strong focus:border-accent text-fg text-xs px-2 py-1.5 focus:outline-none transition-colors"
          />
          {task.due_time && (
            <>
              <select
                value={task.duration_min ?? 30}
                onChange={(e) =>
                  onUpdate(task.id, { durationMin: Number(e.target.value) })
                }
                aria-label="duration"
                className="min-h-11 bg-card border border-line-strong focus:border-accent text-fg text-xs px-2 py-1.5 focus:outline-none transition-colors"
              >
                {[15, 30, 45, 60, 90, 120, 180, 240].map((m) => (
                  <option key={m} value={m}>
                    {m < 60 ? `${m}m` : `${m / 60}h`}
                  </option>
                ))}
              </select>
              {task.gcal_event_id ? (
                <span className="text-[10px] tracking-widest uppercase text-muted">
                  ⇅ on calendar
                </span>
              ) : (
                <button
                  type="button"
                  disabled={pushing}
                  onClick={() =>
                    startPush(async () => {
                      setPushState(null);
                      const result = await pushTaskToCalendar(task.id);
                      setPushState(
                        result.error ? result.error : "pushed ⇅",
                      );
                    })
                  }
                  className="inline-flex items-center min-h-11 text-[10px] tracking-widest uppercase px-2.5 border border-line-strong text-muted hover:border-fg hover:text-fg transition-colors disabled:opacity-50"
                >
                  {pushing ? "pushing…" : "→ calendar event"}
                </button>
              )}
              {pushState && (
                <span className="text-[10px] text-muted">{pushState}</span>
              )}
            </>
          )}
        </div>
      )}

      <div className="flex items-center gap-2">
        <label className="text-[10px] tracking-widest uppercase text-muted">
          priority
        </label>
        {(["low", "med", "high"] as const).map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => onUpdate(task.id, { priority: p })}
            className={`inline-flex items-center min-h-11 text-[10px] tracking-widest uppercase px-2.5 border transition-colors ${
              task.priority === p
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

      <div className="flex items-center gap-2">
        <label className="text-[10px] tracking-widest uppercase text-muted">
          group
        </label>
        <select
          value={task.group_id ?? ""}
          onChange={(e) =>
            onUpdate(task.id, { groupId: e.target.value || null })
          }
          aria-label="task group"
          className="flex-1 min-w-0 min-h-11 bg-card border border-line-strong focus:border-accent text-fg text-xs uppercase tracking-widest px-2 py-1.5 focus:outline-none transition-colors"
        >
          <option value="">inbox</option>
          {groups.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        </select>
      </div>

      {!hideNotes && (
        <div className="space-y-1.5">
          <label
            htmlFor={`task-notes-${task.id}`}
            className="text-[10px] tracking-widest uppercase text-muted"
          >
            markdown notes
          </label>
          <textarea
            id={`task-notes-${task.id}`}
            value={notesDraft}
            onChange={(e) => setNotesDraft(e.target.value)}
            onBlur={commitNotes}
            placeholder="add details..."
            maxLength={5000}
            rows={4}
            className="w-full resize-y bg-card border border-line-strong focus:border-accent text-fg placeholder-muted text-sm leading-relaxed px-3 py-2 focus:outline-none transition-colors"
          />
        </div>
      )}

      <div className="flex justify-end">
        <button
          onClick={() => onDelete(task.id)}
          className="inline-flex items-center min-h-11 text-danger text-xs tracking-widest uppercase hover:text-danger-hover transition-colors px-3"
        >
          delete
        </button>
      </div>
    </div>
  );
}
