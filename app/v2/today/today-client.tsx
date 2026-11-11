"use client";

import { useCallback, useMemo, useState } from "react";

import { planReference } from "@/app/lib/v2/plan/day";
import { planDay } from "@/app/lib/v2/plan/planner";
import type { PlannedBlock } from "@/app/lib/v2/view/calendar";
import { clockLabel } from "@/app/lib/v2/view/format";
import { TODAY_COPY, actionLine, buildTodayView } from "@/app/lib/v2/view/today";
// Type only, so none of the source that built this day (and none of the schema
// it parsed its rules with) reaches the browser bundle: the server builds the
// data and hands the plain shape down.
import type { TodayScreenData } from "@/app/lib/v2/view/screen-data";
import type { Block, Energy, PlanOutput } from "@/app/lib/v2/types";
import { AllDayRow } from "../_components/all-day-row";
import { CalendarPane } from "../_components/calendar/calendar-pane";
import { DayHeader } from "../_components/day-header";
import { DayLine } from "../_components/day-line";
import { EnergyRow } from "../_components/energy-row";
import { FeedStrip } from "../_components/feed-strip";
import { LaneSummary } from "../_components/lane-summary";
import { NavBar } from "../_components/nav-bar";
import { NotTodayList } from "../_components/not-today-list";
import { PastDueList } from "../_components/past-due-list";

interface DayState {
  /** What the user has said. null until they say. */
  energy: Energy | null;
  plan: PlanOutput;
  /**
   * How many replans deep we are. It is what lets a block that moves twice
   * flash twice: a CSS animation does not restart on its own, so the number
   * keys the node that carries it.
   */
  revision: number;
  /**
   * How many of those replans came from a press that unmounted its own button.
   * The lit card takes focus when this changes, and only then, so answering the
   * energy question does not drag focus off the control being used.
   */
  focusToken: number;
  /** What just happened, for the status line. null falls back to the energy. */
  said: string | null;
}

/**
 * The Today screen, on whatever built the day it was handed.
 *
 * THE PLANNER IS THE ONE RUNNING HERE. Start, Done, Not today and the energy
 * options do not edit the screen: they set a block's state (or the energy) and
 * call `planDay` again with the current blocks as `existing`, exactly as the
 * server will. So the day a reviewer sees after pressing something is what the
 * real planner decided, replan rules and all: a block whose moment has passed is
 * held, a skipped task leaves the ranking and lets the next one in, and a stop
 * that moved animates to its new place.
 *
 * `now` never moves: it is whatever instant the source put in the input, which
 * is what makes the first render deterministic (the server and the browser plan
 * the same day) and a screenshot reproducible.
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
 * state below always plans the day the header names; `keep` is what the page
 * asks the calendar's week links to carry back (see CalendarPane).
 */
