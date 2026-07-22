"use client";

import { useState } from "react";
import type { RecurringTaskInput } from "@/app/actions/recurring-tasks";
import type { GroupOption } from "./task-row";

// Shared inline editor for a recurring rule — used by the /tasks repeating list
// and the dashboard stream's rtask cards. It owns no server state: every commit
// is a partial patch handed to onUpdate, whose caller runs the optimistic
// update + startTransition(updateRecurringTask). Local drafts exist only so the
// text/number inputs and toggles feel instant regardless of caller latency.

const WEEKDAY_LABELS = ["s", "m", "t", "w", "t", "f", "s"];
const DURATION_CHIPS = [15, 30, 45, 60, 120] as const;

function durationLabel(m: number): string {
  return m < 60 ? `${m}m` : `${m / 60}h`;
}

export type RecurringRuleShape = {
  id: string;
  title: string;
  due_time: string | null;
  duration_min: number | null;
  priority: "low" | "med" | "high";
  frequency: "daily" | "weekly" | "monthly" | "custom";
  weekdays: number[] | null;
  day_of_month: number | null;
  interval_days: number | null;
  group_id: string | null;
};

export function RecurringEditPanel({
  rule,
  groups,
  onUpdate,
  onArchive,
}: {
  rule: RecurringRuleShape;
  groups: GroupOption[];
  onUpdate: (patch: Partial<RecurringTaskInput>) => void;
  onArchive: () => void;
}) {
  const [titleDraft, setTitleDraft] = useState(rule.title);
  const [timeDraft, setTimeDraft] = useState(rule.due_time?.slice(0, 5) ?? "");
  const [duration, setDuration] = useState<number | null>(rule.duration_min);
  const [durDraft, setDurDraft] = useState(
    rule.duration_min != null &&
      !DURATION_CHIPS.includes(rule.duration_min as (typeof DURATION_CHIPS)[number])
      ? String(rule.duration_min)
      : "",
  );
  const [frequency, setFrequency] = useState(rule.frequency);
  const [days, setDays] = useState<number[]>(rule.weekdays ?? []);
  const [everyN, setEveryN] = useState(rule.interval_days ?? 2);
  const [monthDay, setMonthDay] = useState(rule.day_of_month ?? 1);

  const untimed = timeDraft === "";

  function commitTitle() {
    const next = titleDraft.trim();
    if (!next || next === rule.title) {
      setTitleDraft(rule.title);
      return;
    }
    onUpdate({ title: next });
  }

  function commitTime() {
    const next = timeDraft || null;
    if (next !== (rule.due_time?.slice(0, 5) ?? null)) {
      onUpdate({ dueTime: next });
    }
  }

  function setDurationValue(next: number | null) {
    setDuration(next);
    onUpdate({ durationMin: next });
  }

  function commitCustomDuration() {
    const raw = durDraft.trim();
    if (!raw) return;
    const n = Math.trunc(Number(raw));
    if (!Number.isFinite(n) || n < 15) {
      setDurDraft(
        duration != null &&
          !DURATION_CHIPS.includes(duration as (typeof DURATION_CHIPS)[number])
          ? String(duration)
          : "",
      );
      return;
    }
    setDurationValue(n);
  }

  function setDaily() {
    setFrequency("daily");
    onUpdate({
      frequency: "daily",
      weekdays: null,
      dayOfMonth: null,
      intervalDays: null,
      startDate: null,
    });
  }

  function toggleDay(day: number) {
    const next = days.includes(day)
      ? days.filter((d) => d !== day)
      : [...days, day].sort((a, b) => a - b);
    if (next.length === 0) return; // weekly needs at least one day
    setDays(next);
    setFrequency("weekly");
    onUpdate({
      frequency: "weekly",
      weekdays: next,
      dayOfMonth: null,
      intervalDays: null,
      startDate: null,
    });
  }

  function setCustom() {
    const n = Math.max(2, Math.min(365, everyN || 2));
    setEveryN(n);
    setFrequency("custom");
    onUpdate({
      frequency: "custom",
      intervalDays: n,
      weekdays: null,
      dayOfMonth: null,
      startDate: null,
    });
  }

  function commitMonthDay(value: number) {
    const n = Math.max(1, Math.min(31, Math.trunc(value) || 1));
    setMonthDay(n);
    onUpdate({
      frequency: "monthly",
      dayOfMonth: n,
      weekdays: null,
      intervalDays: null,
      startDate: null,
    });
  }

  const chipBase =
    "inline-flex items-center min-h-11 text-[10px] tracking-widest uppercase px-2.5 border rounded-full transition-colors";
  const chipOn = "bg-accent text-accent-fg border-accent";
  const chipOff = "border-line-strong text-muted hover:border-fg hover:text-fg";

  return (
    <div className="pt-3 pb-1 space-y-3">
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
            setTitleDraft(rule.title);
            e.currentTarget.blur();
          }
        }}
        maxLength={200}
        aria-label="rule title"
        className="w-full min-h-11 bg-glass-well rounded-field border border-line-strong focus:border-accent text-fg text-sm px-3 py-2 focus:outline-none transition-colors"
      />

      <div className="flex items-center flex-wrap gap-2">
        <label className="text-[10px] tracking-widest uppercase text-muted">
          time
        </label>
        <input
          type="time"
          step={900}
          value={timeDraft}
          onChange={(e) => setTimeDraft(e.target.value)}
          onBlur={commitTime}
          aria-label="due time"
          className="min-h-11 bg-glass-well rounded-field border border-line-strong focus:border-accent text-fg text-xs px-2 py-1.5 focus:outline-none transition-colors"
        />
        {timeDraft && (
          <button
            type="button"
            onClick={() => {
              setTimeDraft("");
              onUpdate({ dueTime: null });
            }}
            aria-label="clear time"
            className="inline-flex items-center justify-center min-h-11 min-w-11 text-muted text-lg leading-none hover:text-fg transition-colors"
          >
            ×
          </button>
        )}
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center flex-wrap gap-2">
          <label className="text-[10px] tracking-widest uppercase text-muted">
            duration
          </label>
          {DURATION_CHIPS.map((m) => {
            const active = duration === m;
            return (
              <button
                key={m}
                type="button"
                onClick={() => {
                  setDurDraft("");
                  setDurationValue(active ? null : m);
                }}
                className={`${chipBase} ${active ? chipOn : chipOff}`}
              >
                {durationLabel(m)}
              </button>
            );
          })}
          <input
            type="number"
            min={15}
            value={durDraft}
            onChange={(e) => setDurDraft(e.target.value)}
            onBlur={commitCustomDuration}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
            }}
            placeholder="min"
            aria-label="custom duration minutes"
            className="w-16 min-h-11 bg-glass-well rounded-field border border-line-strong focus:border-accent text-fg text-xs px-2 py-1.5 focus:outline-none transition-colors"
          />
        </div>
        {untimed && (
          <p className="text-[10px] text-muted">used to auto-place in free time</p>
        )}
      </div>

      <div className="space-y-2">
        <label className="text-[10px] tracking-widest uppercase text-muted">
          repeats
        </label>
        <div className="flex items-center flex-wrap gap-2">
          <button
            type="button"
            onClick={setDaily}
            className={`${chipBase} ${frequency === "daily" ? chipOn : chipOff}`}
          >
            every day
          </button>
        </div>
        <div className="flex gap-1">
          {WEEKDAY_LABELS.map((label, day) => {
            const active = frequency === "weekly" && days.includes(day);
            return (
              <button
                key={day}
                type="button"
                aria-pressed={active}
                onClick={() => toggleDay(day)}
                className={`min-h-11 flex-1 border rounded-full text-[10px] tracking-widest uppercase transition-colors ${
                  active ? chipOn : chipOff
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
            value={everyN}
            onChange={(e) =>
              setEveryN(Math.max(2, Math.min(365, Number(e.target.value) || 2)))
            }
            aria-label="repeat every N days"
            className="w-16 min-h-11 bg-glass-well rounded-field border border-line-strong text-fg text-sm px-2 py-2 focus:border-accent focus:outline-none transition-colors"
          />
          <span className="text-[10px] tracking-widest uppercase text-muted">
            days
          </span>
          <button
            type="button"
            onClick={setCustom}
            className={`${chipBase} ${
              frequency === "custom" ? chipOn : chipOff
            }`}
          >
            {frequency === "custom" ? "✓ set" : "set"}
          </button>
        </div>
        {frequency === "monthly" && (
          <div className="flex items-center gap-2">
            <span className="text-[10px] tracking-widest uppercase text-muted">
              day
            </span>
            <input
              type="number"
              min={1}
              max={31}
              value={monthDay}
              onChange={(e) => commitMonthDay(Number(e.target.value))}
              aria-label="day of month"
              className="w-16 min-h-11 bg-glass-well rounded-field border border-accent text-fg text-sm px-2 py-2 focus:outline-none transition-colors"
            />
          </div>
        )}
      </div>

      <div className="flex items-center gap-2">
        <label className="text-[10px] tracking-widest uppercase text-muted">
          priority
        </label>
        {(["low", "med", "high"] as const).map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => onUpdate({ priority: p })}
            className={`inline-flex items-center min-h-11 text-[10px] tracking-widest uppercase px-2.5 border rounded-full transition-colors ${
              rule.priority === p
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
          value={rule.group_id ?? ""}
          onChange={(e) => onUpdate({ groupId: e.target.value || null })}
          aria-label="rule group"
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

      <div className="flex justify-end">
        <button
          type="button"
          onClick={onArchive}
          className="inline-flex items-center min-h-11 text-danger text-xs tracking-widest uppercase hover:text-danger-hover transition-colors px-3"
        >
          stop repeating
        </button>
      </div>
    </div>
  );
}
