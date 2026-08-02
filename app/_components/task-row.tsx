"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { pushTaskToCalendar, setTaskAiState } from "@/app/actions/tasks";
import { formatDue } from "./date-utils";
import type { Task, TaskWithGroup } from "./types";

// Overnight-agent badge copy per lifecycle state (docs/overnight-agent-plan.md).
// Copy is track-agnostic: code tasks (mindboard group) build on branches,
// life tasks get research/drafts — the lifecycle is the same either way.
const AI_BADGE: Record<NonNullable<Task["ai_state"]>, { label: string; tone: string }> = {
  planned: { label: "✦ plan ready", tone: "text-accent" },
  approved: { label: "✦ queued", tone: "text-muted" },
  building: { label: "✦ working…", tone: "text-muted" },
  built: { label: "✦ done", tone: "text-accent" },
  failed: { label: "✦ failed", tone: "text-danger" },
};

export type GroupOption = {
  id: string;
  name: string;
  color: string;
};

// Duplicated from stream.ts's formatEstimate — task-row imports no server-ish
// snapshot code, so a local copy keeps its bundle lean.
function formatEstimate(minutes: number): string {
  if (minutes < 60) return `~${minutes}m`;
  const hours = Math.round((minutes / 60) * 10) / 10;
  const label = Number.isInteger(hours) ? String(hours) : hours.toFixed(1);
  return `~${label}h`;
}

const ESTIMATE_CHIPS = [15, 30, 60, 120, 240] as const;

type UpdatePatch = {
  title?: string;
  dueDate?: string | null;
  dueTime?: string | null;
  durationMin?: number | null;
  estimatedMinutes?: number | null;
  groupId?: string | null;
  notes?: string | null;
  priority?: "low" | "med" | "high";
};

