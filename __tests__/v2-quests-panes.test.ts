// PLAN-DESK Task 6: the four Quests panes.
//
// THE TWO RULES ABOVE EVERY OTHER ON THIS SCREEN. Quests reads exactly what
// Today reads: every number a pane prints is one the view model gave it, and
// each test below compares the markup with `buildQuestsView` on the same data
// rather than with numbers written here. And nothing is invented: a lane nothing
// feeds says nothing, a rate is shown only when the view gives one, and a step
// worked on today is marked, never removed and never struck, because pressing
// Done on a block of work does not finish the task.
//
// WHAT IS NOT PINNED HERE. How a pane LOOKS at 240, 464 and 1300 px: jsdom lays
// nothing out. The container thresholds are read off quests.css as text, and
// what they draw is the controller's capture.
//
// EVERYTHING HERE IS INVENTED: the sample desk, and the hand made variants below
// (side quests, a lane with only something finished, a short history). No title
// describes anybody.
//
// JSX would need a .tsx file, hence createElement, as in the other v2 tests.

import { readFileSync } from "node:fs";
import path from "node:path";
import {
  createElement,
  type Attributes,
  type ComponentType,
  type ReactElement,
  type ReactNode,
} from "react";

import postcss, { type AtRule, type Rule } from "postcss";
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { sampleInstant } from "@/app/lib/v2/fixtures/sample-base";
import { sampleDesk } from "@/app/lib/v2/fixtures/sample-desk";
import type { Candidate } from "@/app/lib/v2/types";
import { DEFAULT_APPEARANCE, identityTokens, tokensFor } from "@/app/lib/v2/view/appearance";
import { DESK_COPY, paneOptions } from "@/app/lib/v2/view/desk";
import type { DeskScreenData, QuestDone, QuestsScreenData } from "@/app/lib/v2/view/desk-data";
import {
  QUESTS_COPY,
  buildQuestsView,
  laneDueLabel,
  laneOpenLabel,
  questDoneTotalLabel,
  questPastLabel,
  questPerWeekLabel,
  questSpanLabel,
  questThroughLabel,
  type QuestSpan,
  type QuestsView,
} from "@/app/lib/v2/view/quests";
import type { TaskTag } from "@/app/lib/v2/view/screen-data";
import { TODAY_COPY } from "@/app/lib/v2/view/today";
import { DayProvider, useDay } from "@/app/v2/_components/day-provider";
import { QUEST_PANE_BODIES } from "@/app/v2/_components/quests/quest-panes";
import { DeskDataProvider } from "@/app/v2/_desk/desk-data-provider";
import { PaneBox } from "@/app/v2/_desk/pane-box";
import { paneBody } from "@/app/v2/_desk/pane-registry";

const ROOT = path.resolve(__dirname, "..");

const QUEST_IDS = ["lanes", "steps", "side-quests", "done"];
const NONE: ReadonlySet<string> = new Set<string>();
const at = sampleInstant;

afterEach(() => {
  cleanup();
});

/**
 * createElement for a component whose `children` prop is required: the
 * children go after the props, where react/no-children-prop wants them.
 */
function wrap<P extends { children: ReactNode }>(
  type: ComponentType<P>,
  props: Omit<P, "children"> & Attributes,
  ...children: ReactNode[]
): ReactElement {
  return createElement(type as ComponentType<Omit<P, "children">>, props, ...children);
}

/**
 * Panes in boxes, the way the desk draws them: the desk's data, the day keyed
 * on the planned day, one box per id. They share the providers, so a press in
 * the day's pane reaches the Quests panes in the same render. `extra` is drawn
 * inside the day too (a probe that reads the provider).
 */
function drawPanes(
  ids: string[],
  data: DeskScreenData = sampleDesk(null),
  options: Record<string, Record<string, string>> = {},
  extra: ReactNode[] = [],
) {
  const boxes = ids.map((id) =>
    wrap(
      PaneBox,
      { key: id, paneId: id, style: { width: 464, height: 600 } },
      createElement(paneBody(id), { options: options[id] ?? {} }),
    ),
  );
  return render(
    wrap(
      DeskDataProvider,
      { data },
      wrap(DayProvider, { key: data.today.input.date, data: data.today }, ...boxes, ...extra),
    ),
  );
}

/** The body's own root element inside the box of one pane. */
function rootIn(container: HTMLElement, id: string): HTMLElement {
  const scroller = container.querySelector(`.v2-pane[data-pane="${id}"] .v2-pane-body`);
  return scroller?.firstElementChild as HTMLElement;
}

/** One pane alone, answering its body's root. */
function drawPane(
  id: string,
  data: DeskScreenData = sampleDesk(null),
  options: Record<string, string> = {},
): HTMLElement {
  const { container } = drawPanes([id], data, { [id]: options });
  return rootIn(container, id);
}

const texts = (root: ParentNode, selector: string) =>
  Array.from(root.querySelectorAll(selector)).map((node) => node.textContent ?? "");

const questsOf = (desk: DeskScreenData) => desk.quests as QuestsScreenData;

/** The view a pane must have been drawn from. */
const viewOf = (desk: DeskScreenData, span: QuestSpan = 14, worked = NONE): QuestsView =>
  buildQuestsView(questsOf(desk), worked, span);

// ---------------------------------------------------------------- the desks

function candidate(over: Partial<Candidate> & { id: string }): Candidate {
  return {
    title: `Invented ${over.id}`,
    lane: null,
    kind: "step",
    due: null,
    hard: false,
    minutes: 50,
    energyCost: null,
    expiresAt: null,
    pinned: false,
    earlyTouchDone: false,
    ...over,
  };
}

/**
 * The sample desk with its candidates and tags replaced. The SAME input object
 * goes to the day and to the quests, as every real source hands them, so a
 * press on the day and the view read one list.
 */
function withCandidates(
  make: (candidates: Candidate[]) => Candidate[],
  tags?: Record<string, TaskTag>,
): DeskScreenData {
  const desk = sampleDesk(null);
  const input = { ...desk.today.input, candidates: make(desk.today.input.candidates) };
  const today = { ...desk.today, input, tags: tags ?? desk.today.tags };
  return { ...desk, today, quests: { ...questsOf(desk), input, tags: today.tags } };
}

/** The sample desk with its quests patched. */
function withQuests(patch: (quests: QuestsScreenData) => Partial<QuestsScreenData>): DeskScreenData {
  const desk = sampleDesk(null);
  return { ...desk, quests: { ...questsOf(desk), ...patch(questsOf(desk)) } };
}

/**
 * Three things with no lane, added in an order the planner does not keep: one
 * with no date, one past its date, and one with a group of its own.
 */
