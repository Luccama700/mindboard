"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { recordBalanceChange } from "@/app/actions/finance";
import { loadCalendarOptions } from "@/app/actions/groups";
import { loadPeopleGroups } from "@/app/actions/people-groups";
import { createRecurringTask } from "@/app/actions/recurring-tasks";
import { createTask } from "@/app/actions/tasks";
import { GroupsClient } from "@/app/tasks/groups-client";
import type { Group } from "@/app/tasks/groups-types";
import type { CalendarListEntry } from "@/utils/google/calendar";
import {
  extractTrailingEstimate,
  extractTrailingRecurrence,
  extractTrailingTime,
  parseCapture,
} from "@/app/lib/capture/parse";
import { formatRecurrence, type TaskRecurrence } from "@/app/lib/recurrence";
import {
  MODEL_OPTIONS,
  readStoredModel,
  storeModel,
} from "./assistant-model";
import { CategoriesSheet } from "./categories-sheet";
import type { SpendingCategory } from "./finance-types";
import { PeopleGroupsManager } from "./people-groups-manager";
import type { PersonGroup } from "./people-types";
import { formatMoney } from "./money";
import { ProposalCard } from "./proposal-card";
import { emitTaskOptimistic, emitTaskReplace } from "./capture-bus";
import { formatDue } from "./date-utils";
import type { Task } from "./types";

// Two-hemisphere brain outline in currentColor, so it tints with the tab's
// active/muted state like the text glyphs around it.
const BRAIN_ICON = (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="h-[15px] w-[15px]"
  >
    <path d="M12 4a3.5 3.5 0 0 0-3.4 2.7A3.5 3.5 0 0 0 6 10a3.5 3.5 0 0 0 .6 6.4A3.5 3.5 0 0 0 12 19.5Z" />
    <path d="M12 4a3.5 3.5 0 0 1 3.4 2.7A3.5 3.5 0 0 1 18 10a3.5 3.5 0 0 1-.6 6.4A3.5 3.5 0 0 1 12 19.5Z" />
  </svg>
);

const RAIL_TABS: {
  href: string;
  glyph: ReactNode;
  label: string;
  // A tab may show a short alias on small screens via shortLabel when the
  // label doesn't fit the mobile rail.
  shortLabel?: string;
  badge?: "inbox" | "brain";
}[] = [
  // Trimmed to the lived-in surfaces (2026-08-11). Inbox is the dashed chip
  // on /tasks; learn and plans stay reachable by URL but off the panels.
  { href: "/", glyph: "◆", label: "now" },
  { href: "/finance", glyph: "$", label: "money" },
  { href: "/inventory", glyph: "▤", label: "inventory" },
  { href: "/brain", glyph: BRAIN_ICON, label: "brain", badge: "brain" },
];

function isActive(
  pathname: string,
  search: URLSearchParams,
  href: string,
) {
  const [path, query] = href.split("?");
  if (path === "/") return pathname === "/";
  if (pathname !== path && !pathname.startsWith(`${path}/`)) return false;
  if (!query) return true;
  return query.split("&").every((pair) => {
    const [key, value] = pair.split("=");
    return search.get(key) === value;
  });
}

export type DockAccount = {
  id: string;
  name: string;
  balance: number;
  currency: string;
};

type SpendDraft = {
  amount: number;
  description: string;
  accountId: string;
  categoryId: string | null;
};

