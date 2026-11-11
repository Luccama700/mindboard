// PLAN-DESK Task 5, behaviours 1 to 3: the day's state, lifted out of the Today
// screen into a provider every pane of the day can read.
//
// WHAT IS PINNED HERE. That the provider is the planner Today already ran (the
// view, the planned chips, the clock and the status sentence come out exactly
// as the screen made them), that it is seeded once per planned day and keeps
// every press through new data for the same day, and that `doneIds` follows
// the plan in the very render that carries the press. That Today itself still
// draws what it drew is pinned by the existing suites, which pass unedited.
//
// JSX would need a .tsx file, hence createElement, as in the other v2 tests.

import {
  createElement,
  type Attributes,
  type ComponentType,
  type ReactElement,
  type ReactNode,
} from "react";

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";

import { sampleDay } from "@/app/lib/v2/fixtures/sample-day";
import { sampleWeek } from "@/app/lib/v2/fixtures/sample-week";
import { planReference } from "@/app/lib/v2/plan/day";
import { planDay } from "@/app/lib/v2/plan/planner";
import type { Block, Energy, PlanOutput } from "@/app/lib/v2/types";
import { clockLabel } from "@/app/lib/v2/view/format";
import type { TodayScreenData } from "@/app/lib/v2/view/screen-data";
import { TODAY_COPY, actionLine, buildTodayView, type TodayView } from "@/app/lib/v2/view/today";
import { DayProvider, useDay, type DayValue } from "@/app/v2/_components/day-provider";
import { TodayClient } from "@/app/v2/today/today-client";

afterEach(() => {
  cleanup();
});

/** The sample day is a Wednesday; this is the Thursday after it. Invented. */
const THURSDAY = "2026-04-16";

/** The view Today builds for one plan, through the same function it calls. */
function viewOf(data: TodayScreenData, energy: Energy | null, plan: PlanOutput): TodayView {
  const { input } = data;
  return buildTodayView({
    date: input.date,
    now: input.now,
    reference: planReference(input.now, input.date, input.rules).instant,
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
  });
}

/**
 * createElement for a component whose `children` prop is required: the
 * children go after the props, where react/no-children-prop wants them, and
 * the rest of the props are still checked against the component's own.
 */
function wrap<P extends { children: ReactNode }>(
  type: ComponentType<P>,
  props: Omit<P, "children"> & Attributes,
  ...children: ReactNode[]
): ReactElement {
  return createElement(type as ComponentType<Omit<P, "children">>, props, ...children);
}

/**
 * The day, as every render saw it. A probe reads the provider and hands each
 * render's value out, so a test can ask about one render rather than about
 * whatever the last one left behind.
 */
function mount(data: TodayScreenData) {
  const seen: DayValue[] = [];
  const Probe = (): ReactNode => {
    seen.push(useDay());
    return null;
  };
  const tree = (next: TodayScreenData) =>
    wrap(DayProvider, { key: next.input.date, data: next }, createElement(Probe));
  const rendered = render(tree(data));
  return {
    seen,
    now: () => seen[seen.length - 1],
    rerender: (next: TodayScreenData) => rendered.rerender(tree(next)),
  };
}

/** One press, through the provider's own handler, inside act. */
async function press(run: () => void) {
  await act(async () => {
    run();
  });
}

describe("the day provider is the planner Today ran", () => {
  test("plans the day it is handed, through the same functions", () => {
    const data = sampleDay();
    const { now } = mount(data);
    const plan = planDay(data.input);

    const day = now();
    expect(day.data).toBe(data);
    expect(day.plan).toEqual(plan);
    expect(day.view).toEqual(viewOf(data, data.input.energy, plan));
    expect(day.energy).toBe(data.input.energy);
    expect(day.said).toBeNull();
    expect(day.revision).toBe(0);
    expect(day.focusToken).toBe(0);
    expect(day.clock).toBe(clockLabel(data.input.now, data.input.rules.timeZone));
    expect([...day.movedIds]).toEqual(plan.moved.map((entry) => entry.blockId));
  });

  test("hands the calendar the blocks still to do, under the line's own titles", () => {
    const data = sampleDay();
    const { now } = mount(data);
    const plan = planDay(data.input);
    const view = viewOf(data, data.input.energy, plan);
    const titles = new Map(view.stops.map((stop) => [stop.id, stop.title] as const));

    const expected = plan.blocks
      .filter((block) => block.state !== "done" && block.state !== "skipped")
      .map((block) => ({
        id: block.id,
        title: titles.get(block.id),
        start: block.start,
        end: block.end,
      }));
    expect(expected.length).toBeGreaterThan(1);
    expect(now().planned).toEqual(expected);
  });

  test("replans on a press exactly as the screen did, and says what happened", async () => {
    const data = sampleDay();
    const { now } = mount(data);
    const first = planDay(data.input);
    const view = viewOf(data, data.input.energy, first);
    const litId = view.litStopId;
    expect(litId).not.toBeNull();

    await press(() => now().onSkip(litId as string));

    const existing: Block[] = first.blocks.map((block) =>
      block.id === litId ? { ...block, state: "skipped" } : block,
    );
    const after = planDay({ ...data.input, existing });
    const afterView = viewOf(data, data.input.energy, after);
    const pressed = afterView.stops.find((stop) => stop.id === litId);
    const lit = afterView.stops.find((stop) => stop.id === afterView.litStopId);

    expect(now().plan).toEqual(after);
    expect(now().view).toEqual(afterView);
    expect(now().said).toBe(actionLine("skipped", pressed?.title ?? "", lit?.title ?? null));
    expect(now().revision).toBe(1);
    expect(now().focusToken).toBe(1);
  });

  test("answers energy without moving focus, and falls back to its label", async () => {
    const data = sampleDay();
    const { now } = mount(data);
    const first = planDay(data.input);

    await press(() => now().onEnergy("low"));

    expect(now().energy).toBe("low");
    expect(now().plan).toEqual(planDay({ ...data.input, energy: "low", existing: first.blocks }));
    expect(now().said).toBeNull();
    expect(now().revision).toBe(1);
    expect(now().focusToken).toBe(0);
  });

  test("refuses to be read outside a provider, in a sentence that says so", () => {
    const Lost = (): ReactNode => {
      useDay();
      return null;
    };
    const quiet = console.error;
    console.error = () => {};
    try {
      expect(() => render(createElement(Lost))).toThrow(/outside a DayProvider/);
    } finally {
      console.error = quiet;
    }
  });
});

