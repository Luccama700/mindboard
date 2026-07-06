"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { createTask } from "@/app/actions/tasks";
import { extractTrailingTime } from "@/app/lib/capture/parse";
import { emitTaskOptimistic, emitTaskReplace } from "./capture-bus";
import { formatDue, todayISO } from "./date-utils";
import type { GroupOption } from "./task-row";
import type { Task } from "./types";

const RAIL_TABS = [
  { href: "/", glyph: "◆", label: "now" },
  { href: "/week", glyph: "▦", label: "week" },
  { href: "/plan", glyph: "◇", label: "plan" },
  { href: "/finance", glyph: "$", label: "money" },
  { href: "/inventory", glyph: "▤", label: "stock" },
] as const;

function isActive(pathname: string, href: string) {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function Dock({
  groups,
  inboxCount,
}: {
  groups: GroupOption[];
  inboxCount: number;
}) {
  const pathname = usePathname();

  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [dueDate, setDueDate] = useState<string | null>(() => todayISO());
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [priority, setPriority] = useState<"low" | "med" | "high">("med");
  const [groupOpen, setGroupOpen] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [typing, setTyping] = useState(false);
  const [keyboardUp, setKeyboardUp] = useState(false);
  const [timeDisabledFor, setTimeDisabledFor] = useState<string | null>(null);

  const formRef = useRef<HTMLFormElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dateInputRef = useRef<HTMLInputElement>(null);

  const today = todayISO();
  const isToday = dueDate === today;
  const isCustomDate = dueDate !== null && !isToday;
  const hasNotes = Boolean(notes.trim());
  const selectedGroup =
    groups.find((group) => group.id === selectedGroupId) ?? null;
  const parsedRaw = extractTrailingTime(title);
  // Dismissing the chip only sticks for the exact phrase that was dismissed —
  // editing the time re-offers it.
  const parsedTime =
    parsedRaw && parsedRaw.matched !== timeDisabledFor ? parsedRaw : null;

  const railCollapsed = typing || keyboardUp;

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const onResize = () => {
      setKeyboardUp(window.innerHeight - vv.height > 120);
    };
    vv.addEventListener("resize", onResize);
    return () => vv.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    if (!groupOpen && !moreOpen) return;

    function onPointerDown(e: PointerEvent) {
      if (!formRef.current?.contains(e.target as Node)) {
        setGroupOpen(false);
        setMoreOpen(false);
      }
    }

    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [groupOpen, moreOpen]);

  function onFormFocus() {
    setTyping(true);
    setMoreOpen(false);
  }

  function onFormBlur(e: React.FocusEvent<HTMLFormElement>) {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setTyping(false);
    }
  }

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
    const parsed = parsedTime;
    const t = (parsed ? parsed.title : title).trim();
    const dueTime = parsed && dueDate ? parsed.time : null;
    const markdownNotes = notes.trim() || null;
    if (!t || busy) return;

    setBusy(true);
    setTitle("");
    setNotes("");
    setTimeDisabledFor(null);

    const tempId = `temp-${crypto.randomUUID()}`;
    const optimisticTask: Task = {
      id: tempId,
      title: t,
      due_date: dueDate,
      due_time: dueTime,
      duration_min: null,
      gcal_event_id: null,
      gcal_calendar_id: null,
      status: "todo",
      priority,
      notes: markdownNotes,
      group_id: selectedGroupId,
      created_at: new Date().toISOString(),
      completed_at: null,
    };

    emitTaskOptimistic(optimisticTask);
    setPriority("med");

    const result = await createTask({
      title: t,
      groupId: selectedGroupId,
      dueDate,
      dueTime,
      notes: markdownNotes,
      priority,
    });

    if (!result.error && result.task) {
      emitTaskReplace(tempId, result.task as Task);
    }

    setBusy(false);
    inputRef.current?.focus();
  }

  return (
    <form
      ref={formRef}
      onSubmit={onSubmit}
      onFocus={onFormFocus}
      onBlur={onFormBlur}
      className="fixed z-40 left-4 right-4 bottom-[max(env(safe-area-inset-bottom),1rem)] rounded-t-[8px] bg-page/95 border border-line p-3 shadow-[0_0_28px_rgba(0,0,0,0.65)] lg:left-1/2 lg:right-auto lg:w-[min(44rem,calc(100vw-4rem))] lg:-translate-x-1/2"
    >
      {moreOpen && (
        <nav className="absolute left-0 right-0 bottom-full mb-2 border border-line bg-popover p-2 shadow-[0_0_28px_rgba(0,0,0,0.65)]">
          {[
            { href: "/tasks", label: "tasks", badge: inboxCount },
            { href: "/brain", label: "brain", badge: 0 },
            { href: "/settings", label: "settings", badge: 0 },
          ].map((item) => (
            <Link
              key={item.href}
              href={item.href}
              onClick={() => setMoreOpen(false)}
              className="flex min-h-11 w-full items-center justify-between px-3 text-action lowercase text-fg hover:bg-card transition-colors"
            >
              <span>{item.label}</span>
              {item.badge > 0 && (
                <span className="text-meta text-muted">{item.badge} inbox</span>
              )}
            </Link>
          ))}
        </nav>
      )}

      <div
        className={`overflow-hidden transition-[max-height,opacity,margin] duration-200 ease-signal ${
          railCollapsed ? "max-h-0 opacity-0 mb-0" : "max-h-14 opacity-100 mb-2"
        }`}
      >
        <div className="flex items-stretch">
          {RAIL_TABS.map((tab) => {
            const active = isActive(pathname, tab.href);
            return (
              <Link
                key={tab.href}
                href={tab.href}
                aria-current={active ? "page" : undefined}
                className={`flex-1 flex min-h-11 flex-col items-center justify-center gap-0.5 border-b-2 transition-colors ${
                  active
                    ? "border-accent text-fg"
                    : "border-transparent text-muted hover:text-fg"
                }`}
              >
                <span className="text-body leading-none" aria-hidden>
                  {tab.glyph}
                </span>
                <span className="text-label uppercase">{tab.label}</span>
              </Link>
            );
          })}
          <button
            type="button"
            onClick={() => setMoreOpen((v) => !v)}
            aria-expanded={moreOpen}
            aria-label="more"
            className={`flex-1 flex min-h-11 flex-col items-center justify-center gap-0.5 border-b-2 border-transparent transition-colors ${
              moreOpen ? "text-fg" : "text-muted hover:text-fg"
            }`}
          >
            <span className="text-body leading-none" aria-hidden>
              ≡
            </span>
            <span className="text-label uppercase">more</span>
          </button>
        </div>
      </div>

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
            <span className="truncate">{selectedGroup?.name ?? "inbox"}</span>
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

          {parsedTime && dueDate && (
            <button
              type="button"
              onClick={() => setTimeDisabledFor(parsedTime.matched)}
              aria-label={`remove time ${parsedTime.time}`}
              title="tap to keep the time words as part of the title"
              className="min-h-11 text-[10px] tracking-widest uppercase px-3 py-2 border bg-accent text-accent-fg border-accent transition-colors"
            >
              ⌚ {parsedTime.time} ×
            </button>
          )}

          <button
            type="button"
            onClick={() =>
              setPriority((p) =>
                p === "med" ? "high" : p === "high" ? "low" : "med",
              )
            }
            aria-label={`priority: ${priority}`}
            className={`min-h-11 text-[10px] tracking-widest uppercase px-3 py-2 border transition-colors font-bold ${
              priority === "high"
                ? "border-danger text-danger hover:bg-danger hover:text-white"
                : "border-line-strong text-muted hover:border-fg hover:text-fg"
            }`}
          >
            {priority === "high" ? "!!!" : priority === "low" ? "!" : "!!"}
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
