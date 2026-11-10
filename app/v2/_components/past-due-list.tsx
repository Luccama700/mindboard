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
 * The items whose date has already gone by.
 *
 * An account that has been running a while has open items from days or weeks
 * ago. Some are dead and some are still alive, and nothing here can tell which,
 * so the screen's whole job is to put them in one place and say so.
 *
 * NOTHING ON A ROW PRESSES. Deciding one of these is its own feature, and a row
 * that looked pressable, or a line that invited the user to say something, would
 * point at a control that does not exist. One statement, then the rows.
 *
 * Each row names the group or lane it belongs to, unlike a stop on the line: in
 * a flat list there is no dot on a rail to say which lane this is.
 */
export function PastDueList({ entries }: { entries: TodayView["pastDue"] }) {
  const [all, setAll] = useState(false);
  if (entries.length === 0) return null;

  const shown = all ? entries : entries.slice(0, NOT_TODAY_VISIBLE);
  const rest = entries.length - shown.length;

  return (
    <section className="v2-side-block" aria-labelledby="v2-past-due">
      <h2 className="v2-sub" id="v2-past-due">
        {TODAY_COPY.pastDueHeading}
      </h2>
      <p className="v2-side-line">{TODAY_COPY.pastDueLine}</p>
      {shown.map((entry) => (
        <ListRow
          key={entry.id}
          entry={entry}
          identity={entry.identity}
          meta={entry.date}
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
