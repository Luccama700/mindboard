"use client";

import Link from "next/link";
import { useId, useMemo, type CSSProperties } from "react";

import {
  CALENDAR_COPY,
  buildCalendarView,
  type PlannedBlock,
} from "@/app/lib/v2/view/calendar";
import type { DateKey } from "@/app/lib/v2/types";
import type { CalendarScreenData } from "@/app/lib/v2/view/screen-data";
import { useAppearance } from "../appearance-root";
import { CalendarAgenda } from "./calendar-agenda";
import { calendarIdentity } from "./calendar-chip";
import { CalendarGrid } from "./calendar-grid";

/**
 * One week of calendar, read only: beside Today on a wide screen, and the whole
 * of the Week page.
 *
 * IT IS DRAWN FROM LIVE PROPS, NEVER FROM STATE. The view is rebuilt whenever
 * the data or the planned blocks change, so a week link that re-renders the
 * page with a new `?week=` shows the new week in place, and a press on Today
 * that replans the day moves the planned chips in the same render.
 *
 * SIZED BY ITS OWN WIDTH. The pane is a container (see calendar.css): under
 * 480px of its own width it is an agenda, from 480px a grid of the near days,
 * from 760px all seven. Both layouts are rendered and the stylesheet shows one;
 * the other is display: none, so it is out of the tab order and out of the
 * accessibility tree. No script measures anything.
 *
 * THE ONLY CONTROLS ARE THE WEEK LINKS, and each is there only when the view has
 * that week. They are `next/link`, which renders a plain anchor that works with
 * no script at all, and `scroll={false}` keeps the page where it is: on Today a
 * week change must not throw the day's column back to the top. A soft
 * navigation that changes only the search parameters keeps the page's client
 * state (Next 16 keys a page's state on its path, not its query), so the day's
 * presses survive it.
 *
 * A LINK KEEPS WHAT THE PAGE WAS GIVEN. Each one carries `keep` after the week:
 * a link that dropped Today's `date` sent the page back to planning the clock's
 * day, beside a screen still holding the plan of the other one.
 */
export function CalendarPane({
  data,
  planned,
  basePath,
  keep,
  headingLevel = 2,
}: {
  data: CalendarScreenData;
  /** Today's planned blocks, from the plan the screen is showing right now. */
  planned: readonly PlannedBlock[];
  /** The path the week links point at: "/v2/today" or "/v2/week". */
  basePath: string;
  /** The page's other search parameters, carried on every week link after `week`. */
  keep?: Readonly<Record<string, string>>;
  /** The title's level: 2 on Today and Week, 3 inside a frame of the desk, whose title is the h2. */
  headingLevel?: 2 | 3;
}) {
  const Heading = headingLevel === 3 ? "h3" : "h2";
  const view = useMemo(() => buildCalendarView(data, planned), [data, planned]);
  const { tokens } = useAppearance();
  const headingId = useId();

  // URLSearchParams encodes every name and value, so a kept value with an `&`,
  // a `#` or a space in it comes back to the page exactly as it went out.
  const hrefOf = (monday: DateKey) => {
    const query = new URLSearchParams([["week", monday], ...Object.entries(keep ?? {})]);
    return `${basePath}?${query.toString()}`;
  };

  const link = (monday: DateKey | null, label: string, slot: string) =>
    monday === null ? null : (
      // No prefetch: on a still page these links were the only requests it
      // made, one per week, every time it was drawn.
      <Link className={`v2-cal-link v2-cal-${slot}`} href={hrefOf(monday)} scroll={false} prefetch={false}>
        {label}
      </Link>
    );

  return (
    <section className="v2-cal" aria-labelledby={headingId}>
      <header className="v2-cal-head">
        <div className="v2-cal-titles">
          {/* The two places the eye should land are this label and today's
              column. "Calendar" is the quiet word above it, and both are the
              heading, so the section is named by both. */}
          <Heading id={headingId} className="v2-cal-title">
            <span className="v2-cal-name">{CALENDAR_COPY.heading}</span>{" "}
            <span className="v2-cal-week">{view.weekLabel}</span>
          </Heading>
          {/* About the calendar only: planned blocks may still be drawn. */}
          {view.empty && <p className="v2-cal-nothing">{CALENDAR_COPY.nothing}</p>}
        </div>

        <div className="v2-cal-links">
          {link(view.prevWeek, CALENDAR_COPY.previous, "prev")}
          {link(view.thisWeek, CALENDAR_COPY.thisWeek, "this")}
          {link(view.nextWeek, CALENDAR_COPY.next, "next")}
        </div>

        <div className="v2-cal-meta">
          {view.legend.length > 0 && (
            <ul className="v2-cal-legend" role="list">
              {view.legend.map((entry) => (
                <li
                  key={entry.id}
                  style={calendarIdentity(entry.color, tokens) as CSSProperties}
                >
                  {entry.label}
                </li>
              ))}
            </ul>
          )}
          <p className="v2-cal-note">{CALENDAR_COPY.readOnly}</p>
        </div>
      </header>

      <CalendarAgenda view={view} />
      <CalendarGrid view={view} />
    </section>
  );
}
