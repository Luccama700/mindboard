"use client";

// Energy cost (1..5) as five dots. Read-only `EnergyDots` sits in a row's
// subtitle; `EnergyControl` is the one-tap setter in the editor. The AI
// default reads as OUTLINED dots, a value the user tapped as FILLED — the
// distinction is the whole point: a guess you can correct vs. your own call.
// No totals, no scores: the dots only ever describe one task.

export type EnergySource = "ai" | "user" | null;

const LEVELS = [1, 2, 3, 4, 5] as const;

export function energyLabel(cost: number | null, source: EnergySource): string {
  if (cost == null) return "energy not set";
  return `energy ${cost} of 5${source === "ai" ? ", suggested" : ""}`;
}

function dotClass(level: number, cost: number | null, source: EnergySource): string {
  const lit = cost != null && level <= cost;
  if (!lit) return "border-line-strong bg-transparent";
  return source === "user"
    ? "border-accent bg-accent"
    : "border-accent bg-transparent";
}

export function EnergyDots({
  cost,
  source,
  className = "",
}: {
  cost: number | null;
  source: EnergySource;
  className?: string;
}) {
  if (cost == null) return null;
  return (
    <span
      role="img"
      aria-label={energyLabel(cost, source)}
      title={energyLabel(cost, source)}
      className={`inline-flex items-center gap-[3px] align-middle ${className}`}
    >
      {LEVELS.map((level) => (
        <span
          key={level}
          aria-hidden
          className={`inline-block h-[7px] w-[7px] rounded-full border ${dotClass(level, cost, source)}`}
        />
      ))}
    </span>
  );
}

export function EnergyControl({
  cost,
  source,
  onChange,
}: {
  cost: number | null;
  source: EnergySource;
  // Tapping a dot sets that level; tapping the current level clears it.
  onChange: (next: number | null) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="energy cost"
      className="inline-flex items-center"
    >
      {LEVELS.map((level) => {
        const lit = cost != null && level <= cost;
        return (
          <button
            key={level}
            type="button"
            role="radio"
            aria-checked={cost === level}
            aria-label={`energy ${level} of 5`}
            onClick={() => onChange(cost === level ? null : level)}
            className="inline-flex items-center justify-center min-h-11 min-w-9 press"
          >
            <span
              aria-hidden
              className={`inline-block h-3.5 w-3.5 rounded-full border-2 transition-colors ${
                lit
                  ? source === "user"
                    ? "border-accent bg-accent"
                    : "border-accent bg-transparent"
                  : "border-line-strong bg-transparent hover:border-fg"
              }`}
            />
          </button>
        );
      })}
      <span className="ml-2 text-[10px] tracking-widest uppercase text-muted">
        {cost == null ? "unset" : source === "ai" ? "suggested" : "yours"}
      </span>
    </div>
  );
}