export function TaskRow({
  task,
  today,
  groups,
  onToggle,
  onDelete,
  onUpdate,
  onMiss,
  variant = "default",
  hideDate = false,
  open: openProp,
  onOpenChange,
  hideNotesInPanel = false,
}: {
  task: Task | TaskWithGroup;
  // The user's day. Drives the due-date chip's active state AND the value the
  // chip WRITES through updateTask into tasks.due_date, so it must be the day
  // the server classifies against — never the device clock.
  today: string;
  groups: GroupOption[];
  onToggle: (t: Task) => void;
  onDelete: (id: string) => void;
  onUpdate: (id: string, patch: UpdatePatch) => void;
  onMiss?: (id: string) => void;
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
  const hasEstimate = !isDone && task.estimated_minutes != null;
  const aiBadge = task.ai_state ? AI_BADGE[task.ai_state] : null;
  const showSubtitle =
    hasGroupInfo || showDate || hasNotes || hasEstimate || Boolean(aiBadge);

  return (
    <div
      className="border-b border-l-2 border-line pl-3"
      style={{
        borderLeftColor: isOverdue
          ? "var(--danger)"
          : (groupColor ?? "transparent"),
      }}
    >
      <div className="flex items-center gap-3 py-3">
        <button
          onClick={() => onToggle(task)}
          aria-label={isDone ? "mark as todo" : "mark as done"}
          className={`press flex-shrink-0 w-7 h-7 border-2 rounded-full transition-all flex items-center justify-center ${
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
                  due {formatDue(task.due_date!, today)}
                </span>
              )}
              {(hasGroupInfo || showDate) && hasNotes && (
                <span className="text-line-subtle">·</span>
              )}
              {hasNotes && <span className="text-muted">notes</span>}
              {(hasGroupInfo || showDate || hasNotes) && hasEstimate && (
                <span className="text-line-subtle">·</span>
              )}
              {hasEstimate && (
                <span className="text-muted">
                  {formatEstimate(task.estimated_minutes!)}
                </span>
              )}
              {(hasGroupInfo || showDate || hasNotes || hasEstimate) &&
                aiBadge && <span className="text-line-subtle">·</span>}
              {aiBadge && <span className={aiBadge.tone}>{aiBadge.label}</span>}
            </p>
          )}
        </button>
      </div>

      {open && (
        <EditPanel
          task={task}
          today={today}
          groups={groups}
          onDelete={onDelete}
          onUpdate={onUpdate}
          onMiss={isOverdue ? onMiss : undefined}
          hideNotes={hideNotesInPanel}
        />
      )}
    </div>
  );
}

function EditPanel({
  task,
  today,
  groups,
  onDelete,
  onUpdate,
  onMiss,
  hideNotes = false,
}: {
  task: Task | TaskWithGroup;
  today: string;
  groups: GroupOption[];
  onDelete: (id: string) => void;
  onUpdate: (id: string, patch: UpdatePatch) => void;
  onMiss?: (id: string) => void;
  hideNotes?: boolean;
}) {
  const [titleDraft, setTitleDraft] = useState(task.title);
  const [notesDraft, setNotesDraft] = useState(task.notes ?? "");
  const [pushState, setPushState] = useState<string | null>(null);
  const [pushing, startPush] = useTransition();
  const [aiState, setAiState] = useState(task.ai_state);
  const [aiPending, startAi] = useTransition();
  const dateInputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // The capture dock is a fixed island pinned to the bottom of the viewport.
  // A panel that opens for a task low in the list expands directly behind it,
  // so its notes field and delete button (the panel's last element) are
  // occluded and the whole edit reads as unresponsive. On open, lift the panel
  // by exactly the amount its bottom overlaps the dock, so the delete button
  // clears the dock's top edge; panels already above the dock are left in place.
  useEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const dock = document.querySelector<HTMLElement>("[data-capture-dock]");
    const floor = dock
      ? dock.getBoundingClientRect().top
      : window.innerHeight - 280;
    const overshoot = el.getBoundingClientRect().bottom - (floor - 12);
    if (overshoot > 0) {
      window.scrollBy({ top: overshoot, behavior: "smooth" });
    }
  }, []);

  function changeAiState(next: "approved" | "planned" | null) {
    startAi(async () => {
      const result = await setTaskAiState(task.id, next);
      if (!result.error) setAiState(next);
    });
  }

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
    <div ref={panelRef} className="glass-rise pb-3 space-y-3">
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
        className="w-full min-h-11 bg-glass-well rounded-field border border-line-strong focus:border-accent text-fg text-sm px-3 py-2 focus:outline-none transition-colors"
      />

      <div className="flex items-center flex-wrap gap-2">
        <button
          type="button"
          onClick={() => onUpdate(task.id, { dueDate: isToday ? null : today })}
          className={`inline-flex items-center min-h-11 text-[10px] tracking-widest uppercase px-2.5 border rounded-full transition-colors ${
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
          className={`inline-flex items-center min-h-11 text-[10px] tracking-widest uppercase px-2.5 border rounded-full transition-colors ${
            isCustomDate
              ? "bg-accent text-accent-fg border-accent"
              : "border-line-strong text-muted hover:border-fg hover:text-fg"
          }`}
        >
          {isCustomDate ? `✓ ${formatDue(task.due_date!, today)}` : "+ date"}
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
            className="min-h-11 bg-glass-well rounded-field border border-line-strong focus:border-accent text-fg text-xs px-2 py-1.5 focus:outline-none transition-colors"
          />
          {task.due_time && (
            <>
              <select
                value={task.duration_min ?? 30}
                onChange={(e) =>
                  onUpdate(task.id, { durationMin: Number(e.target.value) })
                }
                aria-label="duration"
                className="min-h-11 bg-glass-well rounded-field border border-line-strong focus:border-accent text-fg text-xs px-2 py-1.5 focus:outline-none transition-colors"
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
                  className="inline-flex items-center min-h-11 text-[10px] tracking-widest uppercase px-2.5 border rounded-full border-line-strong text-muted hover:border-fg hover:text-fg transition-colors disabled:opacity-50"
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
            className={`inline-flex items-center min-h-11 text-[10px] tracking-widest uppercase px-2.5 border rounded-full transition-colors ${
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

      <div className="flex items-center flex-wrap gap-2">
        <label className="text-[10px] tracking-widest uppercase text-muted">
          estimate
        </label>
        {ESTIMATE_CHIPS.map((m) => {
          const active = task.estimated_minutes === m;
          return (
            <button
              key={m}
              type="button"
              onClick={() =>
                onUpdate(task.id, { estimatedMinutes: active ? null : m })
              }
              className={`inline-flex items-center min-h-11 text-[10px] tracking-widest uppercase px-2.5 border rounded-full transition-colors ${
                active
                  ? "bg-accent text-accent-fg border-accent"
                  : "border-line-strong text-muted hover:border-fg hover:text-fg"
              }`}
            >
              {m < 60 ? `${m}m` : `${m / 60}h`}
            </button>
          );
        })}
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
          className="flex-1 min-w-0 min-h-11 bg-glass-well rounded-field border border-line-strong focus:border-accent text-fg text-xs uppercase tracking-widest px-2 py-1.5 focus:outline-none transition-colors"
        >
          <option value="">inbox</option>
          {groups.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        </select>
      </div>

      {aiState && (
        <div className="flex items-center flex-wrap gap-2">
          <label className="text-[10px] tracking-widest uppercase text-muted">
            ai build
          </label>
          <span
            className={`text-[10px] tracking-widest uppercase ${AI_BADGE[aiState].tone}`}
          >
            {AI_BADGE[aiState].label}
          </span>
          {aiState === "planned" && (
            <>
              <button
                type="button"
                disabled={aiPending}
                onClick={() => changeAiState("approved")}
                className="text-[10px] tracking-widest uppercase px-2.5 py-1.5 border rounded-full bg-accent text-accent-fg border-accent transition-colors disabled:opacity-50"
              >
                approve
              </button>
              <button
                type="button"
                disabled={aiPending}
                onClick={() => changeAiState(null)}
                className="text-[10px] tracking-widest uppercase px-2.5 py-1.5 border rounded-full border-line-strong text-muted hover:border-fg hover:text-fg transition-colors disabled:opacity-50"
              >
                dismiss
              </button>
            </>
          )}
          {aiState === "approved" && (
            <button
              type="button"
              disabled={aiPending}
              onClick={() => changeAiState("planned")}
              className="text-[10px] tracking-widest uppercase px-2.5 py-1.5 border rounded-full border-line-strong text-muted hover:border-fg hover:text-fg transition-colors disabled:opacity-50"
            >
              un-approve
            </button>
          )}
          {aiState === "failed" && (
            <button
              type="button"
              disabled={aiPending}
              onClick={() => changeAiState("approved")}
              className="text-[10px] tracking-widest uppercase px-2.5 py-1.5 border rounded-full border-line-strong text-muted hover:border-fg hover:text-fg transition-colors disabled:opacity-50"
            >
              retry tonight
            </button>
          )}
          {(aiState === "built" || aiState === "failed" || aiState === "building") && (
            <button
              type="button"
              disabled={aiPending}
              onClick={() => changeAiState(null)}
              className="text-[10px] tracking-widest uppercase px-2.5 py-1.5 border rounded-full border-line-strong text-muted hover:border-fg hover:text-fg transition-colors disabled:opacity-50"
            >
              clear
            </button>
          )}
        </div>
      )}

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
            className="w-full resize-y bg-glass-well rounded-field border border-line-strong focus:border-accent text-fg placeholder-muted text-sm leading-relaxed px-3 py-2 focus:outline-none transition-colors"
          />
        </div>
      )}

      <div className="flex justify-end gap-4">
        {onMiss && (
          <button
            onClick={() => onMiss(task.id)}
            className="inline-flex items-center min-h-11 text-danger opacity-70 hover:opacity-100 text-xs tracking-widest uppercase transition-opacity px-3"
          >
            incomplete
          </button>
        )}
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
