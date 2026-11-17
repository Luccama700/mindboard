"use client";

import { type TodayView } from "@/app/lib/v2/view/today";
import { AppearanceTrigger } from "./appearance-root";
import { FeedDots } from "./feed-strip";

/**
 * The day's name, what this data is, and (on the phone) what the watchdog can
 * see.
 *
 * The notice sits directly under the date because it is the one thing that says
 * whether what follows is real and whether pressing anything is kept. It is
 * plain text, not a banner: it is a statement, and there is nothing to dismiss.
 *
 * The feed sentence and its dots are rendered here for the phone and again in
 * the side column for desktop, each hidden at the other's width. Two copies of
 * a passive line is the price of one document order that reads rail, main, side
 * on desktop and still puts the feed pill beside the date on the phone.
 */
export function DayHeader({
  dateLabel,
  notice,
  feed,
  headingLevel = 1,
}: {
  dateLabel: string;
  notice: string | null;
  feed: TodayView["feed"];
  /** The date's level: the page's h1 on Today, 3 inside a frame of the desk, whose title is the h2. */
  headingLevel?: 1 | 3;
}) {
  const Heading = headingLevel === 3 ? "h3" : "h1";
  return (
    <header className="v2-top">
      <div className="v2-top-text">
        <Heading>{dateLabel}</Heading>
        {notice !== null && <p className="v2-notice">{notice}</p>}
        <p className="v2-feedline">{feed.line}</p>
      </div>
      <div className="v2-top-aside">
        <FeedDots dots={feed.dots} />
        <AppearanceTrigger variant="header" />
      </div>
    </header>
  );
}
