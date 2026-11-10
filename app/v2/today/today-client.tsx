"use client";

import { useCallback, useMemo, useState } from "react";

import { planDay } from "@/app/lib/v2/plan/planner";
import { clockLabel } from "@/app/lib/v2/view/format";
import { TODAY_COPY, actionLine, buildTodayView } from "@/app/lib/v2/view/today";
// Type only, so none of the source that built this day (and none of the schema
// it parsed its rules with) reaches the browser bundle: the server builds the
// data and hands the plain shape down.
import type { TodayScreenData } from "@/app/lib/v2/view/screen-data";
import type { Block, Energy, PlanOutput } from "@/app/lib/v2/types";
import { AllDayRow } from "../_components/all-day-row";
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
 * ONE DOCUMENT, TWO LAYOUTS. The order below is rail, main, side, which is the
 * reading and tab order on desktop. Below 1024px the two wrappers go
 * `display: contents` and the leaves are ordered back into the phone's own
 * sequence by the stylesheet (header, all day, energy, status, the line, what
 * did not fit), so the phone screen is unchanged and there is only ever one copy
 * of every control.
 */
export function TodayClient({ data }: { data: TodayScreenData }) {
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

  const viewFor = useCallback(
    (energy: Energy | null, plan: PlanOutput) =>
      buildTodayView({
        date: input.date,
        now: input.now,
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
    [input, data],
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

  const clock = clockLabel(input.now, input.rules.timeZone);

  return (
    <div className="v2-shell">
      <NavBar />

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

      <div className="v2-side">
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
        {/* Above what did not fit today, on both layouts: an item whose date has
            gone by is a decision waiting, where a drop is only today's news. */}
        <PastDueList entries={view.pastDue} />
        <NotTodayList entries={view.notToday} />
      </div>
    </div>
  );
}
