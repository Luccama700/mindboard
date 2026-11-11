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
export function NotTodayList({
  entries,
  tabStop = true,
}: {
  entries: TodayView["notToday"];
  /**
   * Whether the section is a tab stop of its own. False inside a pane of the
   * desk, whose scroller is already the one stop that scrolls it.
   */
  tabStop?: boolean;
}) {
  const [all, setAll] = useState(false);
  if (entries.length === 0) return null;

  const shown = all ? entries : entries.slice(0, NOT_TODAY_VISIBLE);
  const rest = entries.length - shown.length;

  return (
    // Focusable, because on a wide window this section is a column that scrolls
    // on its own and nothing on a row presses: until Show more exists there is
    // no stop inside it, and a keyboard could not reach it to scroll it.
    <section
      className="v2-side-block v2-list"
      aria-labelledby="v2-not-today"
      tabIndex={tabStop ? 0 : undefined}
    >
      <h2 className="v2-sub" id="v2-not-today">
        {TODAY_COPY.notTodayHeading}
      </h2>
      {/* Its own element so a very wide column can lay the rows two across. */}
      <div className="v2-list-rows">
        {shown.map((entry, index) => (
          <ListRow
            key={`${entry.full}-${index}`}
            entry={entry}
            identity={null}
            meta={entry.reason}
          />
        ))}
      </div>
      {rest > 0 && (
        <button type="button" className="v2-more" onClick={() => setAll(true)}>
          {showMoreLabel(rest)}
        </button>
      )}
    </section>
  );
}
