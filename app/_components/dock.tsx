"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { recordBalanceChange } from "@/app/actions/finance";
import { loadCalendarOptions } from "@/app/actions/groups";
import { createRecurringTask } from "@/app/actions/recurring-tasks";
import { createTask } from "@/app/actions/tasks";
import { GroupsClient } from "@/app/tasks/groups-client";
import type { Group } from "@/app/tasks/groups-types";
import type { CalendarListEntry } from "@/utils/google/calendar";
import {
  extractTrailingRecurrence,
  extractTrailingTime,
  parseCapture,
} from "@/app/lib/capture/parse";
import { formatRecurrence, type TaskRecurrence } from "@/app/lib/recurrence";
import { formatMoney } from "./money";
import { ProposalCard } from "./proposal-card";
import { emitTaskOptimistic, emitTaskReplace } from "./capture-bus";
import { formatDue, todayISO } from "./date-utils";
import type { Task } from "./types";

const RAIL_TABS: {
  href: string;
  glyph: string;
  label: string;
  mobileOnly?: boolean;
}[] = [
  { href: "/", glyph: "◆", label: "now" },
  // Desktop's dashboard already shows the week calendar in its right pane, so
  // the rail tab is redundant there — mobile keeps it (no dual view), and the
  // "more" menu carries week for desktop.
  { href: "/week", glyph: "▦", label: "week", mobileOnly: true },
  { href: "/plan", glyph: "◇", label: "plan" },
  { href: "/finance", glyph: "$", label: "money" },
  { href: "/inventory", glyph: "▤", label: "stock" },
];

