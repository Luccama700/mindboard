"use client";

import { TODAY_COPY, type TodayView } from "@/app/lib/v2/view/today";

/**
 * One dot per feed, so a glance says how many are answering. Each dot carries
 * its own name and state as text, because colour alone is not a message.
 */
export function FeedDots({ dots }: { dots: TodayView["feed"]["dots"] }) {
  // An account with no feeds connected drew an empty rounded pill where the dots
  // would be, in the header and in the side column both. Nothing to show is not
  // a thing to show: the sentence beside it already says nothing is watched.
  if (dots.length === 0) return null;

  return (
    <div className="v2-feeds" role="group" aria-label={TODAY_COPY.feeds}>
      {dots.map((dot, index) => {
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
  );
}

/**
 * The desktop side column's copy of the feed line: the sentence, then the dots
 * under it. On the phone the same two things sit in the header instead (see
 * day-header.tsx), and each copy is hidden at the other's width.
 */
export function FeedStrip({ feed }: { feed: TodayView["feed"] }) {
  return (
    <section className="v2-side-block v2-desk-only" aria-label={TODAY_COPY.feeds}>
      <p className="v2-side-line">{feed.line}</p>
      <FeedDots dots={feed.dots} />
    </section>
  );
}
