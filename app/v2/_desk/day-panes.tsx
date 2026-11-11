"use client";

import { CALENDAR_COPY } from "@/app/lib/v2/view/calendar";
import { DESK_COPY } from "@/app/lib/v2/view/desk";
import { TODAY_COPY } from "@/app/lib/v2/view/today";
import { AllDayRow } from "../_components/all-day-row";
import { CalendarPane } from "../_components/calendar/calendar-pane";
import { DayHeader } from "../_components/day-header";
import { DayLine } from "../_components/day-line";
import { useDay } from "../_components/day-provider";
import { EnergyRow } from "../_components/energy-row";
import { FeedStrip } from "../_components/feed-strip";
import { LaneSummary } from "../_components/lane-summary";
import { NotTodayList } from "../_components/not-today-list";
import { PastDueList } from "../_components/past-due-list";
import { useDeskKeep, useDeskPath } from "./desk-data-provider";
import type { PaneBody } from "./pane-body";

// The five panes of the day. Each is a few lines over the day the DayProvider
// holds and the leaves Today already draws, none of them edited: the same
// components, handed the same values, so a pane and Today cannot come to say
// two things about one day.
//
// NONE OF THEM HOLDS A LIVE REGION. The page that mounts the panes owns the one
// `role="status"`; the status pane prints the same sentence as plain text.
//
// None takes an option yet, so each ignores its `options`.

/** The date, the notice, the energy answer and the line of the day. */
function TodayPane() {
  const {
    view,
    clock,
    energy,
    revision,
    focusToken,
    movedIds,
    onStart,
    onDone,
    onSkip,
    onEnergy,
  } = useDay();

  return (
    <div className="v2-pane-day">
      <DayHeader dateLabel={view.dateLabel} notice={view.notice} feed={view.feed} />
      <EnergyRow energy={view.energy} answered={energy} onPick={onEnergy} />
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
            {view.litStopId === null && <p className="v2-empty">{TODAY_COPY.dayOver}</p>}
          </>
        )}
      </div>
    </div>
  );
}

/** What the last press did, the all day row, the feeds and the lanes. */
function StatusPane() {
  const { view, said } = useDay();
  return (
    <div className="v2-pane-status">
      <p className="v2-said">{said ?? view.energy.label}</p>
      <AllDayRow items={view.allDay} />
      <FeedStrip feed={view.feed} />
      <LaneSummary lanes={view.lanes} />
    </div>
  );
}

// The two lists. On Today an empty list is simply not there, because its column
// goes with it; a pane stays on the desk, and a blank box reads as broken, so a
// list with nothing in it says so in one sentence. Inside a pane the pane's own
// scroller is the one tab stop, so the list's section takes none of its own.

function PastDuePane() {
  const { pastDue } = useDay().view;
  if (pastDue.length === 0) return <p className="v2-pane-note">{DESK_COPY.nothingPastDue}</p>;
  return <PastDueList entries={pastDue} tabStop={false} />;
}

function NotTodayPane() {
  const { notToday } = useDay().view;
  if (notToday.length === 0) return <p className="v2-pane-note">{DESK_COPY.allFitToday}</p>;
  return <NotTodayList entries={notToday} tabStop={false} />;
}

/**
 * The week, read only, with the day's planned blocks on it. Its links point at
 * the desk (or wherever the desk was mounted) and carry what the desk keeps, so
 * a week change redraws this pane and keeps every press on the day.
 */
function CalendarDayPane() {
  const { data, planned } = useDay();
  const keep = useDeskKeep();
  const basePath = useDeskPath();
  if (data.calendar === null) return <p className="v2-empty">{CALENDAR_COPY.noCalendar}</p>;
  return <CalendarPane data={data.calendar} planned={planned} basePath={basePath} keep={keep} />;
}

/** The day panes, by pane id. */
export const DAY_PANE_BODIES: Readonly<Record<string, PaneBody>> = {
  today: TodayPane,
  status: StatusPane,
  "past-due": PastDuePane,
  "not-today": NotTodayPane,
  calendar: CalendarDayPane,
};
