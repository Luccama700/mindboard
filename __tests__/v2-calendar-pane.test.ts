// PLAN-OS Task 2: the calendar pane, and the blocks Today hands it.
//
// The pane is read only and draws what buildCalendarView decided, so what is
// pinned here is the part a test without a browser can see: what a screen
// reader is told, where each link points, which list a chip is in, and the
// numbers each chip carries for the stylesheet to place it by. jsdom lays
// nothing out, so how the pane LOOKS is pinned through the stylesheet's own
// rules, read with postcss, and the rest is on the render pass's checklist.
//
// BOTH LAYOUTS ARE IN THE DOCUMENT AT ONCE. The server renders the agenda and
// the grid and the stylesheet shows one of them, so every query below is scoped
// to one or the other: an unscoped query would find every chip twice.
//
// JSX would need a .tsx file, hence createElement, as in the other v2 tests.

import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";

import postcss, { type AtRule } from "postcss";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";

import { sampleDay } from "@/app/lib/v2/fixtures/sample-day";
import { sampleWeek } from "@/app/lib/v2/fixtures/sample-week";
import { planReference } from "@/app/lib/v2/plan/day";
import { planDay } from "@/app/lib/v2/plan/planner";
import type { Block, PlanOutput } from "@/app/lib/v2/types";
import { DEFAULT_APPEARANCE, identityTokens, tokensFor } from "@/app/lib/v2/view/appearance";
import {
  CALENDAR_COPY,
  buildCalendarView,
  type PlannedBlock,
} from "@/app/lib/v2/view/calendar";
import type { CalendarScreenData, TodayScreenData } from "@/app/lib/v2/view/screen-data";
import { TODAY_COPY, buildTodayView } from "@/app/lib/v2/view/today";
import { CalendarPane } from "@/app/v2/_components/calendar/calendar-pane";
import { NavBar } from "@/app/v2/_components/nav-bar";
import { TodayClient } from "@/app/v2/today/today-client";

const ROOT = path.resolve(__dirname, "..");

/** The sample day is a Wednesday, and its week runs Monday 13 to Sunday 19 April. */
const WEDNESDAY = "2026-04-15";
const THURSDAY = "2026-04-16";
const WEEK_LABEL = "13 to 19 April";

/** One block the planner might have put on the sample day. Fictional. */
const BLOCK: PlannedBlock = {
  id: "pb-reading",
  title: "Read chapter four",
  start: `${WEDNESDAY}T11:00:00-07:00`,
  end: `${WEDNESDAY}T11:50:00-07:00`,
};

/** The scheme the pane renders with when nothing is stored: black and purple. */
const TOKENS = tokensFor(DEFAULT_APPEARANCE);

/** The pane's accessible name: the word, then whichever week it is showing. */
const CALENDAR_NAME = new RegExp(`^${CALENDAR_COPY.heading} `);

function paneOf(
  data: CalendarScreenData = sampleWeek(null),
  planned: readonly PlannedBlock[] = [BLOCK],
  basePath = "/v2/today",
) {
  return render(createElement(CalendarPane, { data, planned, basePath }));
}

const grid = () => document.querySelector<HTMLElement>(".v2-cal-grid") as HTMLElement;
const agenda = () => document.querySelector<HTMLElement>(".v2-cal-agenda") as HTMLElement;

/** The grid's list for one day, by the label a screen reader is given. */
function gridDay(label: string): HTMLElement {
  const list = grid().querySelector<HTMLElement>(`ul[aria-label="${label}"]`);
  if (list === null) throw new Error(`no grid list labelled ${label}`);
  return list;
}

/** The agenda's list for one day, which its own visible heading labels. */
function agendaDay(label: string): HTMLElement {
  for (const list of agenda().querySelectorAll<HTMLElement>("ul[aria-labelledby]")) {
    const heading = document.getElementById(list.getAttribute("aria-labelledby") ?? "");
    if (heading?.textContent === label) return list;
  }
  throw new Error(`no agenda list labelled ${label}`);
}

/** Every chip in one scope, by its title. */
function chipsIn(scope: HTMLElement): HTMLElement[] {
  return Array.from(scope.querySelectorAll<HTMLElement>(".v2-cal-chip"));
}

function chipTitled(scope: HTMLElement, title: string): HTMLElement {
  const chip = chipsIn(scope).find(
    (one) => one.querySelector(".v2-cal-chip-title")?.textContent === title,
  );
  if (chip === undefined) throw new Error(`no chip titled ${title}`);
  return chip;
}

