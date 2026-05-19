"use client";

import {
  startTransition,
  useEffect,
  useOptimistic,
  useRef,
  useState,
} from "react";
import {
  createTask,
  deleteTask,
  toggleTaskStatus,
} from "@/app/actions/tasks";

export type Task = {
  id: string;
  title: string;
  due_date: string | null;
  status: "todo" | "doing" | "done";
  priority: "low" | "med" | "high";
  group_id: string | null;
  created_at: string;
  completed_at: string | null;
};

function todayISO() {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

type OptimisticAction =
  | { kind: "add"; task: Task }
  | { kind: "replace"; tempId: string; task: Task }
  | { kind: "toggle"; id: string; nextStatus: "todo" | "done" }
  | { kind: "delete"; id: string };

export function TasksClient({
  initial,
  groupId,
}: {
  initial: Task[];
  groupId: string | null;
}) {
  const [tasks, dispatch] = useOptimistic<Task[], OptimisticAction>(
    initial,
    (state, action) => {
      switch (action.kind) {
        case "add":
          return [action.task, ...state];
        case "replace":
          return state.map((t) =>
            t.id === action.tempId ? action.task : t,
          );
        case "toggle":
          return state.map((t) =>
            t.id === action.id
              ? {
                  ...t,
                  status: action.nextStatus,
                  completed_at:
                    action.nextStatus === "done"
                      ? new Date().toISOString()
                      : null,
                }
              : t,
          );
        case "delete":
          return state.filter((t) => t.id !== action.id);
      }
    },
  );

  const [dueDate, setDueDate] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const today = todayISO();
  const isToday = dueDate === today;
  const isCustomDate = dueDate !== null && !isToday;
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  // Keep input usable: re-focus after submit
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

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

    startTransition(async () => {
      dispatch({ kind: "add", task: optimisticTask });
      const result = await createTask({
        title: t,
        groupId,
        dueDate,
      });
      if (!result.error && result.task) {
        dispatch({ kind: "replace", tempId, task: result.task as Task });
      }
    });

    setBusy(false);
    inputRef.current?.focus();
  }

  function onToggle(task: Task) {
    const nextStatus = task.status === "done" ? "todo" : "done";
    startTransition(async () => {
      dispatch({ kind: "toggle", id: task.id, nextStatus });
      await toggleTaskStatus(task.id, task.status);
    });
  }

  function onDelete(id: string) {
    startTransition(async () => {
      dispatch({ kind: "delete", id });
      await deleteTask(id);
    });
  }

  const active = tasks.filter((t) => t.status !== "done");
  const done = tasks.filter((t) => t.status === "done");

  return (
    <>
      <div className="space-y-1 pb-4">
        {active.length === 0 && done.length === 0 && (
          <p className="text-[#6b6b6b] text-sm text-center pt-12 pb-8">
            no tasks yet — start typing below.
          </p>
        )}

        {active.map((t) => (
          <TaskRow
            key={t.id}
            task={t}
            onToggle={onToggle}
            onDelete={onDelete}
          />
        ))}

        {done.length > 0 && (
          <div className="pt-8">
            <p className="text-[10px] tracking-widest uppercase text-[#6b6b6b] mb-2 px-1">
              done · {done.length}
            </p>
            {done.map((t) => (
              <TaskRow
                key={t.id}
                task={t}
                onToggle={onToggle}
                onDelete={onDelete}
              />
            ))}
          </div>
        )}
      </div>

      {/* Sticky capture bar */}
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

            <label className="relative inline-flex">
              <span
                className={`text-[10px] tracking-widest uppercase px-2.5 py-1.5 border cursor-pointer transition-colors ${
                  isCustomDate
                    ? "bg-[#b5ff3c] text-[#0d0d0d] border-[#b5ff3c]"
                    : "border-[#2a2a2a] text-[#6b6b6b] hover:border-[#f5f0e8] hover:text-[#f5f0e8]"
                }`}
              >
                {isCustomDate ? `✓ ${formatDue(dueDate!)}` : "+ date"}
              </span>
              <input
                type="date"
                value={dueDate ?? ""}
                onChange={(e) => setDueDate(e.target.value || null)}
                className="absolute inset-0 opacity-0 cursor-pointer"
                aria-label="due date"
              />
            </label>

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
    </>
  );
}

function TaskRow({
  task,
  onToggle,
  onDelete,
}: {
  task: Task;
  onToggle: (t: Task) => void;
  onDelete: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const isDone = task.status === "done";

  return (
    <div className="border-b border-[#1f1f1f]">
      <div className="flex items-center gap-3 py-3">
        <button
          onClick={() => onToggle(task)}
          aria-label={isDone ? "mark as todo" : "mark as done"}
          className={`flex-shrink-0 w-7 h-7 border-2 transition-all flex items-center justify-center ${
            isDone
              ? "bg-[#b5ff3c] border-[#b5ff3c]"
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
                : "text-[#f5f0e8]"
            }`}
          >
            {task.title}
          </p>
          {task.due_date && !isDone && (
            <p className="text-[10px] tracking-widest uppercase text-[#6b6b6b] mt-0.5">
              due {formatDue(task.due_date)}
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

function formatDue(iso: string) {
  const today = todayISO();
  if (iso === today) return "today";
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}
