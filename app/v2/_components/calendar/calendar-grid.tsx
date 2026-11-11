"use client";

import type { CSSProperties } from "react";

import { CALENDAR_COPY, type CalendarView } from "@/app/lib/v2/view/calendar";
import { useAppearance } from "../appearance-root";
import { CalendarChipItem, calendarIdentity } from "./calendar-chip";

/** One day track: never narrower than nothing, never widened by its content. */
const TRACK = "minmax(0, 1fr)";
/** A day the three day layout leaves out: its line stays, at no width. */
const NO_TRACK = "0px";

const yesNo = (value: boolean) => (value ? "yes" : "no");

/**
 * The week as a grid of hours: the pane's layout from 480px of its own width.
 *
 * ONE SCROLLER, ITS HEADER INSIDE IT. The weekday row and the all day row are
 * sticky at the top of the same element the hours scroll in, so they share its
 * width to the pixel and the columns line up without knowing how wide a
 * scrollbar is. The week label and the links sit above it, outside it.
 *
 * SEVEN COLUMN LINES IN BOTH GRID LAYOUTS. Every row of the grid is laid out on
 * the same tracks, handed to the stylesheet as two lists: all seven days, and
 * the near ones with the rest at no width. So an all day bar keeps the day
 * indices the view gave it in either layout, and the stylesheet only picks a
 * list. Which days are near is the view's word (`near`); a bar that touches no
 * near day is marked so the three day layout can drop it, which is read off the
 * same flags rather than measured.
 *
 * WHAT A SCREEN READER GETS is one list per day, named by the day's full label,
 * holding that day's all day events and its chips in order, and today's marked
 * as the current date. The weekday row, the all day bars and the hour labels
 * draw the same facts for the eye and are hidden from it. Each list says
 * `role="list"` out loud, because a list with its bullets styled away is no
 * longer a list to Safari's screen reader.
 */
export function CalendarGrid({ view }: { view: CalendarView }) {
  const { tokens } = useAppearance();
  const tracks = {
    "--v2-cal-all": view.days.map(() => TRACK).join(" "),
    "--v2-cal-near": view.days.map((day) => (day.near ? TRACK : NO_TRACK)).join(" "),
  } as CSSProperties;

  return (
    // Focusable so a keyboard can scroll it. It has no name of its own: the
    // section around it already carries the pane's, and a third copy of the
    // same name would only be announced again.
    <div className="v2-cal-grid" tabIndex={0} style={tracks}>
      <div className="v2-cal-top" aria-hidden="true">
        <div className="v2-cal-days">
          {view.days.map((day, index) => (
            <p
              key={day.date}
              className="v2-cal-day"
              data-near={yesNo(day.near)}
              data-today={day.isToday ? "" : undefined}
              style={{ gridColumn: index + 2 }}
            >
              <span>{day.weekday}</span> <b>{day.dayNumber}</b>
            </p>
          ))}
        </div>

        {view.allDayRows > 0 && (
          <div className="v2-cal-allday">
            <p
              className="v2-cal-allday-label"
              style={{ gridRow: `1 / span ${view.allDayRows}` }}
            >
              {CALENDAR_COPY.allDay}
            </p>
            {view.allDay.map((span) => (
              <p
                key={span.id}
                className="v2-cal-span"
                data-near={yesNo(
                  view.days.slice(span.firstIndex, span.lastIndex + 1).some((day) => day.near),
                )}
                data-before={span.continuesBefore ? "" : undefined}
                data-after={span.continuesAfter ? "" : undefined}
                title={span.title}
                style={
                  {
                    ...calendarIdentity(span.color, tokens),
                    gridColumn: `${span.firstIndex + 2} / ${span.lastIndex + 3}`,
                    gridRow: span.row + 1,
                  } as CSSProperties
                }
              >
                {span.title}
              </p>
            ))}
          </div>
        )}
      </div>

      <div className="v2-cal-canvas" style={{ "--v2-cal-rows": view.hours.length } as CSSProperties}>
        <div className="v2-cal-gutter" aria-hidden="true">
          {view.hours.map((hour) => (
            <span key={hour.label} style={{ "--v2-cal-at": hour.top } as CSSProperties}>
              {hour.label}
            </span>
          ))}
        </div>
        <div className="v2-cal-lines" aria-hidden="true">
          {view.hours.map((hour) => (
            <span key={hour.label} style={{ "--v2-cal-at": hour.top } as CSSProperties} />
          ))}
        </div>

        {view.days.map((day, index) => (
          <div
            key={day.date}
            className="v2-cal-col"
            data-near={yesNo(day.near)}
            data-covered={yesNo(day.covered)}
            data-today={day.isToday ? "" : undefined}
            // Both lines, always: this column is absolutely positioned, and
            // for such a child an end line left to "auto" is the grid's edge.
            style={{ gridColumn: `${index + 2} / ${index + 3}` }}
          >
            <div className="v2-cal-plane">
              <ul
                role="list"
                aria-label={day.label}
                aria-current={day.isToday ? "date" : undefined}
              >
                {day.covered ? (
                  <>
                    {day.allDay.map((title, at) => (
                      // Titles can repeat (two calendars, one holiday), so the
                      // place in the day's list is the key.
                      <li key={`all-day-${at}`} className="v2-hidden">
                        {title} {CALENDAR_COPY.allDay}
                      </li>
                    ))}
                    {day.chips.map((chip) => (
                      // A planned block and an event can share an id.
                      <CalendarChipItem key={`${chip.kind}:${chip.id}`} chip={chip} placed />
                    ))}
                  </>
                ) : (
                  <li className="v2-cal-unknown">{CALENDAR_COPY.notCovered}</li>
                )}
              </ul>
              {day.isToday && view.nowTop !== null && (
                <p
                  className="v2-cal-now"
                  style={{ "--v2-cal-at": view.nowTop } as CSSProperties}
                >
                  <span>
                    {CALENDAR_COPY.now} <time>{view.nowLabel}</time>
                  </span>
                </p>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
