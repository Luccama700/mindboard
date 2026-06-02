import Link from "next/link";
import { formatMoney } from "./money";
import { formatClockTime, formatDue } from "./date-utils";
import type { FinanceVitals } from "@/app/lib/snapshots/finance";
import type { TaskVitals } from "@/app/lib/snapshots/tasks";
import type { ScheduleVitals } from "@/app/lib/snapshots/schedule";
import type { InventoryVitals } from "@/app/lib/snapshots/inventory";

// The "at a glance" command-center strip: one compact tile per life domain,
// composed entirely from the pure snapshots. Read-only and deterministic — no AI.
// Horizontally scrollable so it stays a single row on a phone.

type TileProps = {
  label: string;
  primary: string;
  sub: string;
  tone?: "muted" | "accent" | "danger";
  href?: string;
};

const TONE_CLASS: Record<NonNullable<TileProps["tone"]>, string> = {
  muted: "text-muted",
  accent: "text-accent",
  danger: "text-danger",
};

function Tile({ label, primary, sub, tone = "muted", href }: TileProps) {
  const body = (
    <div
      className={`flex-shrink-0 w-36 border border-line bg-card px-3 py-2.5 ${
        href ? "hover:border-fg transition-colors" : ""
      }`}
    >
      <p className="text-[10px] tracking-widest uppercase text-muted">{label}</p>
      <p className="text-base font-bold text-fg mt-1 truncate">{primary}</p>
      <p className={`text-[11px] mt-0.5 truncate ${TONE_CLASS[tone]}`}>{sub}</p>
    </div>
  );
  return href ? (
    <Link href={href} className="block">
      {body}
    </Link>
  ) : (
    body
  );
}

function deltaSub(delta: number, currency: string): { sub: string; tone: TileProps["tone"] } {
  if (delta === 0) return { sub: "no change today", tone: "muted" };
  const sign = delta > 0 ? "+" : "−";
  return {
    sub: `${sign}${formatMoney(Math.abs(delta), currency)} today`,
    tone: delta > 0 ? "accent" : "danger",
  };
}

export function VitalsStrip({
  finance,
  tasks,
  schedule,
  inventory,
}: {
  finance: FinanceVitals;
  tasks: TaskVitals;
  schedule: ScheduleVitals;
  inventory: InventoryVitals;
}) {
  const delta = deltaSub(finance.todayDelta, finance.currency);

  const needsAttention = inventory.lowCount + inventory.outCount;

  return (
    <div className="flex gap-2 overflow-x-auto pb-1 -mx-5 px-5 lg:mx-0 lg:px-0">
      <Tile
        label="net worth"
        primary={formatMoney(finance.netWorth, finance.currency)}
        sub={delta.sub}
        tone={delta.tone}
        href="/finance"
      />

      <Tile
        label="next bill"
        primary={finance.nextBill ? formatMoney(finance.nextBill.amount, finance.currency) : "—"}
        sub={
          finance.nextBill
            ? `${finance.nextBill.name} · ${formatDue(finance.nextBill.dateKey)}`
            : "none scheduled"
        }
        href="/finance"
      />

      <Tile
        label="tasks"
        primary={`${tasks.dueToday} due`}
        sub={
          tasks.overdue > 0
            ? `${tasks.overdue} overdue`
            : `${tasks.dueSoon} this week`
        }
        tone={tasks.overdue > 0 ? "danger" : "muted"}
      />

      <Tile
        label="next up"
        primary={
          schedule.nextEvent
            ? formatClockTime(schedule.nextEvent.start)
            : `${schedule.freeHoursToday}h`
        }
        sub={
          schedule.nextEvent
            ? schedule.nextEvent.summary
            : "free today"
        }
      />

      <Tile
        label="inventory"
        primary={needsAttention > 0 ? `${needsAttention} low` : "stocked"}
        sub={
          inventory.soonestRunOut
            ? `${inventory.soonestRunOut.name} · ${formatDue(inventory.soonestRunOut.dateKey)}`
            : "all good"
        }
        tone={needsAttention > 0 ? "danger" : "muted"}
        href="/inventory"
      />
    </div>
  );
}
