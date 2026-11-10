"use client";

import { TODAY_COPY, type TodayView } from "@/app/lib/v2/view/today";

/**
 * The day's name, what the watchdog can see, and anything that is true all day.
 * The feed sentence is the subtitle because it is already a sentence; the pill
 * is one dot per feed, so a glance says how many are answering.
 */
export function DayHeader({
  dateLabel,
  feed,
  allDay,
}: {
  dateLabel: string;
  feed: TodayView["feed"];
  allDay: string[];
}) {
  return (
    <>
      <header className="v2-top">
        <div>
          <h1>{dateLabel}</h1>
          <p>{feed.line}</p>
        </div>
        <div className="v2-feeds" role="group" aria-label={TODAY_COPY.feeds}>
          {feed.dots.map((dot, index) => {
            const name = `${dot.label}: ${TODAY_COPY.feedState[dot.state]}`;
            return (
              <span
                key={`${dot.label}-${index}`}
                className="v2-dot"
                data-state={dot.state}
                role="img"
                aria-label={name}
                title={name}
              />
            );
          })}
        </div>
      </header>

      {allDay.length > 0 && (
        <div className="v2-allday">
          <span className="v2-allday-label">{TODAY_COPY.allDay}</span>
          {allDay.map((title) => (
            <span className="v2-allday-chip" key={title}>
              {title}
            </span>
          ))}
        </div>
      )}
    </>
  );
}
