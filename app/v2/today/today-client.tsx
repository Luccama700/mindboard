"use client";

import { useCallback, useMemo, useState } from "react";

import { planDay } from "@/app/lib/v2/plan/planner";
import { clockLabel } from "@/app/lib/v2/view/format";
import { TODAY_COPY, buildTodayView, droppedTitles } from "@/app/lib/v2/view/today";
import type {
  Ask,
  Block,
  BlockState,
  Energy,
  FeedStatus,
  LaneKey,
  PlanInput,
  PlanOutput,
} from "@/app/lib/v2/types";
import { DayHeader } from "../_components/day-header";
import { DayLine } from "../_components/day-line";
import { EnergyRow } from "../_components/energy-row";
import { NavBar } from "../_components/nav-bar";
import { NotTodayList } from "../_components/not-today-list";

/**
 * The sample day, as plain data. The page builds it on the server (building it
 * parses the rules, which costs a schema the browser has no use for) and hands
 * it down; everything from here on is the real engine running in the browser.
 */
export interface TodaySample {
  input: PlanInput;
  lanes: Array<{ key: LaneKey; label: string; color: string }>;
  feeds: FeedStatus[];
  feedLabels: Record<string, string>;
  openAsks: Ask[];
}

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
export function TodayClient({ sample }: { sample: TodaySample }) {
  const { input } = sample;

  const [state, setState] = useState<DayState>(() => ({
    energy: input.energy,
    plan: planDay(input),
    revision: 0,
  }));

  const replan = useCallback(
    (energy: Energy | null, existing: Block[]): PlanOutput =>
      planDay({ ...input, energy, existing }),
    [input],
  );

  const setBlockState = useCallback(
    (blockId: string, next: BlockState) => {
      setState((prev) => {
        const existing = prev.plan.blocks.map((block) =>
          block.id === blockId ? { ...block, state: next } : block,
        );
        return {
          energy: prev.energy,
          plan: replan(prev.energy, existing),
          revision: prev.revision + 1,
        };
      });
    },
    [replan],
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
  const onEnergy = useCallback(
    (energy: Energy) =>
      setState((prev) => ({
        energy,
        plan: replan(energy, prev.plan.blocks),
        revision: prev.revision + 1,
      })),
    [replan],
  );

  const titles = useMemo(() => droppedTitles(input.candidates), [input.candidates]);

  const movedIds = useMemo(
    () => new Set(state.plan.moved.map((entry) => entry.blockId)),
    [state.plan.moved],
  );

  const view = useMemo(
    () =>
      buildTodayView({
        date: input.date,
        now: input.now,
        timeZone: input.rules.timeZone,
        plan: state.plan,
        fixed: input.fixed,
        lanes: sample.lanes,
        feeds: sample.feeds,
        feedLabels: sample.feedLabels,
        openAsks: sample.openAsks,
        energy: state.energy,
        titles,
      }),
    [input, sample, state, titles],
  );

  const clock = clockLabel(input.now, input.rules.timeZone);

  return (
    <div className="v2-phone">
      <DayHeader dateLabel={view.dateLabel} feed={view.feed} allDay={view.allDay} />
      <EnergyRow energy={view.energy} answered={state.energy} onPick={onEnergy} />

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