export function TodayClient({
  data,
  keep,
}: {
  data: TodayScreenData;
  keep?: Readonly<Record<string, string>>;
}) {
  const { input } = data;

  const [state, setState] = useState<DayState>(() => ({
    energy: input.energy,
    plan: planDay(input),
    revision: 0,
    focusToken: 0,
    said: null,
  }));

  const replan = useCallback(
    (energy: Energy | null, existing: Block[]): PlanOutput =>
      planDay({ ...input, energy, existing }),
    [input],
  );

  /**
   * The instant "past its date" is judged from: the later of the clock and the
   * start of the planned day's window.
   *
   * It is the planner's own reference, taken from the one function both call
   * the screen has to use the same one. Before wake the two differ: at 05:00 the
   * planner already ranks an item due at 06:00 as overdue, and a screen reading
   * the clock put that item in "Did not fit today" while its lane line said
   * "next". The same split appeared for a day being viewed ahead of time.
   */
  const reference = useMemo(
    () => planReference(input.now, input.date, input.rules).instant,
    [input.now, input.date, input.rules],
  );

  const viewFor = useCallback(
    (energy: Energy | null, plan: PlanOutput) =>
      buildTodayView({
        date: input.date,
        now: input.now,
        reference,
        timeZone: input.rules.timeZone,
        plan,
        fixed: input.fixed,
        lanes: data.lanes,
        candidates: input.candidates,
        feeds: data.feeds,
        feedLabels: data.feedLabels,
        openAsks: data.openAsks,
        tags: data.tags,
        notice: data.notice,
        energy,
      }),
    [input, data, reference],
  );

  // The status line is composed here rather than in the render, because it is
  // about a transition: what the press did, and what the planner lit instead.
  // Both titles are read off the view, so they are the words on the screen
  // rather than the planner's raw ones.
  const setBlockState = useCallback(
    (blockId: string, next: "started" | "done" | "skipped") => {
      setState((prev) => {
        const existing = prev.plan.blocks.map((block) =>
          block.id === blockId ? { ...block, state: next } : block,
        );
        const plan = replan(prev.energy, existing);
        const after = viewFor(prev.energy, plan);
        const pressed = after.stops.find((stop) => stop.id === blockId);
        const lit = after.stops.find((stop) => stop.id === after.litStopId);
        return {
          energy: prev.energy,
          plan,
          revision: prev.revision + 1,
          focusToken: prev.focusToken + 1,
          said:
            pressed === undefined
              ? null
              : actionLine(next, pressed.title, lit?.title ?? null),
        };
      });
    },
    [replan, viewFor],
  );

  const onStart = useCallback(
    (blockId: string) => setBlockState(blockId, "started"),
    [setBlockState],
  );
  const onDone = useCallback(
    (blockId: string) => setBlockState(blockId, "done"),
    [setBlockState],
  );
  const onSkip = useCallback(
    (blockId: string) => setBlockState(blockId, "skipped"),
    [setBlockState],
  );
  // The energy buttons are not unmounted by their own press, so focus stays
  // where the user put it and the token does not move. The status line falls
  // back to the energy label, which is the confirmation for this press.
  const onEnergy = useCallback(
    (energy: Energy) =>
      setState((prev) => ({
        energy,
        plan: replan(energy, prev.plan.blocks),
        revision: prev.revision + 1,
        focusToken: prev.focusToken,
        said: null,
      })),
    [replan],
  );

  const movedIds = useMemo(
    () => new Set(state.plan.moved.map((entry) => entry.blockId)),
    [state.plan.moved],
  );

  const view = useMemo(
    () => viewFor(state.energy, state.plan),
    [viewFor, state.energy, state.plan],
  );

  // What the calendar draws as planned: the blocks of the plan on screen that
  // are not done or skipped, under the titles the line shows for them. Derived
  // in the render, never kept, so a press or an energy answer moves the chips
  // in the same render that moves the line. The instants come from the plan and
  // the words from the view, because the view is what names a block.
  const planned = useMemo<PlannedBlock[]>(() => {
    const titles = new Map(
      view.stops
        .filter((stop) => stop.source === "block")
        .map((stop) => [stop.id, stop.title] as const),
    );
    return state.plan.blocks
      .filter((block) => block.state !== "done" && block.state !== "skipped")
      .map((block) => ({
        id: block.id,
        // Never reached: buildTodayView makes a stop for every block of this
        // same plan. It is here because Map.get cannot say so to the types.
        title: titles.get(block.id) ?? block.title,
        start: block.start,
        end: block.end,
      }));
  }, [state.plan.blocks, view.stops]);

  const clock = clockLabel(input.now, input.rules.timeZone);

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
                revision={state.revision}
                focusToken={state.focusToken}
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
          <EnergyRow energy={view.energy} answered={state.energy} onPick={onEnergy} />

          {/* The screen's one live region. Pressing Start, Done or Not today
              unmounts the button that was pressed, so this sentence is the only
              confirmation a keyboard or screen reader user gets; between presses
              it falls back to the energy the plan ran on. */}
          <p className="v2-said" role="status">
            {state.said ?? view.energy.label}
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
          the frame keeps its three columns. It reads `data.calendar` straight
          from the props, so a week link that re-renders this page with a new
          `?week=` redraws the week and keeps every press above. */}
      {data.calendar !== null && (
        <CalendarPane data={data.calendar} planned={planned} basePath="/v2/today" keep={keep} />
      )}
    </div>
  );
}
