"use client";

import { useCallback, useMemo, useState } from "react";

import { planDay } from "@/app/lib/v2/plan/planner";
import { clockLabel } from "@/app/lib/v2/view/format";
import {
  TODAY_COPY,
  actionLine,
  buildTodayView,
  droppedTitles,
} from "@/app/lib/v2/view/today";
// Type only, so none of the fixture (and none of the schema it parses its rules
// with) reaches the browser bundle: the server builds the sample and hands the
// plain data down.
import type { SampleDay } from "@/app/lib/v2/fixtures/sample-day";
import type { Block, Energy, PlanOutput } from "@/app/lib/v2/types";
import { DayHeader } from "../_components/day-header";
import { DayLine } from "../_components/day-line";
import { EnergyRow } from "../_components/energy-row";
import { NavBar } from "../_components/nav-bar";
import { NotTodayList } from "../_components/not-today-list";

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
 * The Today screen on the sample day.
 *
 * THE PLANNER IS THE ONE RUNNING HERE. Start, Done, Not today and the energy
 * options do not edit the screen: they set a block's state (or the energy) and
 * call `planDay` again with the current blocks as `existing`, exactly as the
 * server will. So the day a reviewer sees after pressing something is what the
 * real planner decided, replan rules and all: a block whose moment has passed is
 * held, a skipped task leaves the ranking and lets the next one in, and a stop
 * that moved animates to its new place.
 *
 * `now` never moves. It is the sample's fixed invented instant, which is what
 * makes the first render deterministic (the server and the browser plan the same
 * day) and what makes a screenshot reproducible.
 */
export function TodayClient({ sample }: { sample: SampleDay }) {
  const { input } = sample;

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

  const titles = useMemo(() => droppedTitles(input.candidates), [input.candidates]);

  const viewFor = useCallback(
    (energy: Energy | null, plan: PlanOutput) =>
      buildTodayView({
        date: input.date,
        now: input.now,
        timeZone: input.rules.timeZone,
        plan,
        fixed: input.fixed,
        lanes: sample.lanes,
        feeds: sample.feeds,
        feedLabels: sample.feedLabels,
        openAsks: sample.openAsks,
        energy,
        titles,
      }),
    [input, sample, titles],
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
    <div className="v2-phone">
      <DayHeader dateLabel={view.dateLabel} feed={view.feed} allDay={view.allDay} />
      <EnergyRow energy={view.energy} answered={state.energy} onPick={onEnergy} />

      {/* The screen's one live region. Pressing Start, Done or Not today
          unmounts the button that was pressed, so this sentence is the only
          confirmation a keyboard or screen reader user gets; between presses it
          falls back to the energy the plan ran on. */}
      <p className="v2-said" role="status">
        {state.said ?? view.energy.label}
      </p>

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
          {view.litStopId === null && <p className="v2-empty">{TODAY_COPY.dayOver}</p>}
        </>
      )}

      <NotTodayList entries={view.notToday} />
      <p className="v2-note">{TODAY_COPY.sampleNote}</p>
      <NavBar />
    </div>
  );
}
