"use client";

import { useId } from "react";

import { CALENDAR_COPY, type CalendarView } from "@/app/lib/v2/view/calendar";
import { CalendarChipItem } from "./calendar-chip";

/**
 * The week as seven lists, in order: the pane's layout under 480px of its own
 * width, where a grid of seven columns would be seven slivers.
 *
 * Each day is a visible heading and the list it names. Today's list is marked as
 * the current date and its heading wears the accent. A day the source cannot
 * speak for says so in its list and holds nothing else, and an empty covered
 * day is an empty list: the week's one "nothing on" sentence is in the pane's
 * header, not repeated seven times here. Each list says `role="list"` out loud,
 * because a list with its bullets styled away is no longer a list to Safari's
 * screen reader.
 */
export function CalendarAgenda({ view }: { view: CalendarView }) {
  const base = useId();

  return (
    // Focusable so a keyboard can scroll it. No name of its own: the section
    // around it carries the pane's, and its days are named by their headings.
    <div className="v2-cal-agenda" tabIndex={0}>
      {view.days.map((day) => {
        const id = `${base}-${day.date}`;
        return (
          <div key={day.date} className="v2-cal-aday" data-today={day.isToday ? "" : undefined}>
            <h3 id={id}>{day.label}</h3>
            <ul
              role="list"
              aria-labelledby={id}
              aria-current={day.isToday ? "date" : undefined}
            >
              {day.covered ? (
                <>
                  {day.allDay.map((title, at) => (
                    <li key={`all-day-${at}`} className="v2-cal-aitem">
                      <span>{title}</span> <span>{CALENDAR_COPY.allDay}</span>
                    </li>
                  ))}
                  {day.chips.map((chip) => (
                    <CalendarChipItem key={`${chip.kind}:${chip.id}`} chip={chip} placed={false} />
                  ))}
                </>
              ) : (
                <li className="v2-cal-unknown">{CALENDAR_COPY.notCovered}</li>
              )}
            </ul>
          </div>
        );
      })}
    </div>
  );
}