function isActive(pathname: string, href: string) {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export type DockAccount = {
  id: string;
  name: string;
  balance: number;
  currency: string;
};

export type DockCategory = { id: string; name: string; color: string };

type SpendDraft = {
  amount: number;
  description: string;
  accountId: string;
  categoryId: string | null;
};

export function Dock({
  groups,
  inboxCount,
  accounts,
  categories,
}: {
  groups: Group[];
  inboxCount: number;
  accounts: DockAccount[];
  categories: DockCategory[];
}) {
  const pathname = usePathname();
  const router = useRouter();

  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [dueDate, setDueDate] = useState<string | null>(() => todayISO());
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [priority, setPriority] = useState<"low" | "med" | "high">("med");
  const [groupOpen, setGroupOpen] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [groupsOpen, setGroupsOpen] = useState(false);
  const [calendarOptions, setCalendarOptions] = useState<
    CalendarListEntry[] | null
  >(null);
  const [busy, setBusy] = useState(false);
  const [typing, setTyping] = useState(false);
  const [keyboardUp, setKeyboardUp] = useState(false);
  const [timeDisabledFor, setTimeDisabledFor] = useState<string | null>(null);
  const [recurrenceDisabledFor, setRecurrenceDisabledFor] = useState<
    string | null
  >(null);
  const [manualRule, setManualRule] = useState<TaskRecurrence | null>(null);
  const [repeatOpen, setRepeatOpen] = useState(false);
  const [draftDays, setDraftDays] = useState<number[]>([]);
  const [draftInterval, setDraftInterval] = useState(2);
  const [spendDraft, setSpendDraft] = useState<SpendDraft | null>(null);
  const [spendError, setSpendError] = useState<string | null>(null);
  const [spendBusy, setSpendBusy] = useState(false);

  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dateInputRef = useRef<HTMLInputElement>(null);

  const today = todayISO();
  const isToday = dueDate === today;
  const isCustomDate = dueDate !== null && !isToday;
  const hasNotes = Boolean(notes.trim());
  const selectedGroup =
    groups.find((group) => group.id === selectedGroupId) ?? null;
  const capture = parseCapture(title, categories);

  // Trailing recurrence runs on the time-stripped title ("gym mon/wed/fri
  // 17:00"); when the recurrence trails instead ("lunch 12:30 daily"), a
  // second time pass runs on what the recurrence left behind.
  const recExtract =
    capture.mode === "task" ? extractTrailingRecurrence(capture.title) : null;
  const recurrenceActive =
    recExtract !== null && recExtract.matched !== recurrenceDisabledFor;
  const innerTime =
    recurrenceActive && capture.mode === "task" && capture.time === null
      ? extractTrailingTime(recExtract.title)
      : null;
  const taskTime =
    capture.mode === "task"
      ? (capture.time ?? (innerTime ? innerTime.time : null))
      : null;
  const parsedTime =
    capture.mode === "task" && taskTime !== null && taskTime !== timeDisabledFor
      ? {
          title: innerTime ? innerTime.title : capture.title,
          time: taskTime,
          matched: taskTime,
        }
      : null;
  const parsedRecurrence = recurrenceActive
    ? {
        title: innerTime ? innerTime.title : recExtract.title,
        rule: recExtract.rule,
        matched: recExtract.matched,
      }
    : null;
  const effectiveRule = parsedRecurrence?.rule ?? manualRule;

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
    if (!groupOpen && !moreOpen && !groupsOpen) return;

    function onPointerDown(e: PointerEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) {
        setGroupOpen(false);
        setMoreOpen(false);
        setGroupsOpen(false);
      }
    }

    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [groupOpen, moreOpen, groupsOpen]);

  // Only collapsing the rail for the capture text fields — not the nav links or
  // toolbar buttons, whose focus would otherwise collapse the rail out from
  // under the tap and eat the click.
  function isTextEntry(el: EventTarget | null): boolean {
    return (
      el === inputRef.current ||
      (el instanceof HTMLElement && el.tagName === "TEXTAREA")
    );
  }

  function onFormFocus(e: React.FocusEvent<HTMLFormElement>) {
    if (isTextEntry(e.target)) {
      setTyping(true);
      setMoreOpen(false);
      setGroupsOpen(false);
    }
  }

  function openGroupsSheet() {
    setMoreOpen(false);
    setGroupsOpen(true);
    // One lazy fetch per mount — the sheet works without it (link picker
    // just explains calendars aren't available yet).
    if (calendarOptions === null) {
      void loadCalendarOptions().then(setCalendarOptions);
    }
  }

  function onFormBlur(e: React.FocusEvent<HTMLFormElement>) {
    if (!isTextEntry(e.relatedTarget)) {
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

  function confirmSpend(draft: SpendDraft) {
    const account = accounts.find((a) => a.id === draft.accountId);
    if (!account) {
      setSpendError("pick an account");
      return;
    }
    setSpendBusy(true);
    setSpendError(null);
    void recordBalanceChange({
      accountId: account.id,
      newBalance: account.balance - draft.amount,
      categoryId: draft.categoryId,
      note: draft.description || null,
    }).then((result) => {
      setSpendBusy(false);
      if (result.error) {
        setSpendError(result.error);
        return;
      }
      setSpendDraft(null);
      setTitle("");
      inputRef.current?.focus();
    });
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();

    // A pinned spend proposal: Enter again commits it.
    if (spendDraft) {
      confirmSpend(spendDraft);
      return;
    }

    if (capture.mode === "copilot") {
      const message = capture.message;
      setTitle("");
      router.push(
        message ? `/plan?q=${encodeURIComponent(message)}` : "/plan",
      );
      return;
    }

    if (capture.mode === "spend") {
      if (capture.amount === null) {
        setSpendError("amount first — e.g. $12.50 lunch");
        return;
      }
      if (accounts.length === 0) {
        setSpendError("no accounts yet — add one in money first");
        return;
      }
      setSpendError(null);
      // First Enter pins the proposal; the second commits. Never silent.
      setSpendDraft({
        amount: capture.amount,
        description: capture.description,
        accountId: accounts[0].id,
        categoryId: capture.categoryId,
      });
      return;
    }

    if (effectiveRule) {
      const rt = (
        parsedRecurrence?.title ??
        parsedTime?.title ??
        title
      ).trim();
      const rule = effectiveRule;
      if (!rt || busy) return;

      setBusy(true);
      setTitle("");
      setNotes("");
      setTimeDisabledFor(null);
      setRecurrenceDisabledFor(null);
      setManualRule(null);
      setDraftDays([]);
      setRepeatOpen(false);

      await createRecurringTask({
        title: rt,
        groupId: selectedGroupId,
        notes: notes.trim() || null,
        priority,
        frequency: rule.frequency,
        weekdays: rule.weekdays,
        dayOfMonth: rule.day_of_month,
        intervalDays: rule.interval_days,
        startDate: rule.start_date,
        dueTime: parsedTime?.time ?? null,
      });

      setPriority("med");
      setBusy(false);
      inputRef.current?.focus();
      return;
    }

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
    <div
      ref={wrapRef}
      className="fixed z-40 left-4 right-4 bottom-[max(env(safe-area-inset-bottom),1rem)] rounded-t-[8px] bg-page/95 border border-line p-3 shadow-[0_0_28px_rgba(0,0,0,0.65)] lg:left-1/2 lg:right-auto lg:w-[min(44rem,calc(100vw-4rem))] lg:-translate-x-1/2"
    >
      {moreOpen && (
        <nav className="absolute left-0 right-0 bottom-full mb-2 border border-line bg-popover p-2 shadow-[0_0_28px_rgba(0,0,0,0.65)]">
          <Link
            href="/tasks"
            onClick={() => setMoreOpen(false)}
            className="flex min-h-11 w-full items-center justify-between px-3 text-action lowercase text-fg hover:bg-card transition-colors"
          >
            <span>tasks</span>
            {inboxCount > 0 && (
              <span className="text-meta text-muted">{inboxCount} inbox</span>
            )}
          </Link>
          <button
            type="button"
            onClick={openGroupsSheet}
            className="flex min-h-11 w-full items-center justify-between px-3 text-action lowercase text-fg hover:bg-card transition-colors"
          >
            <span>groups</span>
            <span className="text-meta text-muted">{groups.length}</span>
          </button>
          {[
            { href: "/week", label: "week", badge: 0 },
            { href: "/tasks", label: "tasks", badge: inboxCount },
            { href: "/learn", label: "learn", badge: 0 },
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
            </Link>
          ))}
        </nav>
      )}

      {groupsOpen && (
        <section
          aria-label="manage groups"
          className="absolute left-0 right-0 bottom-full mb-2 border border-line bg-popover shadow-[0_0_28px_rgba(0,0,0,0.65)]"
        >
          <div className="flex items-center justify-between border-b border-line px-3 py-1">
            <p className="text-label uppercase text-muted">groups</p>
            <button
              type="button"
              onClick={() => setGroupsOpen(false)}
              aria-label="close groups"
              className="min-h-11 px-2 text-lg leading-none text-muted hover:text-fg transition-colors"
            >
              ×
            </button>
          </div>
          <div className="max-h-[min(60vh,30rem)] overflow-y-auto p-3">
            <GroupsClient
              key={groups.map((g) => g.id).join(",")}
              initial={groups}
              calendars={calendarOptions ?? []}
              variant="sheet"
              onNavigate={() => setGroupsOpen(false)}
            />
          </div>
        </section>
      )}

      <form onSubmit={onSubmit} onFocus={onFormFocus} onBlur={onFormBlur}>
      <div
        className={`overflow-hidden transition-[max-height,opacity,margin] duration-200 ease-signal ${
          railCollapsed ? "max-h-0 opacity-0 mb-0" : "max-h-14 opacity-100 mb-2"
        }`}
      >
        <div className="flex items-stretch" data-tour="dock-rail">
          {RAIL_TABS.map((tab) => {
            const active = isActive(pathname, tab.href);
            return (
              <Link
                key={tab.href}
                href={tab.href}
                aria-current={active ? "page" : undefined}
                className={`${tab.mobileOnly ? "lg:hidden " : ""}flex-1 flex min-h-11 flex-col items-center justify-center gap-0.5 border-b-2 transition-colors ${
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

      {spendDraft && (
        <div className="mb-2">
          <ProposalCard
            title="log spend"
            confirmLabel={`log ${formatMoney(
              spendDraft.amount,
              accounts.find((a) => a.id === spendDraft.accountId)?.currency ??
                "USD",
            )}`}
            onConfirm={() => confirmSpend(spendDraft)}
            onSkip={() => {
              setSpendDraft(null);
              inputRef.current?.focus();
            }}
            pending={spendBusy}
            error={spendError}
          >
            <p className="text-body text-fg">
              {spendDraft.description || "uncategorized spend"}
            </p>
            <div className="flex flex-wrap gap-1">
              {accounts.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  onClick={() =>
                    setSpendDraft({ ...spendDraft, accountId: a.id })
                  }
                  aria-pressed={spendDraft.accountId === a.id}
                  className={`min-h-11 px-3 text-action lowercase border transition-colors ${
                    spendDraft.accountId === a.id
                      ? "border-accent text-fg"
                      : "border-hairline text-muted hover:text-fg"
                  }`}
                >
                  {a.name}
                </button>
              ))}
            </div>
            <div className="flex flex-wrap gap-1">
              <button
                type="button"
                onClick={() =>
                  setSpendDraft({ ...spendDraft, categoryId: null })
                }
                aria-pressed={spendDraft.categoryId === null}
                className={`min-h-11 px-3 text-action lowercase border transition-colors ${
                  spendDraft.categoryId === null
                    ? "border-accent text-fg"
                    : "border-hairline text-muted hover:text-fg"
                }`}
              >
                uncategorized
              </button>
              {categories.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() =>
                    setSpendDraft({ ...spendDraft, categoryId: c.id })
                  }
                  aria-pressed={spendDraft.categoryId === c.id}
                  className={`inline-flex items-center gap-1.5 min-h-11 px-3 text-action lowercase border transition-colors ${
                    spendDraft.categoryId === c.id
                      ? "border-accent text-fg"
                      : "border-hairline text-muted hover:text-fg"
                  }`}
                >
                  <span
                    className="h-2 w-2"
                    style={{ backgroundColor: c.color }}
                    aria-hidden
                  />
                  {c.name}
                </button>
              ))}
            </div>
          </ProposalCard>
        </div>
      )}

      {!spendDraft && capture.mode !== "task" && (
        <p className="mb-2 text-meta text-muted">
          {capture.mode === "spend"
            ? spendError ??
              (capture.amount !== null
                ? `log spend — enter to review ${capture.description ? `"${capture.description}"` : ""}`
                : "log spend — add an amount, e.g. $12.50 lunch")
            : "ask the copilot — enter to open plan"}
        </p>
      )}

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

        {repeatOpen && !effectiveRule && capture.mode === "task" && (
          <div className="mb-2 border border-line bg-popover p-3 space-y-3">
            <button
              type="button"
              onClick={() => {
                setManualRule({
                  frequency: "daily",
                  weekdays: null,
                  day_of_month: null,
                  interval_days: null,
                  start_date: null,
                });
                setRepeatOpen(false);
              }}
              className="min-h-11 w-full border border-line-strong px-3 text-[10px] tracking-widest uppercase text-fg hover:border-accent transition-colors"
            >
              every day
            </button>
            <div className="flex gap-1">
              {["s", "m", "t", "w", "t", "f", "s"].map((label, day) => {
                const active = draftDays.includes(day);
                return (
                  <button
                    key={day}
                    type="button"
                    aria-pressed={active}
                    onClick={() => {
                      const next = active
                        ? draftDays.filter((d) => d !== day)
                        : [...draftDays, day].sort((a, b) => a - b);
                      setDraftDays(next);
                      setManualRule(
                        next.length > 0
                          ? {
                              frequency: "weekly",
                              weekdays: next,
                              day_of_month: null,
                              interval_days: null,
                              start_date: null,
                            }
                          : null,
                      );
                    }}
                    className={`min-h-11 flex-1 border text-[10px] tracking-widest uppercase transition-colors ${
                      active
                        ? "bg-accent text-accent-fg border-accent"
                        : "border-line-strong text-muted hover:border-fg hover:text-fg"
                    }`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[10px] tracking-widest uppercase text-muted">
                every
              </span>
              <input
                type="number"
                min={2}
                max={365}
                value={draftInterval}
                onChange={(e) =>
                  setDraftInterval(
                    Math.max(2, Math.min(365, Number(e.target.value) || 2)),
                  )
                }
                aria-label="repeat every N days"
                className="w-16 bg-card border border-line-strong text-fg text-sm px-2 py-2 focus:border-accent focus:outline-none transition-colors"
              />
              <span className="text-[10px] tracking-widest uppercase text-muted">
                days
              </span>
              <button
                type="button"
                onClick={() => {
                  setManualRule({
                    frequency: "custom",
                    weekdays: null,
                    day_of_month: null,
                    interval_days: draftInterval,
                    start_date: null,
                  });
                  setRepeatOpen(false);
                }}
                className="min-h-11 border border-line-strong px-3 text-[10px] tracking-widest uppercase text-muted hover:border-fg hover:text-fg transition-colors"
              >
                set
              </button>
            </div>
          </div>
        )}

        <div
          className={`flex items-center flex-wrap gap-2 mb-2 ${
            capture.mode !== "task" ? "hidden" : ""
          }`}
        >
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

          {parsedTime && (dueDate || effectiveRule) && (
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

          {effectiveRule ? (
            <button
              type="button"
              onClick={() => {
                if (parsedRecurrence) {
                  setRecurrenceDisabledFor(parsedRecurrence.matched);
                }
                setManualRule(null);
                setDraftDays([]);
              }}
              aria-label={`remove repeat ${formatRecurrence(effectiveRule)}`}
              title="tap to remove the repeat"
              className="min-h-11 text-[10px] tracking-widest uppercase px-3 py-2 border bg-accent text-accent-fg border-accent transition-colors"
            >
              ↻ {formatRecurrence(effectiveRule)} ×
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setRepeatOpen((v) => !v)}
              aria-expanded={repeatOpen}
              className="min-h-11 text-[10px] tracking-widest uppercase px-3 py-2 border border-line-strong text-muted hover:border-fg hover:text-fg transition-colors"
            >
              ↻ repeat
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

        <div className="flex items-center gap-2" data-tour="capture-input">
          <input
            ref={inputRef}
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="new task…  ($ spend · ? plan)"
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
    </div>
  );
}
