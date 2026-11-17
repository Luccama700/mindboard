"use client";

import { TODAY_COPY } from "@/app/lib/v2/view/today";
// Type only, so none of the source that built this day (and none of the schema
// it parsed its rules with) reaches the browser bundle: the server builds the
// data and hands the plain shape down.
import type { TodayScreenData } from "@/app/lib/v2/view/screen-data";
import { AllDayRow } from "../_components/all-day-row";
import { CalendarPane } from "../_components/calendar/calendar-pane";
import { DayHeader } from "../_components/day-header";
import { DayLine } from "../_components/day-line";
import { DayProvider, useDay } from "../_components/day-provider";
import { EnergyRow } from "../_components/energy-row";
import { FeedStrip } from "../_components/feed-strip";
import { LaneSummary } from "../_components/lane-summary";
import { NavBar } from "../_components/nav-bar";
import { NotTodayList } from "../_components/not-today-list";
import { PastDueList } from "../_components/past-due-list";

/**
 * The Today screen, on whatever built the day it was handed.
 *
 * THE DAY ITSELF LIVES IN `DayProvider` (../_components/day-provider.tsx): the
 * plan, the replans each press runs, the view, the planned chips and the status
 * sentence. It was lifted out of this component unchanged, so the panes of the
 * desk read the very same day; this component is the provider around the same
 * markup it always drew.
 *
 * ONE DOCUMENT, EVERY LAYOUT. The order below is rail, main, side, and then the
 * calendar, which is the reading and tab order on desktop. Below 1024px the wrappers go
 * `display: contents` and the leaves are ordered back into the phone's own
 * sequence by the stylesheet (header, all day, energy, status, the line, what
 * did not fit), so the phone screen is unchanged and there is only ever one copy
 * of every control. From 1024px up the stylesheet decides how many columns the
 * side becomes, from the width of the window and whether the calendar is beside
 * it: one, then two from 1360px; from 1760px three without a calendar, and one
 * again beside the calendar, which takes the room.
 *
 * ONE DAY PER MOUNT. The page keys this component on `data.input.date`, so the
 * provider inside it always plans the day the header names; `keep` is what the
 * page asks the calendar's week links to carry back (see CalendarPane).
 */
export function TodayClient({
  data,
  keep,
}: {
  data: TodayScreenData;
  keep?: Readonly<Record<string, string>>;
}) {
  return (
    <DayProvider data={data}>
      <TodayLayout keep={keep} />
    </DayProvider>
  );
}

function TodayLayout({ keep }: { keep?: Readonly<Record<string, string>> }) {
  const {
    data,
    view,
    clock,
    energy,
    said,
    revision,
    focusToken,
    movedIds,
    planned,
    onStart,
    onDone,
    onSkip,
    onEnergy,
  } = useDay();

  return (
    <div className="v2-shell">
      <NavBar current="/v2/today" />

      <div className="v2-main">
        <DayHeader dateLabel={view.dateLabel} notice={view.notice} feed={view.feed} />

        <div className="v2-day">
          {view.empty ? (
            <p className="v2-empty">{TODAY_COPY.empty}</p>
          ) : (
            <>
              <DayLine
                stops={view.stops}
                litStopId={view.litStopId}
                clock={clock}
                movedIds={movedIds}
                revision={revision}
                focusToken={focusToken}
                onStart={onStart}
                onDone={onDone}
                onSkip={onSkip}
              />
              {view.litStopId === null && (
                <p className="v2-empty">{TODAY_COPY.dayOver}</p>
              )}
            </>
          )}
        </div>
      </div>

      {/* The day's context. The two inner wrappers are nothing at all on the
          phone and on a small desktop window. From 1360px each becomes a
          column of its own, and from 1760px each list does too, so the page
          fills the window with information instead of leaving it black. Not
          beside the calendar: there, from 1760px, the context is one column
          again and the calendar takes the room. */}
      <div className="v2-side">
        <div className="v2-status">
          <EnergyRow energy={view.energy} answered={energy} onPick={onEnergy} />

          {/* The screen's one live region. Pressing Start, Done or Not today
              unmounts the button that was pressed, so this sentence is the only
              confirmation a keyboard or screen reader user gets; between presses
              it falls back to the energy the plan ran on. */}
          <p className="v2-said" role="status">
            {said ?? view.energy.label}
          </p>

          <AllDayRow items={view.allDay} />
          <FeedStrip feed={view.feed} />
          <LaneSummary lanes={view.lanes} />
        </div>

        <div className="v2-lists">
          {/* Above what did not fit today, on every layout: an item whose date
              has gone by is a decision waiting, where a drop is only today's
              news. */}
          <PastDueList entries={view.pastDue} />
          <NotTodayList entries={view.notToday} />
        </div>
      </div>

      {/* The week beside the day, on the widest screens only (v2.css): below
          1760px it is in the document and not on the screen, because the
          calendar has a page of its own. LAST, so the reading order is rail,
          day, context, calendar. A source with no calendar draws no pane, and
          the frame keeps its three columns. It reads `data.calendar` from the
          data the page handed in (the provider passes it through as it is), so
          a week link that re-renders this page with a new `?week=` redraws the
          week and keeps every press above. */}
      {data.calendar !== null && (
        <CalendarPane data={data.calendar} planned={planned} basePath="/v2/today" keep={keep} />
      )}
    </div>
  );
}
