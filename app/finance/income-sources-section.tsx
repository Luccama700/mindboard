"use client";

import { useState, useTransition } from "react";
import { ColorPicker, PALETTE } from "@/app/_components/color-picker";
import { formatDue } from "@/app/_components/date-utils";
import { addDaysKey } from "@/app/_components/finance-projection";
import { formatMoney } from "@/app/_components/money";
import type {
  IncomeSource,
  PayFrequency,
} from "@/app/_components/finance-types";
import type { CalendarListEntry } from "@/utils/google/calendar";
import { CollapsibleSection } from "./finance-shared";

function CalendarSelect({
  value,
  calendars,
  onChange,
}: {
  value: string | null;
  calendars: CalendarListEntry[];
  onChange: (id: string | null) => void;
}) {
  return (
    <div className="space-y-2">
      <p className="text-[10px] tracking-widest uppercase text-muted">
        worked-hours calendar
      </p>
      {calendars.length === 0 ? (
        <p className="text-muted text-xs">
          sign in with calendar access to read your shifts.
        </p>
      ) : (
        <select
          value={value ?? ""}
          onChange={(e) => onChange(e.target.value || null)}
          aria-label="worked-hours calendar"
          className="w-full bg-glass-well rounded-field border border-line-strong focus:border-accent text-fg text-xs uppercase tracking-widest px-2 py-2 focus:outline-none transition-colors"
        >
          <option value="">none</option>
          {calendars.map((c) => (
            <option key={c.id} value={c.id}>
              {c.summary}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

type PaySchedule = {
  payFrequency: PayFrequency | null;
  anchorPayday: string;
  periodStart: string;
  periodEnd: string;
};

const PAY_FREQUENCIES: PayFrequency[] = ["weekly", "biweekly", "monthly"];

// `today` is the user's day, threaded from the page: these defaults are shown
// in date inputs AND persisted as anchor_payday / period_start / period_end, so
// the device clock would silently anchor a pay cycle to the wrong day.
function defaultSchedule(today: string, source?: IncomeSource): PaySchedule {
  return {
    payFrequency: source?.pay_frequency ?? null,
    anchorPayday: source?.anchor_payday ?? today,
    periodStart: source?.period_start ?? addDaysKey(today, -13),
    periodEnd: source?.period_end ?? addDaysKey(today, -1),
  };
}

// Income pay schedules are validated server-side as a unit, so the picker emits
// the whole schedule on every change rather than partial patches.
function PaySchedulePicker({
  today,
  value,
  onChange,
}: {
  today: string;
  value: PaySchedule;
  onChange: (next: PaySchedule) => void;
}) {
  return (
    <div className="space-y-3">
      <div>
        <p className="text-[10px] tracking-widest uppercase text-muted mb-2">
          pay schedule
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => onChange({ ...value, payFrequency: null })}
            className={`inline-flex items-center min-h-11 text-xs px-3 py-2 border rounded-full transition-colors ${
              value.payFrequency === null
                ? "bg-fg text-page border-fg"
                : "border-line-strong text-muted hover:border-fg hover:text-fg"
            }`}
          >
            each shift
          </button>
          {PAY_FREQUENCIES.map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => onChange({ ...value, payFrequency: f })}
              className={`inline-flex items-center min-h-11 text-xs px-3 py-2 border rounded-full transition-colors ${
                value.payFrequency === f
                  ? "bg-fg text-page border-fg"
                  : "border-line-strong text-muted hover:border-fg hover:text-fg"
              }`}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      {value.payFrequency && (
        <>
          <div className="space-y-2">
            <p className="text-[10px] tracking-widest uppercase text-muted">
              next payday
            </p>
            <input
              type="date"
              value={value.anchorPayday}
              onChange={(e) =>
                onChange({ ...value, anchorPayday: e.target.value || today })
              }
              className="w-full bg-glass-well rounded-field border border-line-strong focus:border-accent text-fg text-sm px-3 py-2 focus:outline-none transition-colors"
            />
          </div>
          <div className="flex gap-3">
            <div className="flex-1 space-y-2">
              <p className="text-[10px] tracking-widest uppercase text-muted">
                pays for · from
              </p>
              <input
                type="date"
                value={value.periodStart}
                onChange={(e) =>
                  onChange({
                    ...value,
                    periodStart: e.target.value || value.periodStart,
                  })
                }
                className="w-full bg-glass-well rounded-field border border-line-strong focus:border-accent text-fg text-sm px-3 py-2 focus:outline-none transition-colors"
              />
            </div>
            <div className="flex-1 space-y-2">
              <p className="text-[10px] tracking-widest uppercase text-muted">
                to
              </p>
              <input
                type="date"
                value={value.periodEnd}
                onChange={(e) =>
                  onChange({
                    ...value,
                    periodEnd: e.target.value || value.periodEnd,
                  })
                }
                className="w-full bg-glass-well rounded-field border border-line-strong focus:border-accent text-fg text-sm px-3 py-2 focus:outline-none transition-colors"
              />
            </div>
          </div>
          <p className="text-[10px] text-muted">
            paydays repeat {value.payFrequency}; each covers a window that shifts
            the same way.
          </p>
        </>
      )}
    </div>
  );
}

function scheduleToPatch(next: PaySchedule): Partial<IncomeSource> {
  return {
    pay_frequency: next.payFrequency,
    anchor_payday: next.payFrequency ? next.anchorPayday : null,
    period_start: next.payFrequency ? next.periodStart : null,
    period_end: next.payFrequency ? next.periodEnd : null,
  };
}

export function IncomeManager({
  today,
  incomeSources,
  calendars,
  currency,
  onCreate,
  onUpdate,
  onArchive,
}: {
  // The user's day — see defaultSchedule.
  today: string;
  incomeSources: IncomeSource[];
  calendars: CalendarListEntry[];
  currency: string;
  onCreate: (input: {
    name: string;
    hourlyWage: number;
    taxRate: number;
    calendarId: string | null;
    color: string;
    payFrequency: PayFrequency | null;
    anchorPayday: string | null;
    periodStart: string | null;
    periodEnd: string | null;
    fixedAmount: number | null;
    fixedDay: number | null;
  }) => Promise<boolean>;
  onUpdate: (id: string, patch: Partial<IncomeSource>) => void;
  onArchive: (id: string) => void;
}) {
  const [formOpen, setFormOpen] = useState(false);

  return (
    <CollapsibleSection title="income" count={incomeSources.length}>
      <p className="text-[11px] text-muted leading-relaxed">
        each job reads worked hours from a linked Google Calendar. pay = hours ×
        wage × (1 − tax%). with a pay schedule, it lands as a lump on each payday
        for that period&apos;s shifts; otherwise it lands on the day worked. or
        check fixed monthly for a set amount on one day each month.
      </p>

      <ul className="space-y-2">
        {incomeSources.map((source) => (
          <IncomeRow
            today={today}
            key={source.id}
            source={source}
            calendars={calendars}
            currency={currency}
            onUpdate={onUpdate}
            onArchive={onArchive}
          />
        ))}
      </ul>

      {!formOpen ? (
        <button
          onClick={() => setFormOpen(true)}
          className="w-full text-left bg-transparent border border-dashed rounded-panel border-line-strong hover:border-accent hover:text-accent text-muted text-sm font-bold py-4 px-4 transition-colors"
        >
          + new income source
        </button>
      ) : (
        <IncomeForm
          today={today}
          calendars={calendars}
          onCreate={onCreate}
          onClose={() => setFormOpen(false)}
        />
      )}
    </CollapsibleSection>
  );
}

function IncomeForm({
  today,
  calendars,
  onCreate,
  onClose,
}: {
  today: string;
  calendars: CalendarListEntry[];
  onCreate: (input: {
    name: string;
    hourlyWage: number;
    taxRate: number;
    calendarId: string | null;
    color: string;
    payFrequency: PayFrequency | null;
    anchorPayday: string | null;
    periodStart: string | null;
    periodEnd: string | null;
    fixedAmount: number | null;
    fixedDay: number | null;
  }) => Promise<boolean>;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [wage, setWage] = useState("");
  const [tax, setTax] = useState("0");
  const [fixed, setFixed] = useState(false);
  const [fixedDay, setFixedDay] = useState("1");
  const [calendarId, setCalendarId] = useState<string | null>(null);
  const [color, setColor] = useState<string>(PALETTE[1]);
  const [schedule, setSchedule] = useState<PaySchedule>(defaultSchedule(today));
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const n = name.trim();
    if (!n) {
      setError("name required");
      return;
    }
    const w = Number(wage);
    if (!Number.isFinite(w) || w < 0) {
      setError(fixed ? "enter an amount" : "enter an hourly wage");
      return;
    }
    const t = Number(tax);
    if (!fixed && (!Number.isFinite(t) || t < 0 || t > 100)) {
      setError("tax must be 0–100");
      return;
    }
    const day = Number(fixedDay);
    if (fixed && (!Number.isInteger(day) || day < 1 || day > 31)) {
      setError("day must be 1–31");
      return;
    }
    startTransition(async () => {
      const ok = await onCreate(
        fixed
          ? {
              name: n,
              hourlyWage: 0,
              taxRate: 0,
              calendarId: null,
              color,
              payFrequency: null,
              anchorPayday: null,
              periodStart: null,
              periodEnd: null,
              fixedAmount: w,
              fixedDay: day,
            }
          : {
              name: n,
              hourlyWage: w,
              taxRate: t,
              calendarId,
              color,
              payFrequency: schedule.payFrequency,
              anchorPayday: schedule.payFrequency ? schedule.anchorPayday : null,
              periodStart: schedule.payFrequency ? schedule.periodStart : null,
              periodEnd: schedule.payFrequency ? schedule.periodEnd : null,
              fixedAmount: null,
              fixedDay: null,
            },
      );
      if (!ok) {
        setError("could not save income source");
        return;
      }
      onClose();
    });
  }

  return (
    <form onSubmit={submit} className="glass-panel p-4 space-y-5">
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        type="text"
        placeholder="job name (e.g. day job)"
        maxLength={64}
        autoComplete="off"
        autoFocus
        className="w-full bg-transparent text-fg placeholder-muted text-base font-bold focus:outline-none border-b border-line-strong focus:border-accent pb-2 transition-colors"
      />

      <label className="flex min-h-9 items-center gap-2 text-[10px] tracking-widest uppercase text-muted cursor-pointer">
        <input
          type="checkbox"
          checked={fixed}
          onChange={(e) => setFixed(e.target.checked)}
          className="accent-accent"
        />
        fixed monthly amount
      </label>

      <div className="flex gap-3">
        <div className="flex-1 space-y-2">
          <p className="text-[10px] tracking-widest uppercase text-muted">
            {fixed ? "amount" : "hourly wage"}
          </p>
          <input
            value={wage}
            onChange={(e) => setWage(e.target.value)}
            type="number"
            inputMode="decimal"
            step="any"
            min={0}
            placeholder="0.00"
            className="w-full bg-glass-well rounded-field border border-line-strong focus:border-accent text-fg text-base font-bold tabular-nums px-3 py-2 focus:outline-none transition-colors"
          />
        </div>
        {fixed ? (
          <div className="w-24 space-y-2">
            <p className="text-[10px] tracking-widest uppercase text-muted">
              on day
            </p>
            <input
              value={fixedDay}
              onChange={(e) => setFixedDay(e.target.value)}
              type="number"
              inputMode="numeric"
              step={1}
              min={1}
              max={31}
              className="w-full bg-glass-well rounded-field border border-line-strong focus:border-accent text-fg text-base tabular-nums px-3 py-2 focus:outline-none transition-colors"
            />
          </div>
        ) : (
          <div className="w-24 space-y-2">
            <p className="text-[10px] tracking-widest uppercase text-muted">
              tax %
            </p>
            <input
              value={tax}
              onChange={(e) => setTax(e.target.value)}
              type="number"
              inputMode="decimal"
              step="any"
              min={0}
              max={100}
              className="w-full bg-glass-well rounded-field border border-line-strong focus:border-accent text-fg text-base tabular-nums px-3 py-2 focus:outline-none transition-colors"
            />
          </div>
        )}
      </div>

      {!fixed && (
        <>
          <CalendarSelect
            value={calendarId}
            calendars={calendars}
            onChange={setCalendarId}
          />

          <PaySchedulePicker today={today} value={schedule} onChange={setSchedule} />
        </>
      )}

      <ColorPicker value={color} onChange={setColor} />

      {error && <p className="text-danger text-xs">{error}</p>}

      <div className="flex gap-2 pt-2">
        <button
          type="submit"
          disabled={isPending}
          className="flex-1 bg-accent text-accent-fg text-sm font-bold rounded-full py-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.25)] hover:opacity-90 transition-colors disabled:opacity-50"
        >
          create
        </button>
        <button
          type="button"
          onClick={onClose}
          className="px-4 text-muted text-sm hover:text-fg transition-colors"
        >
          cancel
        </button>
      </div>
    </form>
  );
}

function IncomeRow({
  today,
  source,
  calendars,
  currency,
  onUpdate,
  onArchive,
}: {
  today: string;
  source: IncomeSource;
  calendars: CalendarListEntry[];
  currency: string;
  onUpdate: (id: string, patch: Partial<IncomeSource>) => void;
  onArchive: (id: string) => void;
}) {
  const [editOpen, setEditOpen] = useState(false);
  const [nameDraft, setNameDraft] = useState(source.name);
  const isFixed = source.fixed_amount != null && source.fixed_day != null;
  // One amount field: it edits fixed_amount in fixed mode, hourly_wage otherwise.
  const [wageDraft, setWageDraft] = useState(
    String(Number(isFixed ? source.fixed_amount : source.hourly_wage)),
  );
  const [taxDraft, setTaxDraft] = useState(String(Number(source.tax_rate)));
  const [dayDraft, setDayDraft] = useState(String(source.fixed_day ?? 1));
  const linkedCalendar = source.calendar_id
    ? (calendars.find((c) => c.id === source.calendar_id) ?? null)
    : null;

  function commitName() {
    const next = nameDraft.trim();
    if (!next || next === source.name) {
      setNameDraft(source.name);
      return;
    }
    onUpdate(source.id, { name: next });
  }

  function commitWage() {
    const next = Number(wageDraft);
    if (!Number.isFinite(next) || next < 0) {
      setWageDraft(
        String(Number(isFixed ? source.fixed_amount : source.hourly_wage)),
      );
      return;
    }
    const rounded = Math.round(next * 100) / 100;
    if (isFixed) {
      if (rounded !== Number(source.fixed_amount)) {
        onUpdate(source.id, { fixed_amount: rounded, fixed_day: source.fixed_day });
      }
    } else if (rounded !== Number(source.hourly_wage)) {
      onUpdate(source.id, { hourly_wage: rounded });
    }
    setWageDraft(String(rounded));
  }

  function commitTax() {
    const next = Number(taxDraft);
    if (!Number.isFinite(next) || next < 0 || next > 100) {
      setTaxDraft(String(Number(source.tax_rate)));
      return;
    }
    const rounded = Math.round(next * 100) / 100;
    if (rounded !== Number(source.tax_rate)) {
      onUpdate(source.id, { tax_rate: rounded });
    }
    setTaxDraft(String(rounded));
  }

  function commitDay() {
    const next = Number(dayDraft);
    if (!Number.isInteger(next) || next < 1 || next > 31) {
      setDayDraft(String(source.fixed_day ?? 1));
      return;
    }
    if (next !== source.fixed_day) {
      onUpdate(source.id, { fixed_amount: source.fixed_amount, fixed_day: next });
    }
  }

  // Toggling on seeds the amount from whatever the field shows; toggling off
  // restores the preserved hourly setup (wage, tax, calendar, schedule).
  function toggleFixed(next: boolean) {
    if (next) {
      const amount = Number(wageDraft);
      const seeded =
        Number.isFinite(amount) && amount >= 0
          ? Math.round(amount * 100) / 100
          : 0;
      const day = Number(dayDraft);
      const seededDay = Number.isInteger(day) && day >= 1 && day <= 31 ? day : 1;
      setWageDraft(String(seeded));
      setDayDraft(String(seededDay));
      onUpdate(source.id, { fixed_amount: seeded, fixed_day: seededDay });
    } else {
      setWageDraft(String(Number(source.hourly_wage)));
      onUpdate(source.id, { fixed_amount: null, fixed_day: null });
    }
  }

  return (
    <li className="glass-panel overflow-hidden">
      <div className="flex items-stretch">
        <div className="flex flex-1 items-center gap-3 px-4 py-3 min-w-0">
          <span
            className="w-2 h-8 flex-shrink-0"
            style={{ backgroundColor: source.color }}
            aria-hidden
          />
          <div className="flex-1 min-w-0">
            <p className="text-fg text-sm font-bold truncate">{source.name}</p>
            <p className="text-muted text-[10px] tracking-widest uppercase mt-0.5 truncate">
              {isFixed ? (
                <>
                  {formatMoney(Number(source.fixed_amount), currency)}/mo · day{" "}
                  {source.fixed_day}
                </>
              ) : (
                <>
                  {formatMoney(Number(source.hourly_wage), currency)}/h
                  {Number(source.tax_rate) > 0
                    ? ` · ${Number(source.tax_rate)}% tax`
                    : ""}
                  {linkedCalendar
                    ? ` · ${linkedCalendar.summary}`
                    : source.calendar_id
                      ? " · linked"
                      : " · no calendar"}
                  {source.pay_frequency && source.anchor_payday
                    ? ` · ${source.pay_frequency} · pays ${formatDue(source.anchor_payday, today)}`
                    : " · each shift"}
                </>
              )}
            </p>
          </div>
        </div>
        <button
          onClick={() => setEditOpen((v) => !v)}
          aria-label="income actions"
          className="px-4 border-l border-line text-muted hover:text-fg hover:bg-card-hover transition-colors text-lg"
        >
          ···
        </button>
      </div>

      {editOpen && (
        <div className="border-t border-line p-4 space-y-5">
          <input
            type="text"
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                e.currentTarget.blur();
              }
            }}
            maxLength={64}
            aria-label="income name"
            className="w-full bg-transparent text-fg text-base font-bold focus:outline-none border-b border-line-strong focus:border-accent pb-2 transition-colors"
          />

          <label className="flex min-h-9 items-center gap-2 text-[10px] tracking-widest uppercase text-muted cursor-pointer">
            <input
              type="checkbox"
              checked={isFixed}
              onChange={(e) => toggleFixed(e.target.checked)}
              className="accent-accent"
            />
            fixed monthly amount
          </label>

          <div className="flex gap-3">
            <div className="flex-1 space-y-2">
              <p className="text-[10px] tracking-widest uppercase text-muted">
                {isFixed ? "amount" : "hourly wage"}
              </p>
              <input
                type="number"
                inputMode="decimal"
                step="any"
                min={0}
                value={wageDraft}
                onChange={(e) => setWageDraft(e.target.value)}
                onBlur={commitWage}
                className="w-full bg-glass-well rounded-field border border-line-strong focus:border-accent text-fg text-base font-bold tabular-nums px-3 py-2 focus:outline-none transition-colors"
              />
            </div>
            {isFixed ? (
              <div className="w-24 space-y-2">
                <p className="text-[10px] tracking-widest uppercase text-muted">
                  on day
                </p>
                <input
                  type="number"
                  inputMode="numeric"
                  step={1}
                  min={1}
                  max={31}
                  value={dayDraft}
                  onChange={(e) => setDayDraft(e.target.value)}
                  onBlur={commitDay}
                  className="w-full bg-glass-well rounded-field border border-line-strong focus:border-accent text-fg text-base tabular-nums px-3 py-2 focus:outline-none transition-colors"
                />
              </div>
            ) : (
              <div className="w-24 space-y-2">
                <p className="text-[10px] tracking-widest uppercase text-muted">
                  tax %
                </p>
                <input
                  type="number"
                  inputMode="decimal"
                  step="any"
                  min={0}
                  max={100}
                  value={taxDraft}
                  onChange={(e) => setTaxDraft(e.target.value)}
                  onBlur={commitTax}
                  className="w-full bg-glass-well rounded-field border border-line-strong focus:border-accent text-fg text-base tabular-nums px-3 py-2 focus:outline-none transition-colors"
                />
              </div>
            )}
          </div>

          {!isFixed && (
            <>
              <CalendarSelect
                value={source.calendar_id}
                calendars={calendars}
                onChange={(id) => onUpdate(source.id, { calendar_id: id })}
              />

              <PaySchedulePicker
                today={today}
                value={defaultSchedule(today, source)}
                onChange={(next) => onUpdate(source.id, scheduleToPatch(next))}
              />
            </>
          )}

          <ColorPicker
            value={source.color}
            onChange={(c) => onUpdate(source.id, { color: c })}
          />

          <div className="flex justify-end pt-2">
            <button
              onClick={() => {
                setEditOpen(false);
                onArchive(source.id);
              }}
              className="text-danger text-xs tracking-widest uppercase hover:text-danger-hover transition-colors py-2 px-3"
            >
              delete
            </button>
          </div>
        </div>
      )}
    </li>
  );
}
