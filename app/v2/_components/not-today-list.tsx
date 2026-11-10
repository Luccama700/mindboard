"use client";

import { useState } from "react";

import {
  NOT_TODAY_VISIBLE,
  TODAY_COPY,
  showMoreLabel,
  type TodayView,
} from "@/app/lib/v2/view/today";
import { ListRow } from "./list-row";

/**
 * What the planner wanted to do and did not, with the reason in words. It is a
 * statement, not a queue: there is nothing to press on a row, because the way to
 * change it is to change the day.
 *
 * A real account has dozens of open tasks, so only the first eight are shown and
 * the rest are behind one press. The cut is here rather than in the view model
 * because the view model's job is to say what did not fit; how much of that to
 * put on the screen at once is a question about the screen.
 */
export function NotTodayList({ entries }: { entries: TodayView["notToday"] }) {
  const [all, setAll] = useState(false);
  if (entries.length === 0) return null;

  const shown = all ? entries : entries.slice(0, NOT_TODAY_VISIBLE);
  const rest = entries.length - shown.length;

  return (
    <section className="v2-side-block" aria-labelledby="v2-not-today">
      <h2 className="v2-sub" id="v2-not-today">
        {TODAY_COPY.notTodayHeading}
      </h2>
      {shown.map((entry, index) => (
        <ListRow
          key={`${entry.full}-${index}`}
          entry={entry}
          identity={null}
          meta={entry.reason}
        />
      ))}
      {rest > 0 && (
        <button type="button" className="v2-more" onClick={() => setAll(true)}>
          {showMoreLabel(rest)}
        </button>
      )}
    </section>
  );
}
