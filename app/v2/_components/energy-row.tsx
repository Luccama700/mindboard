"use client";

import { TODAY_COPY, type TodayView } from "@/app/lib/v2/view/today";
import type { Ask, Energy } from "@/app/lib/v2/types";

/** The order the control shows, which the thumb's position is measured in. */
const ORDER: Energy[] = ["low", "ok", "good"];

/**
 * The three options, taken from the open energy ask when there is one so the
 * screen offers exactly what the channel would offer. An ask that does not carry
 * one option per energy falls back to the plain three rather than rendering a
 * half row.
 */
function optionsOf(ask: Ask | null): Array<{ energy: Energy; label: string }> {
  if (ask !== null) {
    const fromAsk: Array<{ energy: Energy; label: string }> = [];
    for (const option of ask.options) {
      if (option.effect.type === "energy.set") {
        fromAsk.push({ energy: option.effect.energy, label: option.label });
      }
    }
    if (fromAsk.length === ORDER.length) return fromAsk;
  }
  return ORDER.map((energy, index) => ({
    energy,
    label: TODAY_COPY.energyOptions[index],
  }));
}

export function EnergyRow({
  energy,
  answered,
  onPick,
}: {
  energy: TodayView["energy"];
  /** What the user has actually said. null means nobody has said yet. */
  answered: Energy | null;
  onPick: (energy: Energy) => void;
}) {
  const options = optionsOf(energy.ask);
  // Unanswered: the thumb waits under the assumption rather than claiming an
  // answer, and nothing reads as pressed.
  const index = ORDER.indexOf(answered ?? "ok");

  return (
    <>
      <div className="v2-energy">
        <span>{TODAY_COPY.energy}</span>
        <div className="v2-seg" role="group" aria-label={TODAY_COPY.energyGroup}>
          <div
            className="v2-thumb"
            data-answered={answered === null ? "no" : "yes"}
            style={{ transform: `translateX(${index * 100}%)` }}
          />
          {options.map((option) => (
            <button
              key={option.energy}
              type="button"
              aria-pressed={answered === option.energy}
              onClick={() => onPick(option.energy)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
      <p className="v2-said" aria-live="polite">
        {energy.label}
      </p>
    </>
  );
}
