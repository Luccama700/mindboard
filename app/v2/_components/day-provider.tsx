"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

import { planReference } from "@/app/lib/v2/plan/day";
import { planDay } from "@/app/lib/v2/plan/planner";
import type { PlannedBlock } from "@/app/lib/v2/view/calendar";
import { clockLabel } from "@/app/lib/v2/view/format";
import { actionLine, buildTodayView, type TodayView } from "@/app/lib/v2/view/today";
// Type only, so none of the source that built this day (and none of the schema
// it parsed its rules with) reaches the browser bundle: the server builds the
// data and hands the plain shape down.
import type { TodayScreenData } from "@/app/lib/v2/view/screen-data";
import type { Block, Energy, PlanOutput } from "@/app/lib/v2/types";

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

/** Everything a part of the day reads: the plan on screen, its view, and the four presses. */
export interface DayValue {
  /** What the page handed the provider, as it stands now. */
  data: TodayScreenData;
  view: TodayView;
  /** The source's clock, as HH:MM in the user's zone. */
  clock: string;
  /** What the user has said. null until they say. */
  energy: Energy | null;
  /** What the last press did, for the status line. null falls back to the energy's label. */
  said: string | null;
  revision: number;
  focusToken: number;
  /** Block ids the planner gave a new time in the replan that just happened. */
  movedIds: ReadonlySet<string>;
  /** What the calendar draws as planned. */
  planned: readonly PlannedBlock[];
  /** The plan on screen, for panes that read the planner's own numbers. */
  plan: PlanOutput;
  /** Tasks finished in this session: a block of the plan in state "done" that carries a task. */
  doneIds: ReadonlySet<string>;
  onStart(blockId: string): void;
  onDone(blockId: string): void;
  onSkip(blockId: string): void;
  onEnergy(energy: Energy): void;
}

const DayContext = createContext<DayValue | null>(null);

/**
 * The day, on whatever built the data it was handed, for every part of the
 * screen that shows it: Today's own columns, and each pane of the day on the
 * desk.
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
 * ONE DAY PER MOUNT. The state is seeded once, from the first `data`. Whoever
 * renders the provider keys it on `data.input.date`, so it always plans the day
 * the header names: new data for the same day (a week link's other calendar)
 * re-renders with every press kept, and another planned day starts again.
 *
 * NO LIVE REGION HERE. The page that mounts the provider owns the one
 * `role="status"`; a provider or a pane that held its own would make two.
 */
export function DayProvider({ data, children }: { data: TodayScreenData; children: ReactNode }) {
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

  // Derived from the plan in the render, never kept beside it, so the set
  // changes in the same render as the press that finished the task.
  const doneIds = useMemo(() => {
    const ids = new Set<string>();
    for (const block of state.plan.blocks) {
      if (block.state === "done" && block.taskId !== null) ids.add(block.taskId);
    }
    return ids;
  }, [state.plan.blocks]);

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

  const value = useMemo<DayValue>(
    () => ({
      data,
      view,
      clock,
      energy: state.energy,
      said: state.said,
      revision: state.revision,
      focusToken: state.focusToken,
      movedIds,
      planned,
      plan: state.plan,
      doneIds,
      onStart,
      onDone,
      onSkip,
      onEnergy,
    }),
    [data, view, clock, state, movedIds, planned, doneIds, onStart, onDone, onSkip, onEnergy],
  );

  return <DayContext.Provider value={value}>{children}</DayContext.Provider>;
}

/** The day this part of the screen sits in. Throws when there is no provider above it. */
export function useDay(): DayValue {
  const day = useContext(DayContext);
  if (day === null) {
    throw new Error(
      "useDay was called outside a DayProvider: a part of the day has to be rendered inside one.",
    );
  }
  return day;
}
