"use client";

import { useId, useMemo, type CSSProperties } from "react";

import { MONEY_COPY, buildHoursView, type MoneyMeter } from "@/app/lib/v2/view/money";
import { useDay } from "../day-provider";

/**
 * One plain bar and its sentence. A meter, not a score: no percentage, no
 * colour for doing well, and the bar drawn exactly as far as the view says.
 *
 * NOTHING IS WORKED OUT HERE. The view hands over the share of the bar to fill
 * (already held to 0..1) and the value held to the meter's range for
 * `aria-valuenow`; the true figure is the label, which is also the
 * `aria-valuetext`. "Over the cap" is printed from the view's own `over`, never
 * from the bar being full: the figures are rounded to the quarter, so "30 of 30
 * hours" can be over.
 *
 * NAMED ONCE. The meter takes its name from the heading above it
 * (`aria-labelledby`), so a screen reader does not say it twice.
 */
function Meter({
  kind,
  name,
  max,
  label,
  over,
  meter,
}: {
  kind: "target" | "cap";
  name: string;
  max: number;
  label: string;
  over: boolean;
  meter: MoneyMeter;
}) {
  const nameId = useId();
  return (
    <li className="v2-money-meter" data-kind={kind} data-over={over ? "" : undefined}>
      <p className="v2-money-meter-head">
        <span className="v2-money-meter-name" id={nameId}>
          {name}
        </span>{" "}
        <span className="v2-money-meter-value">{label}</span>
      </p>
      <div
        className="v2-money-bar"
        role="meter"
        aria-labelledby={nameId}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={meter.valueNow}
        aria-valuetext={label}
      >
        <span
          className="v2-money-bar-fill"
          style={{ "--v2-money-at": meter.share } as CSSProperties}
        />
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
              max={view.target.hours}
              label={view.target.label}
              over={false}
              meter={view.target}
            />
          )}
          {view.cap !== null && (
            <Meter
              kind="cap"
              name={MONEY_COPY.hours.cap}
              max={view.cap.hours}
              label={view.cap.label}
              over={view.cap.over}
              meter={view.cap}
            />
          )}
        </ul>
      )}
    </div>
  );
}
