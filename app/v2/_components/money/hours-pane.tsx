"use client";

import { useMemo, type CSSProperties } from "react";

import { MONEY_COPY, buildHoursView } from "@/app/lib/v2/view/money";
import { useDay } from "../day-provider";

/**
 * One plain bar and its sentence. A meter, not a score: no percentage, no
 * colour for doing well, and the bar is drawn full rather than past its end.
 *
 * `aria-valuenow` is held to the bar's range, because a meter's value outside
 * its own bounds is not one a screen reader can say; the true figure is in
 * `aria-valuetext` and on the screen. "Over the cap" is printed from the
 * view's own `over`, never from the bar being full: the figures are rounded to
 * the quarter, so "30 of 30 hours" can be over.
 */
function Meter({
  kind,
  name,
  value,
  max,
  label,
  over,
}: {
  kind: "target" | "cap";
  name: string;
  value: number;
  max: number;
  label: string;
  over: boolean;
}) {
  const share = max > 0 ? Math.min(1, Math.max(0, value / max)) : value > 0 ? 1 : 0;
  return (
    <li className="v2-money-meter" data-kind={kind} data-over={over ? "" : undefined}>
      <p className="v2-money-meter-head">
        <span className="v2-money-meter-name">{name}</span>{" "}
        <span className="v2-money-meter-value">{label}</span>
      </p>
      <div
        className="v2-money-bar"
        role="meter"
        aria-label={name}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={Math.max(0, Math.min(value, max))}
        aria-valuetext={label}
      >
        <span className="v2-money-bar-fill" style={{ "--v2-money-at": share } as CSSProperties} />
      </div>
      {over && <p className="v2-money-over">{MONEY_COPY.hours.over}</p>}
    </li>
  );
}

/**
 * This week's paid hours against the target and the cap.
 *
 * FROM THE DAY, NOT FROM MONEY. The hours are the planner's own: its input
 * (`useDay().data.input`) and the blocks of the plan on screen, so a press on
 * the day that skips a block of paid work moves these bars in the same render,
 * and the pane works when the source holds no money data at all. It has no age
 * line for the same reason.
 *
 * A bar is drawn only for what the rules set. A missing cap can mean no cap,
 * an exempt week or a day planned in travel mode, and the view does not say
 * which, so neither does the pane.
 */
export function HoursPane() {
  const { data, plan } = useDay();
  const view = useMemo(() => buildHoursView(data.input, plan.blocks), [data.input, plan.blocks]);

  return (
    <div className="v2-money v2-money-hours">
      {view.empty ? (
        <p className="v2-money-empty">{MONEY_COPY.empty.hours}</p>
      ) : (
        <ul className="v2-money-meters" role="list">
          {view.target !== null && (
            <Meter
              kind="target"
              name={MONEY_COPY.hours.target}
              value={view.target.done}
              max={view.target.hours}
              label={view.target.label}
              over={false}
            />
          )}
          {view.cap !== null && (
            <Meter
              kind="cap"
              name={MONEY_COPY.hours.cap}
              value={view.cap.used}
              max={view.cap.hours}
              label={view.cap.label}
              over={view.cap.over}
            />
          )}
        </ul>
      )}
    </div>
  );
}
