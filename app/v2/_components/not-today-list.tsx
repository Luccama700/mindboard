"use client";

import { TODAY_COPY, type TodayView } from "@/app/lib/v2/view/today";

/**
 * What the planner wanted to do and did not, with the reason in words. It is a
 * statement, not a queue: there is nothing to press, because the way to change
 * it is to change the day.
 */
export function NotTodayList({ entries }: { entries: TodayView["notToday"] }) {
  if (entries.length === 0) return null;

  return (
    <section aria-labelledby="v2-not-today">
      <h2 className="v2-sub" id="v2-not-today">
        {TODAY_COPY.notTodayHeading}
      </h2>
      {entries.map((entry, index) => (
        <div className="v2-row" key={`${entry.title}-${index}`}>
          <b>{entry.title}</b>
          <span>{entry.reason}</span>
        </div>
      ))}
    </section>
  );
}
