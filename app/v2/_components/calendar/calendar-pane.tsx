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
 */
export function CalendarPane({
  data,
  planned,
  basePath,
}: {
  data: CalendarScreenData;
  /** Today's planned blocks, from the plan the screen is showing right now. */
  planned: readonly PlannedBlock[];
  /** The path the week links point at: "/v2/today" or "/v2/week". */
  basePath: string;
}) {
  const view = useMemo(() => buildCalendarView(data, planned), [data, planned]);
  const { tokens } = useAppearance();
  const headingId = useId();

  const link = (monday: DateKey | null, label: string, slot: string) =>
    monday === null ? null : (
      <Link
        className={`v2-cal-link v2-cal-${slot}`}
        href={`${basePath}?week=${monday}`}
        scroll={false}
      >
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
          <h2 id={headingId} className="v2-cal-title">
            <span className="v2-cal-name">{CALENDAR_COPY.heading}</span>{" "}
            <span className="v2-cal-week">{view.weekLabel}</span>
          </h2>
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
            <ul className="v2-cal-legend">
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

      <CalendarAgenda view={view} headingId={headingId} />
      <CalendarGrid view={view} headingId={headingId} />
    </section>
  );
}