const titleOf = (chip: HTMLElement) =>
  chip.querySelector(".v2-cal-chip-title")?.textContent ?? "";

const varOf = (element: Element, name: string) =>
  (element as HTMLElement).style.getPropertyValue(name);

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// Behaviour 1: read only
// ---------------------------------------------------------------------------

describe("the pane is read only", () => {
  test("has no control at all but the week links", () => {
    const { container } = paneOf({
      ...sampleWeek(null),
      prevWeek: "2026-04-06",
      thisWeek: "2026-04-13",
    });
    expect(container.querySelectorAll("button, input, select, textarea")).toHaveLength(0);
    const links = Array.from(container.querySelectorAll("a"));
    expect(links.map((link) => link.textContent)).toEqual([
      CALENDAR_COPY.previous,
      CALENDAR_COPY.thisWeek,
      CALENDAR_COPY.next,
    ]);
  });

  test("puts nothing a hand can press inside a chip", () => {
    const { container } = paneOf();
    const chips = container.querySelectorAll(".v2-cal-chip");
    expect(chips.length).toBeGreaterThan(0);
    for (const chip of chips) {
      expect(chip.querySelector("a, button, input, select, textarea, [tabindex]")).toBeNull();
      expect(chip.hasAttribute("tabindex")).toBe(false);
    }
  });

  // A scroller has to take focus or a keyboard cannot scroll it, which is not
  // the same thing as being a control: nothing happens when it is pressed.
  test("lets a keyboard reach the two scrollers, and nothing else but the links", () => {
    const { container } = paneOf();
    const stops = Array.from(container.querySelectorAll<HTMLElement>("[tabindex]"));
    expect(stops.map((stop) => stop.className).sort()).toEqual(["v2-cal-agenda", "v2-cal-grid"]);
    for (const stop of stops) expect(stop.tabIndex).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Behaviour 2: structure a screen reader can use
// ---------------------------------------------------------------------------

describe("the pane reads in order", () => {
  test("is a section named by its heading, which says Calendar and the week", () => {
    paneOf();
    const region = screen.getByRole("region", {
      name: `${CALENDAR_COPY.heading} ${WEEK_LABEL}`,
    });
    expect(region.tagName).toBe("SECTION");
    // It sits beside a page whose h1 is the day, so it starts at h2.
    const heading = document.getElementById(region.getAttribute("aria-labelledby") ?? "");
    expect(heading?.tagName).toBe("H2");
    expect(region.querySelector("h1")).toBeNull();
  });

  test("gives each day of the grid its own list, named by the day, today marked", () => {
    paneOf();
    const view = buildCalendarView(sampleWeek(null), [BLOCK]);
    const lists = Array.from(grid().querySelectorAll<HTMLElement>("ul[aria-label]"));
    expect(lists.map((list) => list.getAttribute("aria-label"))).toEqual(
      view.days.map((day) => day.label),
    );
    const current = lists.filter((list) => list.getAttribute("aria-current") === "date");
    expect(current.map((list) => list.getAttribute("aria-label"))).toEqual([
      "Wednesday 15 April",
    ]);
  });

  test("gives each day of the agenda its own list, under its heading, today marked", () => {
    paneOf();
    const view = buildCalendarView(sampleWeek(null), [BLOCK]);
    const lists = Array.from(agenda().querySelectorAll<HTMLElement>("ul[aria-labelledby]"));
    const labels = lists.map(
      (list) => document.getElementById(list.getAttribute("aria-labelledby") ?? "")?.textContent,
    );
    expect(labels).toEqual(view.days.map((day) => day.label));
    expect(
      lists.filter((list) => list.getAttribute("aria-current") === "date"),
    ).toEqual([agendaDay("Wednesday 15 April")]);
  });

  test("reads a chip as its title, its time, its calendar and its place", () => {
    paneOf();
    for (const scope of [gridDay("Wednesday 15 April"), agendaDay("Wednesday 15 April")]) {
      expect(chipTitled(scope, "Morning seminar").textContent).toBe(
        "Morning seminar 09:00 to 10:15 Campus Hall B",
      );
    }
    // No place: the line simply ends at the calendar.
    expect(chipTitled(gridDay("Thursday 16 April"), "Glaze delivery").textContent).toBe(
      "Glaze delivery 15:00 to 16:00 Campus",
    );
  });

  test("reads a planned chip as Planned where a calendar would be named", () => {
    paneOf();
    for (const scope of [gridDay("Wednesday 15 April"), agendaDay("Wednesday 15 April")]) {
      const chip = chipTitled(scope, BLOCK.title);
      expect(chip.textContent).toBe(`${BLOCK.title} 11:00 to 11:50 ${CALENDAR_COPY.planned}`);
      expect(chip.getAttribute("data-kind")).toBe("planned");
    }
  });

  // The grid draws an all day event as one bar across its days, which a screen
  // reader cannot follow, so the bar is hidden from it and each day's own list
  // says it instead.
  test("says an all day event in each day it covers, in both layouts", () => {
    paneOf();
    for (const day of ["Thursday 16 April", "Friday 17 April", "Saturday 18 April"]) {
      expect(gridDay(day).textContent).toContain(`Kiln maintenance ${CALENDAR_COPY.allDay}`);
      expect(agendaDay(day).textContent).toContain(`Kiln maintenance ${CALENDAR_COPY.allDay}`);
    }
    expect(gridDay("Sunday 19 April").textContent).not.toContain("Kiln maintenance");
    const bar = grid().querySelector(".v2-cal-allday");
    expect(bar?.closest('[aria-hidden="true"]')).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Behaviour 3: a day that is not covered, and a week with nothing on it
// ---------------------------------------------------------------------------

describe("a day the source cannot speak for", () => {
  const withoutThursday = (): CalendarScreenData => {
    const data = sampleWeek(null);
    return { ...data, covered: data.covered.filter((date) => date !== THURSDAY) };
  };

  test("says so in its column, and nothing else", () => {
    paneOf(withoutThursday());
    const list = gridDay("Thursday 16 April");
    expect(list.textContent).toBe(CALENDAR_COPY.notCovered);
    expect(list.querySelectorAll("li")).toHaveLength(1);
    expect(list.closest(".v2-cal-col")?.getAttribute("data-covered")).toBe("no");
  });

  test("says so in the agenda, and nothing else", () => {
    paneOf(withoutThursday());
    const list = agendaDay("Thursday 16 April");
    expect(list.textContent).toBe(CALENDAR_COPY.notCovered);
    expect(list.querySelectorAll("li")).toHaveLength(1);
  });

  test("is never said about a day the source covers", () => {
    paneOf();
    expect(document.body.textContent).not.toContain(CALENDAR_COPY.notCovered);
  });
});

describe("a covered week with nothing on it", () => {
  test("says so once, and still draws the week and the planned blocks", () => {
    paneOf({ ...sampleWeek(null), events: [] });
    expect(screen.getAllByText(CALENDAR_COPY.nothing)).toHaveLength(1);
    expect(grid().querySelectorAll("ul[aria-label]")).toHaveLength(7);
    expect(chipTitled(gridDay("Wednesday 15 April"), BLOCK.title)).toBeTruthy();
  });

  test("says nothing of the kind while something is on it", () => {
    paneOf();
    expect(screen.queryByText(CALENDAR_COPY.nothing)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Behaviour 6: colour
// ---------------------------------------------------------------------------

describe("a chip's colour", () => {
  const IDENTITY = ["--v2-lane", "--v2-lit", "--v2-ident", "--v2-on-ident"];

  test("comes from its calendar, through identityTokens, as a list row's does", () => {
    paneOf();
    const chip = chipTitled(gridDay("Wednesday 15 April"), "Morning seminar");
    const expected = identityTokens("#7C9BFF", TOKENS);
    for (const name of IDENTITY) expect(varOf(chip, name), name).toBe(expected[name]);
  });

  test("is the accent when its calendar has none", () => {
    const data = sampleWeek(null);
    paneOf({
      ...data,
      calendars: data.calendars.map((calendar) => ({ ...calendar, color: null })),
    });
    const chip = chipTitled(gridDay("Wednesday 15 April"), "Morning seminar");
    const expected = identityTokens(TOKENS["--v2-accent"], TOKENS);
    for (const name of IDENTITY) expect(varOf(chip, name), name).toBe(expected[name]);
    expect(varOf(chip, "--v2-lane")).toBe(TOKENS["--v2-accent"]);
  });

  test("is not set at all on a planned chip, which the stylesheet draws in the accent", () => {
    paneOf();
    const chip = chipTitled(gridDay("Wednesday 15 April"), BLOCK.title);
    for (const name of IDENTITY) expect(varOf(chip, name), name).toBe("");
  });

  test("marks an all day bar and the legend by the same rule", () => {
    paneOf();
    const bar = Array.from(grid().querySelectorAll<HTMLElement>(".v2-cal-span")).find(
      (one) => one.textContent === "Kiln maintenance",
    );
    expect(varOf(bar as HTMLElement, "--v2-lane")).toBe(
      identityTokens("#C58BFF", TOKENS)["--v2-lane"],
    );
    const legend = Array.from(document.querySelectorAll<HTMLElement>(".v2-cal-legend li"));
    expect(legend.map((entry) => entry.textContent)).toEqual([
      "Campus",
      "Print shop",
      "Term dates",
    ]);
    expect(varOf(legend[1], "--v2-lane")).toBe(identityTokens("#2FD6A3", TOKENS)["--v2-lane"]);
  });
});

// ---------------------------------------------------------------------------
// Behaviours 4 and 7: placed by the view's numbers, never measured
// ---------------------------------------------------------------------------

describe("where a chip goes", () => {
  test("is the view's own fractions and columns, handed to the stylesheet", () => {
    paneOf();
    const view = buildCalendarView(sampleWeek(null), [BLOCK]);
    for (const day of view.days) {
      if (!day.covered) continue;
      const chips = chipsIn(gridDay(day.label));
      expect(chips.map(titleOf)).toEqual(day.chips.map((chip) => chip.title));
      day.chips.forEach((chip, index) => {
        expect(varOf(chips[index], "--v2-cal-at")).toBe(String(chip.top));
        expect(varOf(chips[index], "--v2-cal-span")).toBe(String(chip.height));
        expect(varOf(chips[index], "--v2-cal-i")).toBe(String(chip.column));
        expect(varOf(chips[index], "--v2-cal-n")).toBe(String(chip.columnCount));
      });
    }
  });

  test("shares the column between two chips that overlap", () => {
    paneOf();
    const thursday = gridDay("Thursday 16 April");
    const loading = chipTitled(thursday, "Kiln loading");
    const glaze = chipTitled(thursday, "Glaze delivery");
    expect([varOf(loading, "--v2-cal-i"), varOf(loading, "--v2-cal-n")]).toEqual(["0", "2"]);
    expect([varOf(glaze, "--v2-cal-i"), varOf(glaze, "--v2-cal-n")]).toEqual(["1", "2"]);
  });

  // Seven column lines in both grid layouts, so an all day bar's day indices
  // stay valid: the three day layout only narrows the days that are not near to
  // nothing. Which days are near is the view's word, not a measurement.
  test("gives the stylesheet both sets of day tracks, and marks which days are near", () => {
    paneOf();
    const view = buildCalendarView(sampleWeek(null), [BLOCK]);
    const near = varOf(grid(), "--v2-cal-near").split(/\s+(?=minmax|0px)/);
    expect(near).toEqual(view.days.map((day) => (day.near ? "minmax(0, 1fr)" : "0px")));
    expect(varOf(grid(), "--v2-cal-all").split(/\s+(?=minmax)/)).toEqual(
      view.days.map(() => "minmax(0, 1fr)"),
    );
    const columns = Array.from(grid().querySelectorAll<HTMLElement>(".v2-cal-col"));
    expect(columns.map((column) => column.getAttribute("data-near"))).toEqual(
      view.days.map((day) => (day.near ? "yes" : "no")),
    );
  });

  test("hides an all day bar in the three day layout only when it touches no near day", () => {
    // The near days are Wednesday to Friday. The maintenance runs Thursday to
    // Saturday, so part of it is near; an open day on Monday is not near at all.
    const data = sampleWeek(null);
    const template = data.events.find((event) => event.allDay);
    if (template === undefined) throw new Error("the sample has no all day event");
    paneOf({
      ...data,
      events: [
        ...data.events,
        { ...template, id: "x-open", title: "Open studio", start: "2026-04-13", end: "2026-04-14" },
      ],
    });
    const near = new Map(
      Array.from(grid().querySelectorAll<HTMLElement>(".v2-cal-span")).map((bar) => [
        bar.textContent,
        bar.getAttribute("data-near"),
      ]),
    );
    expect(near.get("Kiln maintenance")).toBe("yes");
    expect(near.get("Library closed for repairs")).toBe("yes");
    expect(near.get("Open studio")).toBe("no");
  });

  test("renders the agenda and the grid both, for the stylesheet to choose between", () => {
    paneOf();
    expect(chipsIn(agenda()).map(titleOf)).toEqual(chipsIn(grid()).map(titleOf));
  });
});

// ---------------------------------------------------------------------------
// Behaviour 8: the now line
// ---------------------------------------------------------------------------

describe("the now line", () => {
  test("is drawn once, in today's column, at the view's fraction, with the word and the clock", () => {
    paneOf();
    const view = buildCalendarView(sampleWeek(null), [BLOCK]);
    const lines = Array.from(document.querySelectorAll<HTMLElement>(".v2-cal-now"));
    expect(lines).toHaveLength(1);
    const [line] = lines;
    expect(line.textContent).toBe(`${CALENDAR_COPY.now} 10:20`);
    expect(varOf(line, "--v2-cal-at")).toBe(String(view.nowTop));
    const column = line.closest(".v2-cal-col");
    expect(column?.querySelector('ul[aria-current="date"]')).not.toBeNull();
  });

  test("is not drawn when the view has no place for it", () => {
    // Before the window opens, and in a week that does not hold today.
    paneOf({ ...sampleWeek(null), now: `${WEDNESDAY}T03:00:00-07:00` });
    expect(document.querySelector(".v2-cal-now")).toBeNull();
    cleanup();
    paneOf(sampleWeek("2026-04-22"), []);
    expect(document.querySelector(".v2-cal-now")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Behaviour 9: the week links
// ---------------------------------------------------------------------------

describe("the week links", () => {
  const hrefs = () =>
    Array.from(document.querySelectorAll<HTMLAnchorElement>(".v2-cal a")).map((link) => [
      link.textContent,
      link.getAttribute("href"),
    ]);

  test("go to the next week only, from a week with nothing behind it", () => {
    paneOf();
    expect(hrefs()).toEqual([[CALENDAR_COPY.next, "/v2/today?week=2026-04-20"]]);
  });

  test("go back, and home to this week, from the week after it", () => {
    paneOf(sampleWeek("2026-04-22"), [], "/v2/week");
    expect(hrefs()).toEqual([
      [CALENDAR_COPY.previous, "/v2/week?week=2026-04-13"],
      [CALENDAR_COPY.thisWeek, "/v2/week?week=2026-04-13"],
    ]);
  });

  test("are plain links in the server's HTML, for a page that has no script yet", () => {
    paneOf();
    const link = document.querySelector<HTMLAnchorElement>(".v2-cal a");
    expect(link?.tagName).toBe("A");
    expect(link?.getAttribute("href")).toMatch(/^\/v2\/today\?week=\d{4}-\d{2}-\d{2}$/);
  });

  // A week link is a soft navigation: Next re-renders the page with the new
  // `?week=` and hands the SAME pane new props (search parameters are not part
  // of a page's state key). So the pane must draw from its props, never from a
  // copy it kept.
  test("draws whatever week its props hold now, without being remounted", () => {
    const { rerender } = paneOf();
    const region = () => screen.getByRole("region", { name: CALENDAR_NAME });
    expect(region().getAttribute("aria-labelledby")).not.toBeNull();
    const before = region();
    rerender(
      createElement(CalendarPane, {
        data: sampleWeek("2026-04-22"),
        planned: [],
        basePath: "/v2/today",
      }),
    );
    expect(region()).toBe(before);
    expect(region().textContent).toContain("20 to 26 April");
    expect(gridDay("Monday 20 April").textContent).toContain("Print shop shift");
  });
});

// ---------------------------------------------------------------------------
// Behaviour 11: on Today, the planned blocks follow the screen
// ---------------------------------------------------------------------------

describe("the pane on Today", () => {
  /**
   * What the pane should be drawing as planned, worked out the way the screen
   * works out its own line: the plan's blocks that are not done or skipped,
   * under the titles the line shows for them.
   */
  function expectedPlanned(data: TodayScreenData, plan: PlanOutput, energy = data.input.energy) {
    const { input } = data;
    const view = buildTodayView({
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
    const titles = new Map(
      view.stops.filter((stop) => stop.source === "block").map((stop) => [stop.id, stop.title]),
    );
    return {
      view,
      titles: plan.blocks
        .filter((block) => block.state !== "done" && block.state !== "skipped")
        .map((block) => titles.get(block.id) ?? block.title)
        .sort(),
    };
  }

  const drawnPlanned = () =>
    chipsIn(grid())
      .filter((chip) => chip.getAttribute("data-kind") === "planned")
      .map(titleOf)
      .sort();

  const press = async (name: string) => {
    const button = screen.getByRole("button", { name });
    await act(async () => {
      fireEvent.click(button);
    });
  };

  test("draws the plan's blocks under the titles the line shows", () => {
    const data = sampleDay();
    render(createElement(TodayClient, { data }));
    const { titles } = expectedPlanned(data, planDay(data.input));
    expect(titles.length).toBeGreaterThan(1);
    expect(drawnPlanned()).toEqual(titles);
  });

  test("takes a block off the calendar in the same render that Not today does", async () => {
    const data = sampleDay();
    render(createElement(TodayClient, { data }));
    const first = planDay(data.input);
    const { view } = expectedPlanned(data, first);
    const lit = view.stops.find((stop) => stop.id === view.litStopId);
    expect(lit?.source).toBe("block");
    expect(drawnPlanned()).toContain(lit?.title);

    await press(TODAY_COPY.notToday);

    const skipped: Block[] = first.blocks.map((block) =>
      block.id === lit?.id ? { ...block, state: "skipped" } : block,
    );
    const after = planDay({ ...data.input, energy: data.input.energy, existing: skipped });
    expect(drawnPlanned()).toEqual(expectedPlanned(data, after).titles);
    expect(drawnPlanned()).not.toContain(lit?.title);
  });

  test("follows an energy answer in the same render", async () => {
    const data = sampleDay();
    render(createElement(TodayClient, { data }));
    const first = planDay(data.input);
    const before = drawnPlanned();

    await press("Low");

    const after = planDay({ ...data.input, energy: "low", existing: first.blocks });
    const expected = expectedPlanned(data, after, "low").titles;
    expect(drawnPlanned()).toEqual(expected);
    // The answer has to have changed the day for this to mean anything.
    expect(expected).not.toEqual(before);
  });

  // What a week link does to Today: the page re-renders with the calendar of
  // another week and the same client component gets the new data. The day's
  // presses live in that component's state, so they have to survive it.
  test("keeps the day's presses when the calendar beside it changes week", async () => {
    const data = sampleDay();
    const { rerender } = render(createElement(TodayClient, { data }));
    await press(TODAY_COPY.notToday);
    const said = document.querySelector('[role="status"]')?.textContent ?? "";
    const planned = drawnPlanned();
    expect(said).toContain(TODAY_COPY.acted.skipped);

    rerender(createElement(TodayClient, { data: { ...data, calendar: sampleWeek("2026-04-22") } }));

    expect(document.querySelector('[role="status"]')?.textContent).toBe(said);
    expect(screen.getByRole("region", { name: CALENDAR_NAME }).textContent).toContain(
      "20 to 26 April",
    );
    // The blocks are today's, and today is not in that week: nothing to draw.
    expect(drawnPlanned()).toEqual([]);

    rerender(createElement(TodayClient, { data }));
    expect(drawnPlanned()).toEqual(planned);
  });

  test("draws no pane at all when the source has no calendar", () => {
    const { container } = render(
      createElement(TodayClient, { data: { ...sampleDay(), calendar: null } }),
    );
    expect(container.querySelector(".v2-cal")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Behaviour 13: navigation
// ---------------------------------------------------------------------------

describe("the rail", () => {
  const items = () =>
    Array.from(document.querySelectorAll<HTMLElement>(".v2-nav-items > *")).map((item) => ({
      text: item.textContent,
      tag: item.tagName,
      href: item.getAttribute("href"),
      current: item.getAttribute("aria-current"),
      disabled: (item as HTMLButtonElement).disabled ?? false,
    }));

  test("links Today and Week, and marks the page it is on", () => {
    render(createElement(NavBar, { current: "/v2/today" }));
    expect(items()).toEqual([
      { text: "Today", tag: "A", href: "/v2/today", current: "page", disabled: false },
      { text: "Week", tag: "A", href: "/v2/week", current: null, disabled: false },
      { text: "Quests", tag: "BUTTON", href: null, current: null, disabled: true },
      { text: "Money", tag: "BUTTON", href: null, current: null, disabled: true },
    ]);
    expect(TODAY_COPY.navItems).toEqual(["Today", "Week", "Quests", "Money"]);
  });

  test("marks Week when it is on the Week page", () => {
    render(createElement(NavBar, { current: "/v2/week" }));
    const current = items().filter((item) => item.current === "page");
    expect(current.map((item) => item.text)).toEqual(["Week"]);
  });
});

// ---------------------------------------------------------------------------
// The stylesheet: behaviours 4, 5, 6 and 7, and the motion rules
// ---------------------------------------------------------------------------

describe("calendar.css", () => {
  const CSS = readFileSync(path.join(ROOT, "app/v2/calendar.css"), "utf8");
  const sheet = postcss.parse(CSS, { from: "app/v2/calendar.css" });

  /**
   * The last value one selector is given for one property: at the top level when
   * `at` is null, otherwise inside the at-rule written exactly as `at`.
   */
  function declOf(selector: string, prop: string, at: string | null = null): string | null {
    let found: string | null = null;
    sheet.walkRules((rule) => {
      const parent = rule.parent;
      const inside = parent?.type === "atrule" ? (parent as AtRule) : null;
      if (at === null ? inside !== null : inside === null || `@${inside.name} ${inside.params}` !== at) {
        return;
      }
      if (!rule.selectors.map((one) => one.trim()).includes(`[data-v2-root] ${selector}`)) return;
      rule.walkDecls(prop, (decl) => {
        found = decl.value;
      });
    });
    return found;
  }

  const AT_480 = "@container v2-cal (min-width: 480px)";
  const AT_3_DAYS = "@container v2-cal (min-width: 480px) and (max-width: 759.98px)";
  const AT_760 = "@container v2-cal (min-width: 760px)";

  test("parses", () => {
    expect(sheet.nodes.length).toBeGreaterThan(0);
  });

  test("sizes the pane by its own width: a named inline size container", () => {
    expect(declOf(".v2-cal", "container-type")).toBe("inline-size");
    expect(declOf(".v2-cal", "container-name")).toBe("v2-cal");
    // And no media query decides the pane's layout: the window is not its width.
    sheet.walkAtRules("media", (media) => {
      media.walkRules((rule) => {
        for (const selector of rule.selectors) {
          expect(selector, media.params).not.toMatch(/\.v2-cal-(agenda|grid|col|day)\b/);
        }
      });
    });
  });

  test("is an agenda under 480, and the grid from there, never both", () => {
    expect(declOf(".v2-cal-grid", "display")).toBe("none");
    expect(declOf(".v2-cal-agenda", "display")).not.toBe("none");
    expect(declOf(".v2-cal-agenda", "display", AT_480)).toBe("none");
    expect(declOf(".v2-cal-grid", "display", AT_480)).toBe("flex");
  });

  test("shows only the near days from 480, and all seven from 760", () => {
    expect(declOf(".v2-cal-grid", "--v2-cal-tracks")).toBe("var(--v2-cal-near)");
    expect(declOf('.v2-cal-grid [data-near="no"]', "display", AT_3_DAYS)).toBe("none");
    expect(declOf(".v2-cal-grid", "--v2-cal-tracks", AT_760)).toBe("var(--v2-cal-all)");
    // The near-only rule must not reach past 760.
    expect(declOf('.v2-cal-grid [data-near="no"]', "display", AT_480)).toBeNull();
    expect(declOf('.v2-cal-grid [data-near="no"]', "display")).toBeNull();
  });

  test("never lets an hour be shorter than 28px, and scrolls inside the pane", () => {
    expect(declOf(".v2-cal-canvas", "min-height")).toMatch(/var\(--v2-cal-rows\)\s*\*\s*28px/);
    expect(declOf(".v2-cal-grid", "overflow-y")).toBe("auto");
    expect(declOf(".v2-cal-grid", "min-height")).toBe("0");
    expect(declOf(".v2-cal-agenda", "overflow-y")).toBe("auto");
    // The weekday row and the all day row stay put while the hours scroll.
    expect(declOf(".v2-cal-top", "position")).toBe("sticky");
    expect(declOf(".v2-cal-top", "top")).toBe("0");
    // The pane itself never scrolls the page.
    expect(declOf(".v2-cal", "min-height")).toBe("0");
  });

  test("draws a scroller's focus ring inside it, where the window cannot cut it", () => {
    expect(declOf(".v2-cal-grid:focus-visible", "outline-offset")).toBe("-2px");
    expect(declOf(".v2-cal-agenda:focus-visible", "outline-offset")).toBe("-2px");
    expect(declOf(".v2-cal-link:focus-visible", "outline")).toContain("var(--v2-accent)");
  });

  test("fills a chip from its identity and marks its leading edge in the lane colour", () => {
    expect(declOf(".v2-cal-chip", "background")).toBe("var(--v2-lit)");
    expect(declOf(".v2-cal-chip", "border-inline-start")).toContain("var(--v2-lane)");
    expect(declOf(".v2-cal-chip", "color")).toBe("var(--v2-ink)");
  });

  test("draws a planned chip with no fill and a dashed outline in the accent", () => {
    const planned = '.v2-cal-chip[data-kind="planned"]';
    expect(declOf(planned, "background")).toBe("transparent");
    const border = declOf(planned, "border") ?? "";
    expect(border).toContain("dashed");
    expect(border).toContain("var(--v2-accent)");
  });

  test("keeps every word of a chip inside the chip", () => {
    expect(declOf(".v2-cal-chip", "overflow")).toBe("hidden");
    expect(declOf(".v2-cal-chip", "min-width")).toBe("0");
    expect(declOf(".v2-cal-chip-title", "overflow-wrap")).toBe("anywhere");
    expect(declOf(".v2-cal-col", "min-width")).toBe("0");
  });

  // A short chip shows its title alone. Lines that do not fit WRAP into a second
  // column, which the chip's own overflow clips, so they leave whole rather
  // than being cut through the middle and stay in the accessibility tree; the
  // title drops to one line once two would not fit beside the time.
  test("shows a chip too short for two lines as its title alone, without measuring", () => {
    expect(declOf(".v2-cal-col .v2-cal-chip", "flex-flow")).toBe("column wrap");
    expect(declOf(".v2-cal-col .v2-cal-chip", "container-type")).toBe("size");
    expect(declOf(".v2-cal-col .v2-cal-chip", "container-name")).toBe("v2-chip");
    let clamp: string | null = null;
    sheet.walkAtRules("container", (at) => {
      if (!/^v2-chip \(max-height: \d+(\.\d+)?px\)$/.test(at.params)) return;
      at.walkDecls("line-clamp", (decl) => {
        clamp = decl.value;
      });
    });
    expect(clamp).toBe("1");
  });

  test("moves only on hover, at the screen's own speeds, and never on load", () => {
    const transitions: string[] = [];
    sheet.walkDecls(/^transition/, (decl) => {
      // The reduced motion block is the one place a duration is not a token:
      // it is the switch that turns them all off.
      const block = decl.parent?.parent;
      const reduced =
        block?.type === "atrule" &&
        (block as AtRule).params.includes("prefers-reduced-motion");
      if (!reduced) transitions.push(decl.value);
    });
    expect(transitions.length).toBeGreaterThan(0);
    for (const value of transitions) {
      expect(value).toMatch(/var\(--v2-(quick|std|slow)\)/);
      expect(value).toMatch(/var\(--v2-ease\)/);
    }
    const animations: string[] = [];
    sheet.walkDecls(/^animation/, (decl) => {
      animations.push(decl.value);
    });
    sheet.walkAtRules("keyframes", (at) => {
      animations.push(at.params);
    });
    expect(animations).toEqual([]);
  });

  test("stops all of it under reduced motion", () => {
    let covered = false;
    sheet.walkAtRules("media", (media) => {
      if (!media.params.includes("prefers-reduced-motion: reduce")) return;
      media.walkRules((rule) => {
        if (!rule.selectors.some((one) => one.includes(".v2-cal"))) return;
        rule.walkDecls("transition-duration", () => {
          covered = true;
        });
      });
    });
    expect(covered).toBe(true);
  });

  test("brings no font of its own", () => {
    expect(CSS).not.toMatch(/@font-face|@import/);
    sheet.walkDecls(/^font(-family)?$/, (decl) => {
      expect(decl.value, decl.toString()).toMatch(/var\(--v2-(display|text)\)/);
    });
  });

  test("writes times in figures that do not shift", () => {
    for (const selector of [".v2-cal-chip-time", ".v2-cal-gutter span", ".v2-cal-now span"]) {
      expect(declOf(selector, "font-variant-numeric"), selector).toBe("tabular-nums");
    }
  });
});
