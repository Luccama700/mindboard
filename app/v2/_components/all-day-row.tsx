"use client";

import { TODAY_COPY } from "@/app/lib/v2/view/today";

/**
 * Anything that is true all day: a closure, a holiday, a notice. Not stops, so
 * they are not on the line; chips, so they read as conditions on the day.
 *
 * On the phone this sits between the header and the energy control, as before.
 * On desktop it is in the side column with the rest of the day's context.
 */
export function AllDayRow({ items }: { items: string[] }) {
  if (items.length === 0) return null;

  return (
    <div className="v2-allday">
      <span className="v2-allday-label">{TODAY_COPY.allDay}</span>
      {/* Keyed by position as well as title: two all-day events can carry the
          same name (two calendars with the same holiday), and the title alone
          then gives React two children with one key. */}
      {items.map((title, index) => (
        <span className="v2-allday-chip" key={`${index}-${title}`}>
          {title}
        </span>
      ))}
    </div>
  );
}