const SIDE_TAGS: Record<string, TaskTag> = {
  "t-x-fern": { label: "Balcony", color: "#4A9B6E" },
};
const withSide = () =>
  withCandidates(
    (candidates) => [
      ...candidates,
      candidate({ id: "t-x-shelf", title: "Oil the hallway shelf", kind: "side" }),
      candidate({ id: "t-x-chairs", title: "Return the folding chairs", due: at("12:00", "2026-04-11") }),
      candidate({
        id: "t-x-fern",
        title: "Repot the fern (the big one by the door)",
        kind: "side",
        due: at("18:00", "2026-04-16"),
      }),
    ],
    SIDE_TAGS,
  );

/** One finished thing in the lane nothing else feeds. */
const workFinished = (): QuestDone => ({
  id: "d-x-till",
  title: "Count the till float",
  lane: "work",
  tag: null,
  doneAt: at("09:00", "2026-04-13"),
});

const noQuests = (): DeskScreenData => ({ ...sampleDesk(null), quests: null });

/** True when `b` comes after `a` in document order. */
const follows = (a: Node, b: Node) =>
  (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

const press = async (button: HTMLElement) => {
  await act(async () => {
    fireEvent.click(button);
  });
};

// ---------------------------------------------------------------- behaviour 1

describe("the four bodies", () => {
  test("fill the quests map, and the registry answers them", () => {
    expect(Object.keys(QUEST_PANE_BODIES).sort()).toEqual([...QUEST_IDS].sort());
    for (const id of QUEST_IDS) {
      expect(paneBody(id), id).toBe(QUEST_PANE_BODIES[id]);
    }
  });

  test("say the desk's one sentence when the source cannot speak about quests", () => {
    for (const id of QUEST_IDS) {
      const root = drawPane(id, noQuests());
      expect(root.textContent, id).toBe(DESK_COPY.noQuests);
      expect(root.className, id).toBe("v2-pane-note");
      cleanup();
    }
  });
});

// ------------------------------------------------- behaviour 1: a press is work

describe("a step worked on today is marked, and stays where it was", () => {
  /** Reads the provider's own set, render by render. */
  function probe() {
    const seen: Array<ReadonlySet<string>> = [];
    const Probe = (): ReactNode => {
      seen.push(useDay().workedIds);
      return null;
    };
    return { seen, element: createElement(Probe, { key: "probe" }) };
  }

  test("a press on Today's lit card keeps every place, every count and Done lately", async () => {
    const watch = probe();
    const { container } = drawPanes(
      ["today", "lanes", "steps", "done"],
      sampleDesk(null),
      {},
      [watch.element],
    );
    const steps = () => rootIn(container, "steps");
    const lanes = () => rootIn(container, "lanes");
    const done = () => rootIn(container, "done");

    const rowTitles = () => texts(steps(), ".v2-quests-row .v2-quests-title");
    const laneMeta = () => texts(lanes(), ".v2-quests-lane-meta");
    const before = {
      rows: rowTitles(),
      meta: laneMeta(),
      lanes: texts(lanes(), ".v2-quests-lane-name"),
      done: done().textContent,
    };
    expect(steps().querySelector(".v2-quests-worked")).toBeNull();
    expect(lanes().querySelector(".v2-quests-worked")).toBeNull();

    // Only the lit stop has buttons, so there is one Done on the screen.
    const today = container.querySelector('.v2-pane[data-pane="today"]') as HTMLElement;
    await press(within(today).getByRole("button", { name: TODAY_COPY.done }));

    const worked = watch.seen.at(-1) as ReadonlySet<string>;
    expect(worked.size).toBeGreaterThan(0);
    const view = viewOf(sampleDesk(null), 14, worked);

    // Nothing moved, nothing left, no count changed, and Done lately is the
    // source's history, which a press never reaches.
    expect(rowTitles()).toEqual(before.rows);
    expect(laneMeta()).toEqual(before.meta);
    expect(texts(lanes(), ".v2-quests-lane-name")).toEqual(before.lanes);
    expect(done().textContent).toBe(before.done);

    // The worked step wears the phrase, and only it does.
    const rows = Array.from(steps().querySelectorAll<HTMLElement>(".v2-quests-row"));
    view.steps.forEach((item, index) => {
      const row = rows[index];
      expect(row.querySelector(".v2-quests-title")?.textContent).toBe(item.title);
      expect(row.hasAttribute("data-worked"), item.id).toBe(item.worked);
      expect(texts(row, ".v2-quests-worked"), item.id).toEqual(
        item.worked ? [QUESTS_COPY.worked] : [],
      );
      // Not struck through, not removed: no strike element at all.
      expect(row.querySelector("s, del, strike"), item.id).toBeNull();
    });
    expect(view.steps.some((item) => item.worked)).toBe(true);

    // A lane whose next stop was worked on still names it, and marks it.
    const laneRows = Array.from(lanes().querySelectorAll<HTMLElement>(".v2-quests-lane"));
    view.lanes.forEach((lane, index) => {
      const next = laneRows[index].querySelector(".v2-quests-next");
      if (lane.next === null) {
        expect(next, lane.key).toBeNull();
        return;
      }
      expect(next?.querySelector(".v2-quests-next-title")?.textContent, lane.key).toBe(
        lane.next.title,
      );
      expect(texts(next as Element, ".v2-quests-worked"), lane.key).toEqual(
        lane.next.worked ? [QUESTS_COPY.worked] : [],
      );
    });
    expect(view.lanes.some((lane) => lane.next?.worked === true)).toBe(true);
  });
});

// ---------------------------------------------------------------- behaviour 2

describe("lanes", () => {
  const laneRows = (root: HTMLElement) =>
    Array.from(root.querySelectorAll<HTMLElement>(".v2-quests-lane"));
  const tokens = tokensFor(DEFAULT_APPEARANCE);

  test("one row per lane, in the user's order, quiet ones included, each in its colour", () => {
    const desk = sampleDesk(null);
    const view = viewOf(desk);
    const root = drawPane("lanes", desk);
    const rows = laneRows(root);
    expect(rows.map((row) => row.querySelector(".v2-quests-lane-name")?.textContent)).toEqual(
      view.lanes.map((lane) => lane.label),
    );
    view.lanes.forEach((lane, index) => {
      expect(rows[index].style.getPropertyValue("--v2-lane"), lane.key).toBe(
        identityTokens(lane.color, tokens)["--v2-lane"],
      );
      expect(rows[index].style.getPropertyValue("--v2-ident"), lane.key).toBe(
        identityTokens(lane.color, tokens)["--v2-ident"],
      );
    });
  });

  test("an open lane: its count and next date in Today's words, and its next stop", () => {
    const desk = sampleDesk(null);
    const view = viewOf(desk);
    const rows = laneRows(drawPane("lanes", desk));
    let checked = 0;
    view.lanes.forEach((lane, index) => {
      if (lane.quiet) return;
      checked += 1;
      const row = rows[index];
      expect(row.querySelector(".v2-quests-lane-open")?.textContent).toBe(laneOpenLabel(lane.open));
      expect(row.querySelector(".v2-quests-lane-due")?.textContent ?? null).toBe(
        lane.due === null ? null : laneDueLabel(lane.due),
      );
      expect(row.querySelector(".v2-quests-lane-past")?.textContent ?? null).toBe(
        lane.past > 0 ? questPastLabel(lane.past) : null,
      );
      const next = row.querySelector(".v2-quests-next");
      expect(next?.querySelector(".v2-quests-next-title")?.textContent ?? null).toBe(
        lane.next?.title ?? null,
      );
      // The next stop wears its date's mark as a word, where the view has one.
      const word = lane.next === null ? "" : QUESTS_COPY.when[lane.next.when];
      expect(texts(next as Element, ".v2-quests-when")).toEqual(word === "" ? [] : [word]);
    });
    expect(checked).toBeGreaterThan(3);
    // The sample is not vacuous: one lane past a date, and marks that say so.
    const money = rows[view.lanes.findIndex((lane) => lane.key === "money")];
    expect(money.querySelector(".v2-quests-lane-past")?.textContent).toBe(questPastLabel(1));
    expect(texts(money, ".v2-quests-next .v2-quests-when")).toEqual([QUESTS_COPY.when.today]);
  });

  test("the count and the date come after the next stop, so a reader meets the stop first", () => {
    const rows = laneRows(drawPane("lanes"));
    for (const row of rows) {
      const next = row.querySelector(".v2-quests-next");
      const meta = row.querySelector(".v2-quests-lane-meta");
      if (next === null || meta === null) continue;
      expect(follows(row.querySelector(".v2-quests-lane-name") as Node, next)).toBe(true);
      expect(follows(next, meta)).toBe(true);
    }
  });

  test("a quiet lane is its name alone: no number, no date, no stop", () => {
    const desk = sampleDesk(null);
    const view = viewOf(desk);
    const quiet = view.lanes.filter((lane) => lane.quiet);
    expect(quiet.map((lane) => lane.key)).toEqual(["work"]);
    const rows = laneRows(drawPane("lanes", desk));
    view.lanes.forEach((lane, index) => {
      const row = rows[index];
      expect(row.hasAttribute("data-quiet"), lane.key).toBe(lane.quiet);
      if (!lane.quiet) return;
      expect(row.textContent).toBe(lane.label);
      expect(row.querySelector(".v2-quests-lane-meta")).toBeNull();
      expect(row.querySelector(".v2-quests-next")).toBeNull();
      expect(row.textContent).not.toMatch(/\d/);
    });
  });

  // No zeros: a lane with nothing open that finished something lately says how
  // many, in Done lately's words, and never "0 open".
  test("a lane with only something finished is not quiet, and says what it finished", () => {
    const second: QuestDone = { ...workFinished(), id: "d-x-float", doneAt: at("15:00", "2026-04-10") };
    const desk = withQuests((quests) => ({ done: [workFinished(), second, ...quests.done] }));
    const view = viewOf(desk);
    const work = view.lanes.find((lane) => lane.key === "work");
    expect(work).toMatchObject({ quiet: false, open: 0, next: null, done: 2 });
    const rows = laneRows(drawPane("lanes", desk));
    const row = rows[view.lanes.findIndex((lane) => lane.key === "work")];
    expect(row.hasAttribute("data-quiet")).toBe(false);
    expect(row.querySelector(".v2-quests-lane-open")).toBeNull();
    expect(row.querySelector(".v2-quests-lane-done")?.textContent).toBe(questDoneTotalLabel(2));
    expect(row.querySelector(".v2-quests-lane-due")).toBeNull();
    expect(row.querySelector(".v2-quests-lane-past")).toBeNull();
    expect(row.querySelector(".v2-quests-next")).toBeNull();
    expect(row.textContent?.replace(/\s+/g, " ")).toBe(`Work ${questDoneTotalLabel(2)}`);
  });

  test("a lane with only something finished, over a history too short to count it, is its name alone", () => {
    const desk = withQuests((quests) => ({ done: [workFinished(), ...quests.done], historyDays: 7 }));
    const view = viewOf(desk);
    const work = view.lanes.find((lane) => lane.key === "work");
    expect(work).toMatchObject({ quiet: false, open: 0, done: null });
    const rows = laneRows(drawPane("lanes", desk));
    const row = rows[view.lanes.findIndex((lane) => lane.key === "work")];
    expect(row.hasAttribute("data-quiet")).toBe(false);
    expect(row.querySelector(".v2-quests-lane-meta")).toBeNull();
    expect(row.textContent?.trim()).toBe("Work");
  });

  test("never prints a zero count, on any desk", () => {
    const desks = [
      sampleDesk(null),
      withSide(),
      withQuests((quests) => ({ done: [workFinished(), ...quests.done] })),
      withQuests((quests) => ({ done: [workFinished(), ...quests.done], historyDays: 7 })),
      withCandidates(() => []),
    ];
    for (const desk of desks) {
      const root = drawPane("lanes", desk);
      expect(root.textContent).not.toContain(laneOpenLabel(0));
      expect(root.textContent).not.toContain(questDoneTotalLabel(0));
      cleanup();
    }
  });

  test("says so when the user has no lanes", () => {
    const desk = withQuests(() => ({ lanes: [] }));
    const root = drawPane("lanes", desk);
    expect(root.textContent).toBe(QUESTS_COPY.noLanes);
  });
});

// ---------------------------------------------------------------- behaviour 3

describe("steps", () => {
  const rowsOf = (root: HTMLElement) =>
    Array.from(root.querySelectorAll<HTMLElement>(".v2-quests-row"));
  const filterOf = (root: HTMLElement) =>
    root.querySelector(`[role="group"][aria-label="${QUESTS_COPY.filterLabel}"]`) as HTMLElement | null;
  const chips = (root: HTMLElement) =>
    Array.from((filterOf(root) as HTMLElement).querySelectorAll<HTMLButtonElement>("button"));
  const pressedNames = (root: HTMLElement) =>
    chips(root)
      .filter((chip) => chip.getAttribute("aria-pressed") === "true")
      .map((chip) => chip.textContent);

  test("the open steps by rank, each with its title, detail, identity, date and mark", () => {
    const desk = sampleDesk(null);
    const view = viewOf(desk);
    const rows = rowsOf(drawPane("steps", desk));
    expect(rows).toHaveLength(view.steps.length);
    view.steps.forEach((item, index) => {
      const row = rows[index];
      expect(row.querySelector(".v2-quests-title")?.textContent).toBe(item.title);
      expect(row.querySelector(".v2-quests-detail")?.textContent ?? null).toBe(item.detail);
      expect(row.querySelector(".v2-quests-ident")?.textContent ?? null).toBe(
        item.identity?.label ?? null,
      );
      expect(row.querySelector(".v2-quests-date")?.textContent ?? null).toBe(item.due);
      expect(row.dataset.when).toBe(item.when);
      const word = QUESTS_COPY.when[item.when];
      expect(texts(row, ".v2-quests-when"), item.id).toEqual(word === "" ? [] : [word]);
    });
    // The sample has a step of each mark, so each is drawn as a word.
    const words = texts(drawPane("steps", desk), ".v2-quests-when");
    expect(new Set(words)).toEqual(
      new Set([QUESTS_COPY.when.past, QUESTS_COPY.when.today, QUESTS_COPY.when.soon]),
    );
  });

  test("a mark is a word with its kind on it, never a colour alone", () => {
    for (const mark of drawPane("steps").querySelectorAll<HTMLElement>(".v2-quests-when")) {
      expect(mark.textContent?.length).toBeGreaterThan(0);
      expect(["past", "today", "soon"]).toContain(mark.dataset.when);
    }
  });

  test("a filter by lane: All, then each lane that has steps, in the user's order", () => {
    const desk = sampleDesk(null);
    const view = viewOf(desk);
    const root = drawPane("steps", desk);
    const withSteps = view.lanes.filter((lane) =>
      view.steps.some((item) => item.lane === lane.key),
    );
    expect(withSteps.length).toBeGreaterThan(1);
    expect(chips(root).map((chip) => chip.textContent)).toEqual([
      QUESTS_COPY.filterAll,
      ...withSteps.map((lane) => lane.label),
    ]);
    // A lane nothing feeds has nothing to filter to.
    expect(chips(root).map((chip) => chip.textContent)).not.toContain("Work");
    expect(pressedNames(root)).toEqual([QUESTS_COPY.filterAll]);
    for (const chip of chips(root)) expect(chip.type).toBe("button");
  });

  test("pressing a lane shows only its steps, in the same order, and All shows them again", async () => {
    const desk = sampleDesk(null);
    const view = viewOf(desk);
    const root = drawPane("steps", desk);
    const money = chips(root).find((chip) => chip.textContent === "Money") as HTMLButtonElement;
    await press(money);
    expect(pressedNames(root)).toEqual(["Money"]);
    expect(texts(root, ".v2-quests-row .v2-quests-title")).toEqual(
      view.steps.filter((item) => item.lane === "money").map((item) => item.title),
    );

    await press(chips(root)[0]);
    expect(pressedNames(root)).toEqual([QUESTS_COPY.filterAll]);
    expect(texts(root, ".v2-quests-row .v2-quests-title")).toEqual(
      view.steps.map((item) => item.title),
    );
  });

  test("the filter is the pane's own state: nothing is saved, and a new mount shows All", async () => {
    const stored = window.localStorage.length;
    const root = drawPane("steps");
    await press(chips(root).find((chip) => chip.textContent === "Study") as HTMLButtonElement);
    expect(pressedNames(root)).toEqual(["Study"]);
    expect(window.localStorage.length).toBe(stored);
    cleanup();
    expect(pressedNames(drawPane("steps"))).toEqual([QUESTS_COPY.filterAll]);
  });

  test("draws no filter when only one lane has steps: it could change nothing", () => {
    const desk = withCandidates((candidates) => candidates.filter((item) => item.lane === "money"));
    const root = drawPane("steps", desk);
    expect(filterOf(root)).toBeNull();
    expect(rowsOf(root)).toHaveLength(viewOf(desk).steps.length);
  });

  test("group: the rows under their identity label, groups in the order their first step ranks", () => {
    const desk = sampleDesk(null);
    const view = viewOf(desk);
    const root = drawPane("steps", desk, { group: "group" });
    const order: string[] = [];
    for (const item of view.steps) {
      const label = item.identity?.label as string;
      if (!order.includes(label)) order.push(label);
    }
    const groups = Array.from(root.querySelectorAll<HTMLElement>(".v2-quests-group"));
    expect(groups.map((group) => group.querySelector("h3")?.textContent)).toEqual(order);
    groups.forEach((group, index) => {
      expect(texts(group, ".v2-quests-row .v2-quests-title")).toEqual(
        view.steps.filter((item) => item.identity?.label === order[index]).map((item) => item.title),
      );
      expect(group.querySelector("ol")?.getAttribute("role")).toBe("list");
      // The heading names the group, so a row under it does not say it again,
      // and still wears the colour.
      for (const row of group.querySelectorAll<HTMLElement>(".v2-quests-row")) {
        expect(row.querySelector(".v2-quests-ident")).toBeNull();
        expect(row.style.getPropertyValue("--v2-lane")).not.toBe("");
      }
    });
  });

  test("group and the filter together: one group, the lane pressed", async () => {
    const root = drawPane("steps", sampleDesk(null), { group: "group" });
    await press(chips(root).find((chip) => chip.textContent === "Money") as HTMLButtonElement);
    expect(texts(root, ".v2-quests-group h3")).toEqual(["Money"]);
  });

  test.each([undefined, "none", "", "Group", "toString", " group"])(
    "group %s draws one list with no headings",
    (group) => {
      const root = drawPane("steps", sampleDesk(null), group === undefined ? {} : { group });
      expect(root.querySelectorAll(".v2-quests-group, h3")).toHaveLength(0);
      expect(root.querySelectorAll("ol")).toHaveLength(1);
    },
  );

  test("says so when no lane has an open step", () => {
    const desk = withCandidates(() => []);
    const root = drawPane("steps", desk);
    expect(root.textContent).toBe(QUESTS_COPY.noSteps);
    expect(filterOf(root)).toBeNull();
  });
});

// ---------------------------------------------------------------- behaviour 4

describe("side quests", () => {
  const titles = (root: HTMLElement) => texts(root, ".v2-quests-row .v2-quests-title");

  test("the sample has none, and the pane says so in its own sentence", () => {
    expect(viewOf(sampleDesk(null)).side).toEqual([]);
    const root = drawPane("side-quests");
    expect(root.textContent).toBe(QUESTS_COPY.noSide);
  });

  test("clock: the same rows as the steps, in rank order", () => {
    const desk = withSide();
    const view = viewOf(desk);
    expect(view.side.length).toBe(3);
    const root = drawPane("side-quests", desk);
    expect(titles(root)).toEqual(view.side.map((item) => item.title));
    const rows = Array.from(root.querySelectorAll<HTMLElement>(".v2-quests-row"));
    view.side.forEach((item, index) => {
      expect(rows[index].querySelector(".v2-quests-ident")?.textContent ?? null).toBe(
        item.identity?.label ?? null,
      );
      expect(rows[index].dataset.when).toBe(item.when);
      expect(rows[index].querySelector(".v2-quests-date")?.textContent ?? null).toBe(item.due);
    });
    // A row with no identity takes no colour of its own, and draws no mark for one.
    const loose = rows[view.side.findIndex((item) => item.identity === null)];
    expect(loose.style.getPropertyValue("--v2-lane")).toBe("");
    expect(loose.querySelector(".v2-quests-ident")).toBeNull();
    const tagged = rows[view.side.findIndex((item) => item.identity !== null)];
    expect(tagged.querySelector(".v2-quests-ident")?.textContent).toBe("Balcony");
  });

  test("added: the order the source lists them in", () => {
    const desk = withSide();
    const view = viewOf(desk);
    const sideIds = new Set(view.side.map((item) => item.id));
    const added = questsOf(desk)
      .input.candidates.filter((item) => sideIds.has(item.id))
      .map((item) => view.side.find((entry) => entry.id === item.id)?.title);
    // Not vacuous: the planner's order and the source's differ here.
    expect(added).not.toEqual(view.side.map((item) => item.title));
    expect(titles(drawPane("side-quests", desk, { sort: "added" }))).toEqual(added);
  });

  test.each(["clock", "", "Added", "toString", "rank"])("sort %s is the clock order", (sort) => {
    const desk = withSide();
    expect(titles(drawPane("side-quests", desk, { sort }))).toEqual(
      viewOf(desk).side.map((item) => item.title),
    );
  });
});

// ---------------------------------------------------------------- behaviour 5

describe("done lately", () => {
  const dayHeads = (root: HTMLElement) => texts(root, ".v2-quests-day h3");

  test.each([
    ["7", 7],
    ["14", 14],
    ["28", 28],
    [undefined, 14],
    ["", 14],
    ["21", 14],
    ["toString", 14],
    [" 7", 14],
  ] as const)("span %s shows the last %d days", (span, days) => {
    const desk = sampleDesk(null);
    const view = viewOf(desk, days);
    const root = drawPane("done", desk, span === undefined ? {} : { span });
    expect(root.querySelector(".v2-quests-span")?.textContent).toBe(questSpanLabel(days));
    expect(dayHeads(root)).toEqual(view.done.days.map((day) => day.label));
  });

  test("each day: a small heading, then what was finished, newest first, with its identity", () => {
    const desk = sampleDesk(null);
    const view = viewOf(desk);
    const root = drawPane("done", desk);
    const days = Array.from(root.querySelectorAll<HTMLElement>(".v2-quests-day"));
    expect(days).toHaveLength(view.done.days.length);
    view.done.days.forEach((day, index) => {
      expect(days[index].querySelector("h3")?.textContent).toBe(day.label);
      const items = Array.from(days[index].querySelectorAll<HTMLElement>("li"));
      expect(items.map((item) => item.querySelector(".v2-quests-done-title")?.textContent)).toEqual(
        day.items.map((item) => item.title),
      );
      day.items.forEach((item, at) => {
        expect(items[at].querySelector(".v2-quests-ident")?.textContent ?? null).toBe(
          item.identity?.label ?? null,
        );
      });
    });
  });

  test("the total, and the rate as one quiet line of its own", () => {
    const desk = sampleDesk(null);
    for (const span of ["7", "14", "28"] as const) {
      const { done } = viewOf(desk, Number(span) as QuestSpan);
      expect(done.perWeek).not.toBeNull();
      const root = drawPane("done", desk, { span });
      expect(root.querySelector(".v2-quests-total")?.textContent).toBe(
        questDoneTotalLabel(done.total),
      );
      const rate = root.querySelector(".v2-quests-rate") as HTMLElement;
      expect(rate.textContent).toBe(questPerWeekLabel(done.perWeek as number));
      expect(rate.children).toHaveLength(0);
      // Said before the days it is about.
      expect(follows(rate, root.querySelector(".v2-quests-day") as Node)).toBe(true);
      cleanup();
    }
  });

  test("a known span with nothing finished says so, with no zero and no rate", () => {
    const desk = withQuests(() => ({ done: [] }));
    const { done } = viewOf(desk);
    expect(done).toMatchObject({ known: true, total: 0, perWeek: null });
    const root = drawPane("done", desk);
    expect(texts(root, ".v2-pane-note")).toEqual([QUESTS_COPY.doneNone]);
    expect(root.querySelector(".v2-quests-total")).toBeNull();
    expect(root.querySelector(".v2-quests-rate")).toBeNull();
    expect(root.querySelector(".v2-quests-day")).toBeNull();
    // The only number is the span the sentence is about.
    expect(root.textContent?.replace(questSpanLabel(14), "")).not.toMatch(/\d/);
  });

  test("no history at all: one sentence and no number", () => {
    const desk = withQuests(() => ({ done: [], historyThrough: null, historyDays: 0 }));
    const root = drawPane("done", desk);
    expect(root.textContent).toBe(QUESTS_COPY.noHistory);
    expect(root.textContent).not.toMatch(/\d/);
  });

  test("a history too short for the span: its sentence, what it holds, and no number about it", () => {
    const desk = withQuests(() => ({ historyDays: 7 }));
    const { done } = viewOf(desk);
    expect(done.known).toBe(false);
    expect(done.days.length).toBeGreaterThan(0);
    const root = drawPane("done", desk);
    expect(texts(root, ".v2-pane-note")).toEqual([QUESTS_COPY.shortHistory]);
    expect(root.querySelector(".v2-quests-total")).toBeNull();
    expect(root.querySelector(".v2-quests-rate")).toBeNull();
    expect(dayHeads(root)).toEqual(done.days.map((day) => day.label));
  });

  test("when the history ends before the planned day, the first line says the day it ends on", () => {
    const desk = withQuests(() => ({ historyThrough: "2026-04-12" }));
    const { done } = viewOf(desk);
    expect(done.through).not.toBeNull();
    const root = drawPane("done", desk);
    const first = root.firstElementChild as HTMLElement;
    expect(first.className).toBe("v2-quests-through");
    expect(first.textContent).toBe(questThroughLabel(done.through as string));
    expect(dayHeads(root)).toEqual(done.days.map((day) => day.label));
  });

  test("says nothing about an end when lately ends on the planned day", () => {
    expect(drawPane("done").querySelector(".v2-quests-through")).toBeNull();
  });
});

// ------------------------------------------------------------ behaviours 6, 7

describe("read only, and one shape for every list", () => {
  const desks = [
    ["the sample", () => sampleDesk(null)],
    ["side quests", withSide],
    ["a short history", () => withQuests(() => ({ historyDays: 7 }))],
  ] as const;

  test.each(desks)("%s: nothing in lanes, side quests or done can be pressed or typed in", (_name, desk) => {
    for (const id of ["lanes", "side-quests", "done"]) {
      const root = drawPane(id, desk());
      expect(root.querySelectorAll("a, button, input, select, textarea, [tabindex]"), id).toHaveLength(0);
      cleanup();
    }
  });

  test.each(desks)("%s: the steps pane's only controls are the lane filter's buttons", (_name, desk) => {
    const root = drawPane("steps", desk());
    expect(root.querySelectorAll("a, input, select, textarea, [tabindex]")).toHaveLength(0);
    const buttons = Array.from(root.querySelectorAll("button"));
    expect(buttons.length).toBeGreaterThan(1);
    for (const button of buttons) {
      expect(button.closest(`[role="group"][aria-label="${QUESTS_COPY.filterLabel}"]`)).not.toBeNull();
      expect(["true", "false"]).toContain(button.getAttribute("aria-pressed"));
    }
    for (const row of root.querySelectorAll(".v2-quests-row")) {
      expect(row.querySelector("a, button")).toBeNull();
    }
  });

  test.each(desks)("%s: every list says it is a list, and nothing is a live region", (_name, desk) => {
    let lists = 0;
    for (const id of QUEST_IDS) {
      const root = drawPane(id, desk(), id === "steps" ? { group: "group" } : {});
      for (const list of root.querySelectorAll("ul, ol")) {
        expect(list.getAttribute("role"), `${id} ${list.className}`).toBe("list");
        lists += 1;
      }
      expect(root.querySelectorAll('[role="status"], [aria-live]'), id).toHaveLength(0);
      // No fixed ids: two of one pane can sit on a desk at once.
      expect(root.querySelectorAll("[id]"), id).toHaveLength(0);
      cleanup();
    }
    expect(lists).toBeGreaterThanOrEqual(3);
  });

  test("a row's own text carries the long word, and is never a link", () => {
    const long = "x".repeat(400);
    const desk = withCandidates((candidates) => [
      candidate({ id: "t-x-long", title: `${long} (${long})`, lane: "craft" }),
      ...candidates,
    ]);
    const root = drawPane("steps", desk);
    const row = Array.from(root.querySelectorAll<HTMLElement>(".v2-quests-row")).find(
      (one) => one.querySelector(".v2-quests-title")?.textContent === long,
    ) as HTMLElement;
    expect(row).toBeDefined();
    expect(row.querySelector(".v2-quests-detail")?.textContent).toBe(long);
  });

  // A key React cannot use warns through console.error, and can hand one row's
  // state to another. Every list, on every desk, in both step views and both
  // side orders.
  test("draws every list with keys React accepts", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const desks = [
        sampleDesk(null),
        withSide(),
        withQuests((quests) => ({ done: [workFinished(), ...quests.done] })),
      ];
      for (const desk of desks) {
        for (const [group, sort] of [
          ["none", "clock"],
          ["group", "added"],
        ]) {
          drawPanes(QUEST_IDS, desk, { steps: { group }, "side-quests": { sort } });
          cleanup();
        }
      }
      expect(spy.mock.calls.map((call) => String(call[0]))).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });
});