export function Dock({
  today,
  groups,
  inboxCount,
  brainCount,
  accounts,
  categories,
}: {
  // The user's day (user_settings.timezone), resolved by DockMount. The capture
  // bar's due-date chip means "today" as an intent, and whatever it holds is
  // written straight to tasks.due_date by createTask — so it has to be the day
  // the server will classify the task against, not the device's.
  today: string;
  groups: Group[];
  inboxCount: number;
  brainCount: number;
  accounts: DockAccount[];
  categories: SpendingCategory[];
}) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const badgeCounts = { inbox: inboxCount, brain: brainCount };

  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [dueDate, setDueDate] = useState<string | null>(() => today);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [priority, setPriority] = useState<"low" | "med" | "high">("med");
  const [groupOpen, setGroupOpen] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [groupsOpen, setGroupsOpen] = useState(false);
  const [groupsTab, setGroupsTab] = useState<"groups" | "categories" | "people">(
    "groups",
  );
  const [calendarOptions, setCalendarOptions] = useState<
    CalendarListEntry[] | null
  >(null);
  const [peopleGroups, setPeopleGroups] = useState<PersonGroup[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [typing, setTyping] = useState(false);
  const [keyboardUp, setKeyboardUp] = useState(false);
  const [timeDisabledFor, setTimeDisabledFor] = useState<string | null>(null);
  const [estimateDisabledFor, setEstimateDisabledFor] = useState<string | null>(
    null,
  );
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
  const [planMode, setPlanMode] = useState(false);
  const [assistantModel, setAssistantModel] = useState(readStoredModel);

  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dateInputRef = useRef<HTMLInputElement>(null);

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

  // Trailing effort estimate (`~2h`), a plain-task extractor like the time —
  // not offered on recurring tasks (createRecurringTask has no estimate field).
  const estExtract =
    capture.mode === "task" ? extractTrailingEstimate(capture.title) : null;
  const parsedEstimate =
    estExtract !== null &&
    estExtract.matched !== estimateDisabledFor &&
    !effectiveRule
      ? estExtract
      : null;

  const railCollapsed = typing || keyboardUp;

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    // Keyboard heuristic built on *changes*, not absolute viewport math
    // (window.innerHeight/scale semantics differ per browser): an on-screen
    // keyboard shrinks vv.height sharply while scale and width stay put.
    // Zoom changes scale and rotation/window-resize changes width — both
    // rebaseline instead of collapsing the rail.
    let base = { height: vv.height, width: vv.width, scale: vv.scale };
    const rebase = () => {
      base = { height: vv.height, width: vv.width, scale: vv.scale };
      setKeyboardUp(false);
    };
    const onResize = () => {
      if (vv.scale !== base.scale || vv.width !== base.width) {
        rebase();
        return;
      }
      base.height = Math.max(base.height, vv.height);
      setKeyboardUp(base.height - vv.height > 120);
    };
    vv.addEventListener("resize", onResize);
    window.addEventListener("resize", rebase);
    return () => {
      vv.removeEventListener("resize", onResize);
      window.removeEventListener("resize", rebase);
    };
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
    // One lazy fetch each per mount — the sheet works without them (link
    // picker just explains calendars aren't available yet).
    if (calendarOptions === null) {
      void loadCalendarOptions().then(setCalendarOptions);
    }
    if (peopleGroups === null) {
      void loadPeopleGroups().then(setPeopleGroups);
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

    // Plan mode: the bar is a copilot prompt — hand off to /plan, which
    // auto-sends the first message. Model choice rides along via localStorage.
    if (planMode) {
      const message = title.trim();
      if (!message) return;
      setTitle("");
      setPlanMode(false);
      router.push(`/plan?q=${encodeURIComponent(message)}`);
      return;
    }

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
    let t = parsed ? parsed.title : title;
    if (parsedEstimate) {
      const stripped = extractTrailingEstimate(t);
      if (stripped) t = stripped.title;
    }
    t = t.trim();
    const dueTime = parsed && dueDate ? parsed.time : null;
    const estimatedMinutes = parsedEstimate ? parsedEstimate.minutes : null;
    const markdownNotes = notes.trim() || null;
    if (!t || busy) return;

    setBusy(true);
    setTitle("");
    setNotes("");
    setTimeDisabledFor(null);
    setEstimateDisabledFor(null);

    const tempId = `temp-${crypto.randomUUID()}`;
    const optimisticTask: Task = {
      id: tempId,
      title: t,
      due_date: dueDate,
      due_time: dueTime,
      duration_min: null,
      estimated_minutes: estimatedMinutes,
      gcal_event_id: null,
      gcal_calendar_id: null,
      status: "todo",
      priority,
      ai_state: null,
      notes: markdownNotes,
      group_id: selectedGroupId,
      created_at: new Date().toISOString(),
      completed_at: null,
      missed_at: null,
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
      estimatedMinutes,
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
      data-capture-dock
      className="fixed z-40 left-4 right-4 bottom-[max(env(safe-area-inset-bottom),1rem)] glass rounded-dock p-3 lg:left-1/2 lg:right-auto lg:w-[min(48rem,calc(100vw-4rem))] lg:-translate-x-1/2"
    >
      {moreOpen && (
        <nav className="absolute left-0 right-0 bottom-full mb-2 glass-pop glass-rise rounded-pop p-2">
          <Link
            href="/tasks"
            onClick={() => setMoreOpen(false)}
            className="flex min-h-11 w-full items-center justify-between rounded-lg px-3 text-action lowercase text-fg hover:bg-card transition-colors"
          >
            <span>tasks</span>
          </Link>
          <button
            type="button"
            onClick={openGroupsSheet}
            className="flex min-h-11 w-full items-center justify-between rounded-lg px-3 text-action lowercase text-fg hover:bg-card transition-colors"
          >
            <span>groups</span>
            <span className="text-meta text-muted">{groups.length}</span>
          </button>
          {[
            { href: "/people", label: "people" },
            { href: "/mindspace", label: "mindspace" },
            { href: "/settings", label: "settings" },
          ].map((item) => (
            <Link
              key={item.href}
              href={item.href}
              onClick={() => setMoreOpen(false)}
              className="flex min-h-11 w-full items-center justify-between rounded-lg px-3 text-action lowercase text-fg hover:bg-card transition-colors"
            >
              <span>{item.label}</span>
            </Link>
          ))}
        </nav>
      )}

      {groupsOpen && (
        <section
          aria-label="manage groups"
          className="absolute left-0 right-0 bottom-full mb-2 glass-pop glass-rise rounded-pop overflow-hidden"
        >
          <div className="flex items-center justify-between border-b border-line px-3 py-1">
            <div className="flex items-center gap-4">
              {(["groups", "categories", "people"] as const).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => setGroupsTab(tab)}
                  aria-pressed={groupsTab === tab}
                  className={`min-h-11 text-label uppercase transition-colors ${
                    groupsTab === tab
                      ? "text-fg"
                      : "text-muted hover:text-fg"
                  }`}
                >
                  {tab}
                </button>
              ))}
            </div>
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
            {groupsTab === "groups" ? (
              <GroupsClient
                key={groups.map((g) => g.id).join(",")}
                initial={groups}
                calendars={calendarOptions ?? []}
                variant="sheet"
                onNavigate={() => setGroupsOpen(false)}
              />
            ) : groupsTab === "categories" ? (
              <CategoriesSheet
                key={categories.map((c) => c.id).join(",")}
                initial={categories}
              />
            ) : peopleGroups === null ? (
              <p className="text-meta text-muted py-2">loading…</p>
            ) : (
              <PeopleGroupsManager
                key={peopleGroups.map((g) => g.id).join(",")}
                initial={peopleGroups}
                onMutated={() => void loadPeopleGroups().then(setPeopleGroups)}
              />
            )}
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
            const active = isActive(pathname, searchParams, tab.href);
            const badge = tab.badge ? badgeCounts[tab.badge] : 0;
            return (
              <Link
                key={tab.href}
                href={tab.href}
                aria-current={active ? "page" : undefined}
                aria-label={badge > 0 ? `${tab.label}, ${badge}` : tab.label}
                className={`flex-1 flex min-h-11 flex-col items-center justify-center gap-0.5 rounded-xl transition-colors ${
                  active
                    ? "bg-accent-wash text-fg"
                    : "text-muted hover:text-fg"
                }`}
              >
                <span
                  className="relative inline-flex items-center text-body leading-none"
                  aria-hidden
                >
                  {tab.glyph}
                  {badge > 0 && (
                    <span
                      className={`absolute -top-1.5 left-full pl-0.5 text-[9px] leading-none ${
                        // Inbox is a real notification; the brain count is
                        // just ambient info and tints like its icon.
                        tab.badge === "inbox" ? "font-bold text-accent" : ""
                      }`}
                    >
                      {badge > 99 ? "99" : badge}
                    </span>
                  )}
                </span>
                <span className="text-label uppercase" aria-hidden>
                  {tab.shortLabel ? (
                    <>
                      <span className="lg:hidden">{tab.shortLabel}</span>
                      <span className="hidden lg:inline">{tab.label}</span>
                    </>
                  ) : (
                    tab.label
                  )}
                </span>
              </Link>
            );
          })}
          <button
            type="button"
            onClick={() => setMoreOpen((v) => !v)}
            aria-expanded={moreOpen}
            aria-label="more"
            className={`flex-1 flex min-h-11 flex-col items-center justify-center gap-0.5 rounded-xl transition-colors ${
              moreOpen ? "bg-accent-wash text-fg" : "text-muted hover:text-fg"
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
            <div className="space-y-1">
              <p className="text-label uppercase text-muted">account</p>
              <div className="flex flex-wrap gap-1">
                {accounts.map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() =>
                      setSpendDraft({ ...spendDraft, accountId: a.id })
                    }
                    aria-pressed={spendDraft.accountId === a.id}
                    className={`min-h-11 px-3 text-[10px] tracking-widest uppercase border rounded-full transition-colors ${
                      spendDraft.accountId === a.id
                        ? "bg-accent text-accent-fg border-accent"
                        : "border-line-strong text-muted hover:border-fg hover:text-fg"
                    }`}
                  >
                    {a.name}
                  </button>
                ))}
              </div>
            </div>
            <div className="space-y-1">
              <p className="text-label uppercase text-muted">category</p>
              <div className="flex flex-wrap gap-1">
                <button
                  type="button"
                  onClick={() =>
                    setSpendDraft({ ...spendDraft, categoryId: null })
                  }
                  aria-pressed={spendDraft.categoryId === null}
                  className={`inline-flex items-center gap-2 min-h-11 px-3 text-[10px] tracking-widest uppercase border rounded-full transition-colors ${
                    spendDraft.categoryId === null
                      ? "bg-accent text-accent-fg border-accent"
                      : "border-line-strong text-muted hover:border-fg hover:text-fg"
                  }`}
                >
                  <span
                    className="h-2.5 w-2.5 flex-shrink-0 border border-muted border-dashed"
                    aria-hidden
                  />
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
                    className={`inline-flex items-center gap-2 min-h-11 px-3 text-[10px] tracking-widest uppercase border rounded-full transition-colors ${
                      spendDraft.categoryId === c.id
                        ? "bg-accent text-accent-fg border-accent"
                        : "border-line-strong text-muted hover:border-fg hover:text-fg"
                    }`}
                  >
                    <span
                      className="h-2.5 w-2.5 flex-shrink-0"
                      style={{ backgroundColor: c.color }}
                      aria-hidden
                    />
                    {c.name}
                  </button>
                ))}
              </div>
            </div>
          </ProposalCard>
        </div>
      )}

      {!spendDraft && (planMode || capture.mode !== "task") && (
        <p className="mb-2 text-meta text-muted">
          {planMode
            ? "plan mode — enter sends this to the copilot"
            : capture.mode === "spend"
              ? spendError ??
                (capture.amount !== null
                  ? `log spend — enter to review ${capture.description ? `"${capture.description}"` : ""}`
                  : "log spend — add an amount, e.g. $12.50 lunch")
              : "ask the copilot — enter to open plan"}
        </p>
      )}

      <div>
        {groupOpen && (
          <div className="absolute left-0 right-0 bottom-full mb-2 glass-pop glass-rise rounded-pop p-2">
            <div className="max-h-56 overflow-y-auto">
              <button
                type="button"
                onClick={() => {
                  setSelectedGroupId(null);
                  setGroupOpen(false);
                  inputRef.current?.focus();
                }}
                className={`flex min-h-11 w-full items-center gap-2 rounded-lg px-3 text-left text-xs tracking-widest uppercase transition-colors ${
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
                  className={`flex min-h-11 w-full items-center gap-2 rounded-lg px-3 text-left text-xs tracking-widest uppercase transition-colors ${
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
          <div className="mb-2 glass-panel rounded-pop p-3 space-y-3">
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
              className="min-h-11 w-full border border-line-strong rounded-full px-3 text-[10px] tracking-widest uppercase text-fg hover:border-accent transition-colors"
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
                    className={`min-h-11 flex-1 border rounded-full text-[10px] tracking-widest uppercase transition-colors ${
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
                className="w-16 bg-glass-well rounded-field border border-line-strong text-fg text-sm px-2 py-2 focus:border-accent focus:outline-none transition-colors"
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
                className="min-h-11 border border-line-strong rounded-full px-3 text-[10px] tracking-widest uppercase text-muted hover:border-fg hover:text-fg transition-colors"
              >
                set
              </button>
            </div>
          </div>
        )}

        {/* One side-scrolling chip row on mobile (the dock must stay short);
            desktop has the width to wrap instead. shrink-0 keeps every chip
            at its natural width so the row scrolls rather than squeezes. */}
        <div
          className={`flex items-center gap-2 mb-2 flex-nowrap overflow-x-auto sm:flex-wrap sm:overflow-x-visible [&>*]:shrink-0 ${
            !planMode && capture.mode !== "task" ? "hidden" : ""
          }`}
        >
          {!planMode && (
          <>
          <button
            type="button"
            onClick={() => setGroupOpen((v) => !v)}
            aria-expanded={groupOpen}
            className={`flex min-h-11 max-w-[55vw] sm:max-w-full items-center gap-2 border rounded-full px-3 py-2 text-[10px] tracking-widest uppercase transition-colors ${
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
            className={`min-h-11 text-[10px] tracking-widest uppercase px-3 py-2 border rounded-full transition-colors ${
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
            className={`min-h-11 text-[10px] tracking-widest uppercase px-3 py-2 border rounded-full transition-colors ${
              isCustomDate
                ? "bg-accent text-accent-fg border-accent"
                : "border-line-strong text-muted hover:border-fg hover:text-fg"
            }`}
          >
            {isCustomDate ? `✓ ${formatDue(dueDate!, today)}` : "+ date"}
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
              className="inline-flex items-center justify-center min-h-11 min-w-11 text-muted text-lg leading-none hover:text-fg transition-colors"
            >
              ×
            </button>
          )}

          <button
            type="button"
            onClick={() => setNotesOpen((v) => !v)}
            aria-expanded={notesOpen}
            className={`min-h-11 text-[10px] tracking-widest uppercase px-3 py-2 border rounded-full transition-colors ${
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
              className="min-h-11 text-[10px] tracking-widest uppercase px-3 py-2 border rounded-full bg-accent text-accent-fg border-accent transition-colors"
            >
              {parsedTime.time} ×
            </button>
          )}

          {parsedEstimate && (
            <button
              type="button"
              onClick={() => setEstimateDisabledFor(parsedEstimate.matched)}
              aria-label={`remove estimate ${parsedEstimate.matched}`}
              title="tap to keep the estimate words as part of the title"
              className="min-h-11 text-[10px] tracking-widest uppercase px-3 py-2 border rounded-full bg-accent text-accent-fg border-accent transition-colors"
            >
              {parsedEstimate.matched} ×
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
              className="min-h-11 text-[10px] tracking-widest uppercase px-3 py-2 border rounded-full bg-accent text-accent-fg border-accent transition-colors"
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
            className={`min-h-11 text-[10px] tracking-widest uppercase px-3 py-2 border rounded-full transition-colors font-bold ${
              priority === "high"
                ? "border-danger text-danger hover:bg-danger hover:text-white"
                : "border-line-strong text-muted hover:border-fg hover:text-fg"
            }`}
          >
            {priority === "high" ? "!!!" : priority === "low" ? "!" : "!!"}
          </button>
          </>
          )}

          <label
            className={`flex min-h-11 items-center gap-2 border rounded-full px-3 py-2 text-[10px] tracking-widest uppercase cursor-pointer transition-colors ${
              planMode
                ? "bg-accent text-accent-fg border-accent"
                : "border-line-strong text-muted hover:border-fg hover:text-fg"
            }`}
          >
            <input
              type="checkbox"
              checked={planMode}
              onChange={(e) => {
                setPlanMode(e.target.checked);
                if (e.target.checked) {
                  setGroupOpen(false);
                  setRepeatOpen(false);
                  setNotesOpen(false);
                }
                inputRef.current?.focus();
              }}
              className="sr-only"
            />
            {planMode ? "✓ plan" : "? plan"}
          </label>

          {planMode && (
            <select
              value={assistantModel}
              onChange={(e) => {
                setAssistantModel(e.target.value);
                storeModel(e.target.value);
              }}
              aria-label="copilot model"
              className="min-h-11 bg-glass-well rounded-field border border-line-strong text-muted text-[10px] tracking-widest uppercase px-2 focus:border-accent focus:outline-none transition-colors"
            >
              {MODEL_OPTIONS.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          )}
        </div>

        {notesOpen && !planMode && (
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="markdown notes..."
            aria-label="task notes markdown"
            maxLength={5000}
            rows={4}
            className="mb-2 w-full resize-y bg-glass-well rounded-field border border-line-strong focus:border-accent text-fg placeholder-muted text-sm leading-relaxed px-3 py-2 focus:outline-none transition-colors"
          />
        )}

        <div className="flex items-center gap-2" data-tour="capture-input">
          <input
            ref={inputRef}
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={
              planMode ? "ask the copilot…" : "new task…  ($ spend · ? plan)"
            }
            autoComplete="off"
            autoCapitalize="sentences"
            enterKeyHint="done"
            maxLength={200}
            className="flex-1 bg-glass-well rounded-field border border-line-strong focus:border-accent text-fg placeholder-muted text-base px-3 py-3 focus:outline-none transition-colors"
          />
          <button
            type="submit"
            disabled={!title.trim() || busy}
            className="bg-accent text-accent-fg text-sm font-bold rounded-full px-4 py-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.25)] hover:opacity-90 active:scale-[.98] transition-[color,background-color,transform,opacity] disabled:opacity-30 disabled:cursor-not-allowed"
          >
            {planMode ? "plan" : "add"}
          </button>
        </div>
      </div>
      </form>
    </div>
  );
}