// Behaviour 1, from the screen's side: Today is the provider around the same
// markup, so a press on its real buttons still lands in its one live region.
describe("Today runs on the provider", () => {
  test("still speaks a press in its one live region", async () => {
    const data = sampleDay();
    const { container, getByRole } = render(createElement(TodayClient, { data }));
    const regions = container.querySelectorAll('[role="status"]');
    expect(regions).toHaveLength(1);
    expect(regions[0].textContent).toBe(viewOf(data, data.input.energy, planDay(data.input)).energy.label);

    await press(() => getByRole("button", { name: TODAY_COPY.notToday }).click());
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      TODAY_COPY.acted.skipped,
    );
  });
});

describe("the day is seeded once per planned day", () => {
  test("keeps every press when new data for the same day arrives", async () => {
    const data = sampleDay();
    const mounted = mount(data);
    const litId = mounted.now().view.litStopId as string;
    await press(() => mounted.now().onSkip(litId));
    const said = mounted.now().said;
    const plan = mounted.now().plan;
    expect(said).toContain(TODAY_COPY.acted.skipped);

    // What a week link does: the same day, with another week of calendar.
    const moved: TodayScreenData = { ...data, calendar: sampleWeek("2026-04-22") };
    mounted.rerender(moved);

    expect(mounted.now().data).toBe(moved);
    expect(mounted.now().said).toBe(said);
    expect(mounted.now().plan).toBe(plan);
    expect(mounted.now().revision).toBe(1);
  });

  test("starts afresh when the key names another planned day", async () => {
    const data = sampleDay();
    const mounted = mount(data);
    const litId = mounted.now().view.litStopId as string;
    await press(() => mounted.now().onSkip(litId));
    expect(mounted.now().said).not.toBeNull();

    const thursday: TodayScreenData = { ...data, input: { ...data.input, date: THURSDAY } };
    mounted.rerender(thursday);

    expect(mounted.now().said).toBeNull();
    expect(mounted.now().revision).toBe(0);
    expect(mounted.now().plan).toEqual(planDay(thursday.input));
  });
});

describe("doneIds", () => {
  /** What doneIds must be for one plan, by the definition in the brief. */
  const doneOf = (plan: PlanOutput) =>
    plan.blocks
      .filter((block) => block.state === "done" && block.taskId !== null)
      .map((block) => block.taskId)
      .sort();

  test("is empty before anything is done", () => {
    const { now } = mount(sampleDay());
    expect(doneOf(now().plan)).toEqual([]);
    expect([...now().doneIds]).toEqual([]);
  });

  test("holds a finished task's id in the very render that carries the press", async () => {
    const data = sampleDay();
    const mounted = mount(data);
    const plan = mounted.now().plan;
    const task = plan.blocks.find(
      (block) => block.taskId !== null && block.state === "planned",
    ) as Block;
    expect(task).toBeDefined();

    await press(() => mounted.now().onDone(task.id));

    expect([...mounted.now().doneIds]).toEqual([task.taskId]);
    // Every render's set agrees with that render's own plan: none of them
    // carried a plan with the block done and a set without it.
    for (const day of mounted.seen) {
      expect([...day.doneIds].sort()).toEqual(doneOf(day.plan));
    }
  });

  test("leaves out a block that carries no task, and one moved off today", async () => {
    const data = sampleDay();
    const mounted = mount(data);
    const plan = mounted.now().plan;
    const taskless = plan.blocks.find((block) => block.taskId === null);
    const tasked = plan.blocks.filter((block) => block.taskId !== null);
    expect(taskless).toBeDefined();
    expect(tasked.length).toBeGreaterThan(1);

    await press(() => mounted.now().onDone((taskless as Block).id));
    expect([...mounted.now().doneIds]).toEqual([]);

    await press(() => mounted.now().onSkip(tasked[0].id));
    expect([...mounted.now().doneIds]).toEqual(doneOf(mounted.now().plan));
    expect(mounted.now().doneIds.has(tasked[0].taskId as string)).toBe(false);
  });
});
