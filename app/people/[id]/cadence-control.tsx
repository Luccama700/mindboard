"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { setPersonCadence } from "@/app/actions/people";
import { Button } from "@/app/_components/ui";
import { backfillToDate, type BackfillChoice } from "@/app/lib/snapshots/people";

const PRESETS: { label: string; days: number }[] = [
  { label: "weekly", days: 7 },
  { label: "every 2 weeks", days: 14 },
  { label: "monthly", days: 30 },
  { label: "quarterly", days: 90 },
];

const BACKFILL_CHIPS: { choice: BackfillChoice; label: string }[] = [
  { choice: "today", label: "today" },
  { choice: "this_week", label: "this week" },
  { choice: "this_month", label: "this month" },
  { choice: "longer_ago", label: "longer ago" },
  { choice: "not_sure", label: "not sure" },
];

// Cadence is opt-in attention (docs/people-plan.md §3.2). The first set on a
// person with no logged interactions asks ONE backfill question — taps, not
// typing — so nudges start correct instead of suppressed (§2).
export function CadenceControl({
  personId,
  checkinDays,
  hasInteractions,
  today,
}: {
  personId: string;
  checkinDays: number | null;
  hasInteractions: boolean;
  today: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [customDays, setCustomDays] = useState(checkinDays ?? 30);
  const [pendingDays, setPendingDays] = useState<number | null>(null);

  async function apply(
    days: number | null,
    backfill: { occurredAt: string; precision: "exact" | "approx" } | null,
  ) {
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await setPersonCadence({
      personId,
      checkinDays: days,
      backfill,
    });
    setBusy(false);
    if (result?.error) {
      setError(result.error);
      return;
    }
    setPendingDays(null);
    setOpen(false);
    router.refresh();
  }

  function pick(days: number | null) {
    // Clearing, or a person who already has history, needs no backfill.
    if (days === null || hasInteractions) {
      void apply(days, null);
      return;
    }
    setPendingDays(days);
  }

  if (pendingDays !== null) {
    return (
      <div className="glass-panel rounded-pop px-4 py-3 space-y-3">
        <p className="text-body text-fg">when did you last talk?</p>
        <div className="flex flex-wrap gap-2">
          {BACKFILL_CHIPS.map((chip) => (
            <Button
              key={chip.choice}
              variant="outline"
              disabled={busy}
              onClick={() => {
                const resolved = backfillToDate(chip.choice, today);
                void apply(pendingDays, resolved);
              }}
            >
              {chip.label}
            </Button>
          ))}
        </div>
        <p className="text-meta text-muted">
          rough is fine — it just gives the check-in rhythm a starting point.
        </p>
        {error && <p className="text-meta text-danger">{error}</p>}
      </div>
    );
  }

  return (
    <div data-tour="person-cadence">
      {checkinDays === null && !open ? (
        <Button variant="quiet" onClick={() => setOpen(true)}>
          + check in regularly
        </Button>
      ) : (
        <div className="space-y-2">
          <p className="text-label uppercase text-muted">
            check in {checkinDays !== null ? `· every ${checkinDays} days` : ""}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {PRESETS.map((preset) => (
              <Button
                key={preset.days}
                variant={checkinDays === preset.days ? "accent" : "outline"}
                disabled={busy}
                onClick={() => pick(preset.days)}
              >
                {preset.label}
              </Button>
            ))}
            <span className="flex items-center gap-1">
              <input
                type="number"
                min={1}
                max={365}
                value={customDays}
                onChange={(e) =>
                  setCustomDays(
                    Math.max(1, Math.min(365, Number(e.target.value) || 1)),
                  )
                }
                aria-label="custom check-in interval in days"
                className="w-16 bg-glass-well rounded-field border border-line-strong text-fg text-sm px-2 py-2 focus:border-accent focus:outline-none transition-colors"
              />
              <Button variant="outline" disabled={busy} onClick={() => pick(customDays)}>
                days
              </Button>
            </span>
            {checkinDays !== null && (
              <Button variant="quiet" disabled={busy} onClick={() => pick(null)}>
                stop
              </Button>
            )}
          </div>
          {error && <p className="text-meta text-danger">{error}</p>}
        </div>
      )}
    </div>
  );
}
