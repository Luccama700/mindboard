"use client";

import { CALENDAR_COPY, type PlannedBlock } from "@/app/lib/v2/view/calendar";
import type { CalendarScreenData } from "@/app/lib/v2/view/screen-data";
import { TODAY_COPY } from "@/app/lib/v2/view/today";
import { CalendarPane } from "../_components/calendar/calendar-pane";
import { NavBar } from "../_components/nav-bar";

/**
 * Nothing is planned on this page: the planner's blocks belong to the day, and
 * the day is Today's. One empty list, so the pane's view is not rebuilt for a
 * new empty one on every render.
 */
const NONE: readonly PlannedBlock[] = [];

/**
 * The Week page: the rail (or the phone's bar) and the calendar, filling the
 * rest of the window at every width (calendar.css, "the Week page").
 *
 * A source with no calendar at all gets one sentence saying so where the week
 * would be, rather than seven empty columns, which would read as seven free
 * days.
 *
 * The page's h1 is read, not seen: it names the page with the rail's own word
 * for it, so the heading order is h1, then the pane's h2, as on Today.
 *
 * WHAT THIS DATA IS comes first, as one quiet line: the source's own notice,
 * the same sentence Today shows under its date (a sample, or a local copy as of
 * a time). Above the pane rather than inside it, so the pane stays the one
 * component both pages draw.
 */
export function WeekClient({
  calendar,
  notice,
}: {
  calendar: CalendarScreenData | null;
  /** One plain sentence saying what this data is, or null. */
  notice: string | null;
}) {
  return (
    <div className="v2-week">
      <NavBar current="/v2/week" />
      <main className="v2-week-main">
        <h1 className="v2-hidden">{TODAY_COPY.nav.week}</h1>
        {notice !== null && <p className="v2-notice">{notice}</p>}
        {calendar === null ? (
          <p className="v2-empty">{CALENDAR_COPY.noCalendar}</p>
        ) : (
          <CalendarPane data={calendar} planned={NONE} basePath="/v2/week" />
        )}
      </main>
    </div>
  );
}