// The desk hands a body its options in an object with NO PROTOTYPE, frozen
// (`paneOptions`), whose keys come from a URL or a stored layout. Each pane
// reads its one key as plain data and falls back on anything else, a key that
// names a prototype method included.
describe("options, as the desk hands them", () => {
  const hostile: Array<readonly [string, string]> = [
    ["constructor", "group"],
    ["__proto__", "added"],
    ["toString", "7"],
    ["hasOwnProperty", "28"],
  ];

  test("the objects really have no prototype", () => {
    expect(Object.getPrototypeOf(paneOptions(hostile))).toBeNull();
  });

  test("steps: group from a prototype free object, and nothing else groups", () => {
    const grouped = drawPane("steps", sampleDesk(null), paneOptions([...hostile, ["group", "group"]]));
    expect(grouped.querySelectorAll(".v2-quests-group").length).toBeGreaterThan(1);
    cleanup();
    for (const options of [paneOptions([]), paneOptions(hostile), paneOptions([["group", "none"]])]) {
      const root = drawPane("steps", sampleDesk(null), options);
      expect(root.querySelectorAll(".v2-quests-group, h3")).toHaveLength(0);
      cleanup();
    }
  });

  test("side quests: added from a prototype free object, and the clock otherwise", () => {
    const desk = withSide();
    const view = viewOf(desk);
    const clock = view.side.map((item) => item.title);
    const added = drawPane("side-quests", desk, paneOptions([...hostile, ["sort", "added"]]));
    expect(texts(added, ".v2-quests-row .v2-quests-title")).not.toEqual(clock);
    cleanup();
    for (const options of [paneOptions([]), paneOptions(hostile)]) {
      const root = drawPane("side-quests", desk, options);
      expect(texts(root, ".v2-quests-row .v2-quests-title")).toEqual(clock);
      cleanup();
    }
  });

  test("done: the span from a prototype free object, and 14 otherwise", () => {
    const desk = sampleDesk(null);
    for (const [span, days] of [
      ["7", 7],
      ["28", 28],
    ] as const) {
      const root = drawPane("done", desk, paneOptions([...hostile, ["span", span]]));
      expect(root.querySelector(".v2-quests-span")?.textContent).toBe(questSpanLabel(days));
      cleanup();
    }
    for (const options of [paneOptions([]), paneOptions(hostile)]) {
      const root = drawPane("done", desk, options);
      expect(root.querySelector(".v2-quests-span")?.textContent).toBe(questSpanLabel(14));
      cleanup();
    }
  });
});

// ------------------------------------------------------ behaviours 2, 3, 7, 8: the sheet

describe("quests.css", () => {
  const CSS = readFileSync(path.join(ROOT, "app/v2/quests.css"), "utf8");
  const sheet = postcss.parse(CSS, { from: "app/v2/quests.css" });

  /** Every rule with where it sits: the at-rule around it, or "". */
  const rulesOf = () => {
    const out: Array<{ rule: Rule; where: string }> = [];
    sheet.walkRules((rule) => {
      const parent = rule.parent as AtRule | undefined;
      const where = parent?.type === "atrule" ? `@${parent.name} ${parent.params.trim()}` : "";
      out.push({ rule, where });
    });
    return out;
  };

  /** The last value one selector is given for one property, in one place. */
  const valueOf = (where: string, selector: string, prop: string) => {
    let found: string | null = null;
    for (const entry of rulesOf()) {
      if (entry.where !== where) continue;
      if (!entry.rule.selectors.map((one) => one.trim()).includes(`[data-v2-root] ${selector}`)) {
        continue;
      }
      entry.rule.walkDecls(prop, (decl) => {
        found = decl.value;
      });
    }
    return found;
  };

  const AT = (px: number) => `@container v2-pane (width >= ${px}px)`;

  test("is loaded after the desk's sheet, by one line", () => {
    const layout = readFileSync(path.join(ROOT, "app/v2/layout.tsx"), "utf8");
    const at = (name: string) => layout.indexOf(`import "./${name}";`);
    expect(at("desk.css")).toBeGreaterThan(-1);
    expect(at("quests.css")).toBeGreaterThan(at("desk.css"));
    expect(layout.split(`import "./quests.css";`)).toHaveLength(2);
  });

  // Behaviour 2. Under 300px of pane, a lane is its name, its count and its
  // next date; from 300px its next stop joins under the name; from 520px the
  // stop sits beside the name, on a track every lane shares.
  test("lays a lane out by the pane's width: 300px and 520px", () => {
    expect(valueOf("", ".v2-quests-next", "display")).toBe("none");
    expect(valueOf("", ".v2-quests-lane-past", "display")).toBe("none");
    expect(valueOf(AT(300), ".v2-quests-next", "display")).toBe("flex");
    expect(valueOf(AT(300), ".v2-quests-lane-past", "display")).toBe("inline-flex");
    expect(valueOf(AT(520), ".v2-quests-lane-list", "display")).toBe("grid");
    expect(valueOf(AT(520), ".v2-quests-lane", "grid-template-columns")).toBe("subgrid");
    expect(valueOf(AT(520), ".v2-quests-next", "grid-column")).toBe("2");
    expect(valueOf(AT(520), ".v2-quests-lane-meta", "grid-column")).toBe("3");
  });

  // Behaviour 3. One column under 560px of pane, two from there, three from
  // 900px; a long word cannot widen a track.
  test("lays the rows one, two and three across by the pane's own width", () => {
    expect(valueOf("", ".v2-quests-rows", "grid-template-columns")).toBe("minmax(0, 1fr)");
    expect(valueOf(AT(560), ".v2-quests-rows", "grid-template-columns")).toBe(
      "repeat(2, minmax(0, 1fr))",
    );
    expect(valueOf(AT(900), ".v2-quests-rows", "grid-template-columns")).toBe(
      "repeat(3, minmax(0, 1fr))",
    );
  });

  test("answers only to the pane, at exactly those widths", () => {
    const params: string[] = [];
    sheet.walkAtRules((at) => {
      params.push(`@${at.name} ${at.params}`);
    });
    expect([...new Set(params)].sort()).toEqual([AT(300), AT(520), AT(560), AT(900)].sort());
  });

  test("draws a row on the lists' own surface", () => {
    expect(valueOf("", ".v2-quests-row", "background")).toBe("var(--v2-card)");
    expect(valueOf("", ".v2-quests-row", "border-radius")).toBe("12px");
    expect(valueOf("", ".v2-quests-lane", "background")).toBe("var(--v2-card)");
    expect(valueOf("", ".v2-quests-lane", "border-radius")).toBe("12px");
  });

  // The next stop is the one thing this screen exists to say: the brightest
  // text in its row. The name, the count and the date are quieter, and a quiet
  // lane is its name in the dim ink.
  test("makes the next stop the brightest text in a lane, and a quiet lane dim", () => {
    expect(valueOf("", ".v2-quests-next-title", "color")).toBe("var(--v2-ink)");
    expect(valueOf("", ".v2-quests-lane-name", "color")).toBe("var(--v2-ink-2)");
    expect(valueOf("", ".v2-quests-lane-meta", "color")).toBe("var(--v2-ink-2)");
    expect(valueOf("", ".v2-quests-lane[data-quiet] .v2-quests-lane-name", "color")).toBe(
      "var(--v2-ink-3)",
    );
    expect(valueOf("", ".v2-quests-lane-name::before", "background")).toBe("var(--v2-lane)");
  });

  test("lets a long word break instead of widening the pane", () => {
    for (const selector of [
      ".v2-quests-title",
      ".v2-quests-detail",
      ".v2-quests-lane-name",
      ".v2-quests-next-title",
      ".v2-quests-done-title",
    ]) {
      expect(valueOf("", selector, "overflow-wrap"), selector).toBe("anywhere");
      expect(valueOf("", selector, "min-width"), selector).toBe("0");
    }
    expect(valueOf("", ".v2-quests-row", "min-width")).toBe("0");
  });

  // There is no danger token in v2.css. The panes read one alias, set once on
  // their root, as the Money panes do; it is a mark, never the colour of a word.
  test("marks danger through one alias, as a mark beside its word", () => {
    expect(valueOf("", ".v2-quests", "--v2-quests-danger")).toBe("var(--v2-warn)");
    const asText: string[] = [];
    const used: string[] = [];
    sheet.walkDecls((decl) => {
      if (decl.prop === "color" && decl.value.includes("--v2-quests-danger")) asText.push(decl.toString());
      if (decl.value.includes("var(--v2-quests-danger)")) used.push(decl.prop);
    });
    expect(asText).toEqual([]);
    expect(used.length).toBeGreaterThanOrEqual(2);
    expect(valueOf("", ".v2-quests-lane-past::before", "background")).toBe("var(--v2-quests-danger)");
    expect(valueOf("", '.v2-quests-when[data-when="past"]::before', "background")).toBe(
      "var(--v2-quests-danger)",
    );
  });

  // A done block is not a finished task: the worked state adds a phrase and
  // changes nothing else about the row.
  test("never strikes or fades a step worked on today", () => {
    expect(CSS).not.toMatch(/line-through/);
    sheet.walkRules((rule) => {
      if (!/data-worked|v2-quests-worked/.test(rule.selector)) return;
      rule.walkDecls((decl) => {
        expect(decl.prop, rule.selector).not.toMatch(/^(opacity|text-decoration|filter|visibility)$/);
        if (decl.prop === "display") expect(decl.value, rule.selector).not.toBe("none");
      });
    });
    expect(valueOf("", ".v2-quests-worked", "color")).toBe("var(--v2-ink-2)");
  });

  test("scopes every rule to the root, and leaves reduced motion to v2.css", () => {
    sheet.walkRules((rule) => {
      for (const selector of rule.selectors) {
        expect(selector.trim().startsWith("[data-v2-root] "), selector).toBe(true);
      }
    });
    const media: string[] = [];
    sheet.walkAtRules("media", (at) => {
      media.push(at.params);
    });
    expect(media).toEqual([]);
  });

  // The plan's motion rule: motion moves only transform and opacity. These
  // panes move nothing, so today the sheet holds no transition at all; any one
  // added later may name only those two, at the screen's own speeds.
  test("moves nothing on load, and transitions nothing but transform or opacity", () => {
    const animations: string[] = [];
    sheet.walkDecls(/^animation/, (decl) => {
      animations.push(decl.value);
    });
    sheet.walkAtRules("keyframes", (at) => {
      animations.push(at.params);
    });
    expect(animations).toEqual([]);

    const named: string[] = [];
    sheet.walkDecls(/^transition/, (decl) => {
      if (decl.prop === "transition-property") {
        named.push(...decl.value.split(",").map((part) => part.trim()));
        return;
      }
      if (decl.prop !== "transition") return;
      for (const part of decl.value.split(",")) named.push(part.trim().split(/\s+/)[0]);
      expect(decl.value, decl.toString()).toMatch(/var\(--v2-(quick|std|slow)\)/);
      expect(decl.value, decl.toString()).toMatch(/var\(--v2-ease(-in)?\)/);
    });
    for (const name of named) expect(["transform", "opacity"], name).toContain(name);
    // The hover hairline is there, and appears at once.
    expect(valueOf("", ".v2-quests-row:hover", "box-shadow")).toMatch(/var\(--v2-edge\)/);
    expect(valueOf("", ".v2-quests-row", "transition")).toBeNull();
    expect(valueOf("", ".v2-quests-lane", "transition")).toBeNull();
    expect(valueOf("", ".v2-quests-chip", "transition")).toBeNull();
  });

  // Behaviour 7, at the narrowest pane: "Past its date" and a long date side by
  // side are wider than a 230px row, and the pane clips what overflows it. The
  // line breaks between the two, never inside either.
  test("lets a row's date line break between the mark and the date, never inside them", () => {
    expect(valueOf("", ".v2-quests-due", "flex-wrap")).toBe("wrap");
    expect(valueOf("", ".v2-quests-due", "min-width")).toBe("0");
    expect(valueOf("", ".v2-quests-due", "white-space")).toBeNull();
    expect(valueOf("", ".v2-quests-date", "white-space")).toBe("nowrap");
    expect(valueOf("", ".v2-quests-when", "white-space")).toBe("nowrap");
    expect(valueOf("", ".v2-quests-meta", "flex-wrap")).toBe("wrap");
  });

  // The raw identity colour (--v2-lane) is a mark: held to 3:1, which is enough
  // for a dot and not for a word. Text in a colour reads --v2-ident.
  test("never colours text with the raw identity swatch", () => {
    const offenders: string[] = [];
    sheet.walkDecls("color", (decl) => {
      if (decl.value.includes("--v2-lane")) offenders.push(`${(decl.parent as Rule).selector} ${decl}`);
    });
    expect(offenders).toEqual([]);
    expect(valueOf("", ".v2-quests-ident", "color")).toBe("var(--v2-ident)");
    expect(valueOf("", ".v2-quests-group-head", "color")).toBe("var(--v2-ident)");
  });

  test("brings no font of its own and no colour of its own", () => {
    expect(CSS).not.toMatch(/@font-face|@import/);
    sheet.walkDecls(/^font(-family)?$/, (decl) => {
      expect(decl.value, decl.toString()).toMatch(/var\(--v2-(display|text)\)/);
    });
    sheet.walkDecls((decl) => {
      expect(decl.value, decl.toString()).not.toMatch(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/);
    });
  });

  // The pane box is the one scroller (desk.css): a body that scrolled itself
  // would trap the wheel, and a fixed height would not fit a 150px box.
  test("adds no scroller and no fixed height to a body", () => {
    sheet.walkDecls(/^(overflow-y|overflow-x|height)$/, (decl) => {
      expect(decl.value, decl.toString()).not.toMatch(/auto|scroll|vh|dvh/);
    });
    sheet.walkDecls(/^width$/, (decl) => {
      expect(decl.value, decl.toString()).not.toMatch(/\d{3,}px|vw/);
    });
  });

  // The side column's leaves tie their base rules at two classes, and this
  // sheet loads after v2.css, so a bare rule on one of them here would win on
  // Today's own page. Nothing here touches a shared leaf at all.
  test("leaves the shared leaves alone, and names only its own classes", () => {
    const shared = /\.v2-(feeds|allday|energy|said|sub|row|more|empty|side|list|lane|stop|lit|detail|ident|pane)\b/;
    sheet.walkRules((rule) => {
      for (const selector of rule.selectors) {
        expect(selector, selector).not.toMatch(shared);
        for (const name of selector.match(/\.[\w-]+/g) ?? []) {
          expect(name.startsWith(".v2-quests"), selector).toBe(true);
        }
      }
    });
  });
});

// Every word the panes print comes from the copy walked for dashes and scores:
// the view's QUESTS_COPY (walked by v2-view-quests), Today's lane words through
// it, and the desk's DESK_COPY. This pins that the panes added no word of their
// own by drawing the sample and finding every text node among them.
test("prints no word of its own invention", () => {
  const side = withSide();
  const desk: DeskScreenData = {
    ...side,
    quests: { ...questsOf(side), done: [workFinished(), ...questsOf(side).done] },
  };
  const view = viewOf(desk);
  const allowed = new Set<string>([
    ...Object.values<unknown>(QUESTS_COPY).filter(
      (value): value is string => typeof value === "string",
    ),
    ...Object.values(QUESTS_COPY.when),
    ...view.lanes.flatMap((lane) => [
      lane.label,
      laneOpenLabel(lane.open),
      ...(lane.due === null ? [] : [laneDueLabel(lane.due)]),
      ...(lane.past > 0 ? [questPastLabel(lane.past)] : []),
      ...(lane.done !== null && lane.done > 0 ? [questDoneTotalLabel(lane.done)] : []),
    ]),
    ...[...view.steps, ...view.side].flatMap((item) => [
      item.title,
      item.detail ?? "",
      item.due ?? "",
      item.identity?.label ?? "",
    ]),
    ...view.done.days.flatMap((day) => [
      day.label,
      ...day.items.flatMap((item) => [item.title, item.identity?.label ?? ""]),
    ]),
    questSpanLabel(14),
    questDoneTotalLabel(view.done.total),
    ...(view.done.perWeek === null ? [] : [questPerWeekLabel(view.done.perWeek)]),
  ]);
  const { container } = drawPanes(QUEST_IDS, desk);
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let seen = 0;
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const text = node.textContent ?? "";
    if (text.trim() === "") continue;
    seen += 1;
    expect(allowed.has(text), JSON.stringify(text)).toBe(true);
  }
  expect(seen).toBeGreaterThan(40);
  // Not vacuous: the lane with only something finished is on this desk.
  expect(view.lanes.find((lane) => lane.key === "work")).toMatchObject({ open: 0, done: 1 });
  expect(container.textContent).toContain(questDoneTotalLabel(1));
});
