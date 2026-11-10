// Task 8, the sample day. The Today screen runs on this and nothing else, so
// these tests are what stands in for a database: the sample has to be a real
// PlanInput that the real planner can plan, and the screen it produces has to
// be worth looking at.
//
// The planner is being changed in parallel, so nothing here asserts a clock.
// What is asserted is the SHAPE the screen needs: a lit block to press, a past
// stop above the line, an all day event, a leave by, something not taken today,
// and three energies that visibly differ.

import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { hydrateRoot, type Root } from "react-dom/client";

import postcss from "postcss";

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { TodayClient } from "@/app/v2/today/today-client";
import { planReference } from "@/app/lib/v2/plan/day";
import { planDay } from "@/app/lib/v2/plan/planner";
import { fixturesEnabled, sampleDay } from "@/app/lib/v2/fixtures/sample-day";
import {
  STOP_STATUS_COPY,
  TODAY_COPY,
  buildTodayView,
  showMoreLabel,
  type TodayView,
} from "@/app/lib/v2/view/today";
import {
  APPEARANCE_COPY,
  APPEARANCE_STORAGE_KEY,
  CUSTOM_SCHEME_ID,
  DEFAULT_APPEARANCE,
  DEFAULT_SCHEME_ID,
  SCHEMES,
  TOKEN_NAMES,
  deriveTokens,
  pageAdjustment,
  tokensFor,
  type Appearance,
} from "@/app/lib/v2/view/appearance";
import {
  AppearanceRoot,
  AppearanceTrigger,
} from "@/app/v2/_components/appearance-root";
import { AllDayRow } from "@/app/v2/_components/all-day-row";
import { FeedDots } from "@/app/v2/_components/feed-strip";
import { NotTodayList } from "@/app/v2/_components/not-today-list";
import type { Block, Energy, PlanInput } from "@/app/lib/v2/types";
import type { TodayScreenData } from "@/app/lib/v2/view/screen-data";

const LANE_LABELS = ["Study", "Work", "Money", "People", "Craft", "Body"];

/**
 * The instant the screen judges "past its date" from: the planner's own
 * reference, through the one exported function the planner, the screen and
 * this helper all call.
 */
function referenceOf(input: PlanInput): string {
  return planReference(input.now, input.date, input.rules).instant;
}

function viewOf(energy: Energy | null, existing: Block[] = []): TodayView {
  const sample = sampleDay();
  const input: PlanInput = { ...sample.input, energy, existing };
  const plan = planDay(input);
  return buildTodayView({
    date: input.date,
    now: input.now,
    reference: referenceOf(input),
    timeZone: input.rules.timeZone,
    plan,
    fixed: input.fixed,
    lanes: sample.lanes,
    candidates: input.candidates,
    feeds: sample.feeds,
    feedLabels: sample.feedLabels,
    openAsks: sample.openAsks,
    tags: sample.tags,
    notice: sample.notice,
    energy,
  });
}

/** Every string anywhere in a value, so the copy rules can be walked. */
function strings(value: unknown, into: string[] = []): string[] {
  if (typeof value === "string") into.push(value);
  else if (Array.isArray(value)) for (const item of value) strings(item, into);
  else if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) strings(item, into);
  }
  return into;
}

describe("the sample day is a real plan input", () => {
  test("is deterministic, so the screen renders the same every time", () => {
    expect(sampleDay()).toEqual(sampleDay());
    const a = sampleDay();
    expect(planDay(a.input)).toEqual(planDay(sampleDay().input));
  });

  test("is anchored to a fixed invented instant, not to the clock", () => {
    const { input } = sampleDay();
    expect(input.now).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
    expect(input.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // now falls on the day being planned, mid morning.
    expect(input.now.startsWith(input.date)).toBe(true);
    expect(Number(input.now.slice(11, 13))).toBeGreaterThanOrEqual(9);
    expect(Number(input.now.slice(11, 13))).toBeLessThan(12);
  });

  test("runs in a zone of its own, never the owner's", () => {
    const { input } = sampleDay();
    expect(input.rules.timeZone).not.toBe("America/Vancouver");
    expect(() => new Intl.DateTimeFormat("en-US", { timeZone: input.rules.timeZone })).not.toThrow();
  });

  test("has six lanes with the invented names and six distinct colours", () => {
    const { lanes } = sampleDay();
    expect(lanes.map((lane) => lane.label)).toEqual(LANE_LABELS);
    expect(new Set(lanes.map((lane) => lane.color)).size).toBe(6);
    for (const lane of lanes) expect(lane.color).toMatch(/^#[0-9A-Fa-f]{6}$/);
  });

  test("gives every lane something of its own to carry", () => {
    const { input, lanes } = sampleDay();
    const used = new Set(input.candidates.map((candidate) => candidate.lane));
    for (const lane of lanes) {
      const owned = lane.key === input.rules.incomeTarget?.lane || used.has(lane.key);
      expect(owned).toBe(true);
    }
  });

  test("carries timed fixed events and at least one all day event", () => {
    const { input } = sampleDay();
    expect(input.fixed.some((event) => event.allDay)).toBe(true);
    expect(input.fixed.filter((event) => !event.allDay).length).toBeGreaterThanOrEqual(2);
  });

  test("has five feeds alive and one failing, so the strip says something", () => {
    const { feeds, feedLabels } = sampleDay();
    expect(feeds).toHaveLength(6);
    expect(feeds.filter((status) => status.state === "alive")).toHaveLength(5);
    expect(feeds.filter((status) => status.state !== "alive")).toHaveLength(1);
    for (const status of feeds) expect(feedLabels[status.feed]).toBeTruthy();
  });

  test("has the morning energy question open", () => {
    const { openAsks } = sampleDay();
    const energy = openAsks.find((ask) => ask.kind === "energy" && ask.status === "open");
    expect(energy).toBeDefined();
    expect(energy?.options.map((option) => option.label)).toEqual(["Low", "OK", "Good"]);
  });

  test("plans into a day with room left, not a wall of blocks", () => {
    const plan = planDay(sampleDay().input);
    expect(plan.blocks.length).toBeGreaterThanOrEqual(3);
    expect(plan.dropped.length).toBeGreaterThan(0);
  });
});

describe("the screen the sample produces", () => {
  test("is not empty, and names the day", () => {
    const view = viewOf(null);
    expect(view.empty).toBe(false);
    expect(view.dateLabel).toMatch(/^[A-Z][a-z]+ \d{1,2} [A-Z][a-z]+$/);
  });

  test("lights a block, so Start, Done and Not today all do something", () => {
    const view = viewOf(null);
    const lit = view.stops.find((stop) => stop.id === view.litStopId);
    expect(lit).toBeDefined();
    expect(lit?.source).toBe("block");
    expect(lit?.state).toBe("next");
  });

  test("has a past stop above the line and a later one below it", () => {
    const view = viewOf(null);
    expect(view.stops.some((stop) => stop.state === "past")).toBe(true);
    expect(view.stops.some((stop) => stop.state === "later")).toBe(true);
  });

  test("shows an all day event, a leave by and a lane colour", () => {
    const view = viewOf(null);
    expect(view.allDay.length).toBeGreaterThan(0);
    expect(view.stops.some((stop) => stop.leaveBy !== null)).toBe(true);
    expect(view.stops.some((stop) => stop.identity !== null)).toBe(true);
  });

  test("lists what it did not take, with a reason in words", () => {
    const view = viewOf(null);
    expect(view.notToday.length).toBeGreaterThan(0);
    for (const entry of view.notToday) {
      expect(entry.title.length).toBeGreaterThan(0);
      expect(entry.reason.length).toBeGreaterThan(0);
      expect(entry.reason).not.toMatch(/[a-z]-[a-z]/);
    }
  });

  test("says the energy was assumed until it is answered", () => {
    expect(viewOf(null).energy).toMatchObject({ label: "OK, assumed", assumed: true });
    expect(viewOf("good").energy).toMatchObject({ label: "Good", assumed: false });
  });

  test("says what it cannot see", () => {
    const view = viewOf(null);
    expect(view.feed.line).not.toBe("All feeds alive.");
    expect(view.feed.dots).toHaveLength(6);
    expect(view.feed.dots.filter((dot) => dot.state !== "alive")).toHaveLength(1);
  });
});

// Task 11. The sample is now one shape with every other source, so the three
// things that shape carries have to be true of it.
describe("the sample is the one screen shape", () => {
  test("carries a notice saying what it is, and no groups", () => {
    const sample = sampleDay();
    expect(sample.tags).toEqual({});
    expect(sample.notice).toContain("Sample day");
    expect(sample.notice).toContain("nothing you press is saved");
    expect(viewOf(null).notice).toBe(sample.notice);
  });

  test("keeps the lane colours exactly as the prototype set them", () => {
    expect(sampleDay().lanes.map((lane) => lane.color)).toEqual([
      "#7C9BFF",
      "#2FD6A3",
      "#FFB84D",
      "#FF7A8A",
      "#C58BFF",
      "#B8F15A",
    ]);
  });

  test("has one item whose date has gone by, so the section is visible", () => {
    const view = viewOf(null);
    expect(view.pastDue).toHaveLength(1);
    expect(view.pastDue[0].date).toMatch(/^\d{1,2} [A-Z][a-z]+$/);
    // It is named by its lane, because the sample has no groups.
    expect(view.pastDue[0].identity).toMatchObject({ source: "lane" });
    // And it is not also in what did not fit.
    expect(view.notToday.map((entry) => entry.title)).not.toContain(
      view.pastDue[0].title,
    );
  });

  test("summarises the lanes that have something waiting", () => {
    const view = viewOf(null);
    expect(view.lanes.length).toBeGreaterThan(0);
    for (const lane of view.lanes) {
      expect(lane.open).toBeGreaterThan(0);
      expect(lane.label.length).toBeGreaterThan(0);
      if (lane.due !== null) expect(lane.due).toMatch(/^\d{1,2} [A-Z][a-z]+$/);
    }
    // Every sample candidate has a lane, so there is nothing for the last row.
    expect(view.lanes.map((lane) => lane.key)).not.toContain("");
  });

  // So the two levels of a name are visible on the sample screen too, not only
  // on a real account. Invented, like every other string in the fixture.
  test("has at least one title in two levels", () => {
    const withDetail = viewOf(null).stops.filter((stop) => stop.detail !== null);
    expect(withDetail.length).toBeGreaterThan(0);
    for (const stop of withDetail) {
      expect(stop.title.endsWith(")")).toBe(false);
      expect(stop.full).toBe(`${stop.title} (${stop.detail})`);
    }
  });
});

describe("the sample day replans", () => {
  test("gives a different day for each energy", () => {
    const shape = (energy: Energy) =>
      viewOf(energy)
        .stops.map((stop) => `${stop.start} ${stop.title}`)
        .join("|");
    const low = shape("low");
    const ok = shape("ok");
    const good = shape("good");
    expect(new Set([low, ok, good]).size).toBe(3);
  });

  test("takes work off the day on a low day and adds it back on a good one", () => {
    const blocks = (energy: Energy) => planDay({ ...sampleDay().input, energy }).blocks.length;
    expect(blocks("low")).toBeLessThan(blocks("ok"));
    expect(blocks("good")).toBeGreaterThan(blocks("ok"));
  });

  test("is stable when fed its own output, so nothing moves by itself", () => {
    const { input } = sampleDay();
    const first = planDay(input);
    const again = planDay({ ...input, existing: first.blocks });
    expect(again.moved).toEqual([]);
    expect(again.blocks.map((block) => block.id)).toEqual(
      first.blocks.map((block) => block.id),
    );
  });

  test("moves the light to the next stop when the lit block is skipped", () => {
    const { input } = sampleDay();
    const first = planDay(input);
    const view = buildTodayView({
      date: input.date,
      now: input.now,
      reference: referenceOf(input),
      timeZone: input.rules.timeZone,
      plan: first,
      fixed: input.fixed,
      lanes: sampleDay().lanes,
      candidates: input.candidates,
      feeds: sampleDay().feeds,
      feedLabels: sampleDay().feedLabels,
      openAsks: sampleDay().openAsks,
      tags: sampleDay().tags,
      notice: sampleDay().notice,
      energy: input.energy,
    });
    const litId = view.litStopId;
    expect(litId).not.toBeNull();

    const skipped = first.blocks.map((block) =>
      block.id === litId ? { ...block, state: "skipped" as const } : block,
    );
    const after = viewOf(input.energy, skipped);
    expect(after.litStopId).not.toBe(litId);
    expect(after.stops.find((stop) => stop.id === litId)?.state).toBe("skipped");
  });

  test("keeps the started block lit, so Done is the next press", () => {
    const { input } = sampleDay();
    const first = planDay(input);
    const view = viewOf(input.energy);
    const litId = view.litStopId;
    const started = first.blocks.map((block) =>
      block.id === litId ? { ...block, state: "started" as const } : block,
    );
    const after = viewOf(input.energy, started);
    expect(after.litStopId).toBe(litId);
    expect(after.stops.find((stop) => stop.id === litId)?.state).toBe("now");
  });

  test("marks the lit block done and lights another", () => {
    const { input } = sampleDay();
    const first = planDay(input);
    const litId = viewOf(input.energy).litStopId;
    const done = first.blocks.map((block) =>
      block.id === litId ? { ...block, state: "done" as const } : block,
    );
    const after = viewOf(input.energy, done);
    expect(after.stops.find((stop) => stop.id === litId)?.state).toBe("done");
    expect(after.litStopId).not.toBe(litId);
  });
});

describe("the copy rules", () => {
  const everything = [
    ...strings(viewOf(null)),
    ...strings(viewOf("low")),
    ...strings(viewOf("ok")),
    ...strings(viewOf("good")),
    ...strings(TODAY_COPY),
    ...strings(STOP_STATUS_COPY),
  ];

  test("has something to walk", () => {
    expect(everything.length).toBeGreaterThan(40);
  });

  // Built from code points on purpose, so this file stays pure ASCII: a repo
  // wide grep for U+2014 should find the copy that broke the rule, not the test
  // that guards it.
  const EM_DASH = String.fromCodePoint(0x2014);
  const EN_DASH = String.fromCodePoint(0x2013);

  test("uses no em dash and no en dash", () => {
    for (const text of everything) {
      expect(text).not.toContain(EM_DASH);
      expect(text).not.toContain(EN_DASH);
    }
  });

  test("never speaks of streaks, points, levels or penalties", () => {
    for (const text of everything) {
      expect(text).not.toMatch(/\b(streaks?|points?|levels?|penalt(y|ies)|xp)\b/i);
    }
  });
});

// The Today screen renders on the server and again in the browser, whose Intl
// collations differ, so a locale-aware compare can order two things that tie
// differently in the two renders. That is a hydration mismatch and it is
// invisible in a test that only runs one of them, so it is caught statically.
describe("ordering never depends on the locale", () => {
  const owned = [
    "app/lib/v2/view/today.ts",
    "app/lib/v2/view/format.ts",
    "app/lib/v2/fixtures/sample-day.ts",
    "app/v2/layout.tsx",
    "app/v2/today/page.tsx",
    "app/v2/today/today-client.tsx",
    "app/lib/v2/view/appearance.ts",
    "app/v2/_components/all-day-row.tsx",
    "app/v2/_components/appearance-panel.tsx",
    "app/v2/_components/appearance-root.tsx",
    "app/v2/_components/day-header.tsx",
    "app/v2/_components/day-line.tsx",
    "app/v2/_components/energy-row.tsx",
    "app/v2/_components/feed-strip.tsx",
    "app/v2/_components/lane-summary.tsx",
    "app/v2/_components/list-row.tsx",
    "app/v2/_components/stop-card.tsx",
    "app/v2/_components/not-today-list.tsx",
    "app/v2/_components/nav-bar.tsx",
    "app/v2/_components/past-due-list.tsx",
  ];

  // Comments are stripped first: these files explain at length why they do not
  // use localeCompare or an Intl date format, and a guard that cannot tell the
  // warning from the offence would fire on its own documentation.
  const codeOf = (file: string) =>
    readFileSync(path.join(path.resolve(__dirname, ".."), file), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/\/\/.*$/gm, " ");

  test("no file of this screen calls localeCompare", () => {
    expect(owned.filter((file) => codeOf(file).includes("localeCompare"))).toEqual([]);
  });

  // The weekday and the month names are read out of the date key by hand for the
  // same reason: Intl's long formats punctuate differently between engines.
  test("no file of this screen formats a date through Intl itself", () => {
    const offenders = owned.filter((file) =>
      /toLocale(Date|Time)?String|new Intl\./.test(codeOf(file)),
    );
    expect(offenders).toEqual([]);
  });
});

// Focus and the status line are what a keyboard or screen reader user gets
// instead of watching the line re-sort, so they are checked on the real screen.
// JSX would need a .tsx file, and this task owns three .ts ones, hence
// createElement.
describe("the screen keeps your place", () => {
  afterEach(() => {
    cleanup();
  });

  const screenOf = () => render(createElement(TodayClient, { data: sampleDay() }));
  const litHeadings = () =>
    Array.from(document.querySelectorAll("[data-lit-heading]")).map(
      (heading) => heading.textContent ?? "",
    );
  const press = async (name: string) => {
    const button = screen.getByRole("button", { name });
    await act(async () => {
      fireEvent.click(button);
    });
  };

  test("takes nothing on load", () => {
    screenOf();
    expect(document.activeElement).toBe(document.body);
    expect(litHeadings()).toHaveLength(1);
  });

  test("moves focus to the new lit card when a press takes its button away", async () => {
    screenOf();
    await press("Done");
    const focused = document.activeElement as HTMLElement | null;
    expect(focused?.tagName).toBe("H3");
    expect(focused?.hasAttribute("data-lit-heading")).toBe(true);
  });

  // The defect this pins: the focus effect used to watch the lit flag as well as
  // the press counter, so once any press had happened, a later energy press that
  // lit a different card pulled focus off the energy button the user was on.
  test("leaves focus on the energy control, even after an earlier press", async () => {
    screenOf();
    // Two skips put a block on the line that a low day cannot afford, so the
    // next energy press really does change which stop is lit.
    await press("Not today");
    await press("Not today");
    const before = litHeadings();
    expect(before).toHaveLength(1);

    const low = screen.getByRole("button", { name: "Low" });
    low.focus();
    await press("Low");

    // The test only means anything if the lit stop changed.
    expect(litHeadings().some((title) => title !== before[0])).toBe(true);
    expect(document.activeElement).toBe(low);
  });

  test("does not name a started block as its own next stop", async () => {
    screenOf();
    await press("Start");
    const said = document.querySelector('[role="status"]')?.textContent ?? "";
    expect(said.endsWith(" started.")).toBe(true);
    expect(said).not.toContain(TODAY_COPY.next);
  });

  test("says what happened and what is next after a press that moves on", async () => {
    screenOf();
    await press("Done");
    const said = document.querySelector('[role="status"]')?.textContent ?? "";
    expect(said).toContain(TODAY_COPY.acted.done);
    expect(said).toContain(`${TODAY_COPY.next}: `);
  });
});

// Task 11, on the real screen: the two controls that only exist in the DOM, and
// the palette the server ships before any script has run.
describe("the screen the sample renders", () => {
  afterEach(() => {
    cleanup();
  });

  test("renders the sample through the one data prop", () => {
    render(createElement(TodayClient, { data: sampleDay() }));
    expect(screen.getByRole("heading", { level: 1 }).textContent).toMatch(
      /^[A-Z][a-z]+ \d{1,2} [A-Z][a-z]+$/,
    );
    // The notice replaces the old fixed footer line.
    expect(screen.getByText(sampleDay().notice ?? "")).toBeTruthy();
  });

  test("shows the items whose date has gone by, under their own heading", () => {
    render(createElement(TodayClient, { data: sampleDay() }));
    expect(screen.getByRole("heading", { name: TODAY_COPY.pastDueHeading })).toBeTruthy();
    expect(screen.getByText(TODAY_COPY.pastDueLine)).toBeTruthy();
    // Nothing on those rows presses, so the only buttons on the page are the
    // ones that were there before.
    const names = screen
      .getAllByRole("button")
      .map((button) => button.textContent ?? "");
    expect(names).not.toContain(viewOf(null).pastDue[0].title);
  });

  // Eight rows, then one press. A real account has dozens of open tasks.
  describe("the show more control", () => {
    const rows = (count: number) =>
      Array.from({ length: count }, (_, index) => {
        const title = `Task ${index + 1}`;
        return { title, detail: null, full: title, reason: "No room today" };
      });

    test("is absent at eight rows or fewer", () => {
      render(createElement(NotTodayList, { entries: rows(8) }));
      expect(screen.getAllByText(/^Task /)).toHaveLength(8);
      expect(screen.queryByRole("button")).toBeNull();
    });

    test("appears past eight, counts the rest, and reveals them", async () => {
      render(createElement(NotTodayList, { entries: rows(11) }));
      expect(screen.getAllByText(/^Task /)).toHaveLength(8);
      const button = screen.getByRole("button", { name: showMoreLabel(3) });
      await act(async () => {
        fireEvent.click(button);
      });
      expect(screen.getAllByText(/^Task /)).toHaveLength(11);
      expect(screen.queryByRole("button")).toBeNull();
    });
  });

  // Behaviour 13 and 14. With nothing stored, the first render IS black and
  // purple: the attribute says which scheme, and the ten tokens are on the root
  // so the page is painted before the stylesheet's defaults are even needed.
  test("is black and purple on the first render, with nothing stored", () => {
    render(createElement(AppearanceRoot, null, "day"));
    const root = document.querySelector("[data-v2-root]") as HTMLElement | null;
    expect(root).not.toBeNull();
    expect(root?.getAttribute("data-v2-scheme")).toBe(DEFAULT_SCHEME_ID);
    const derived = deriveTokens(SCHEMES[0].background, SCHEMES[0].accent);
    for (const name of TOKEN_NAMES) {
      expect(root?.style.getPropertyValue(name)).toBe(derived[name]);
    }
  });

  // An account with no feeds connected drew an empty rounded pill where the dots
  // would be, in the header and in the side column both.
  test("draws no dot container at all when nothing is being watched", () => {
    const { container } = render(createElement(FeedDots, { dots: [] }));
    expect(container.innerHTML).toBe("");
    cleanup();
    render(createElement(FeedDots, { dots: [{ label: "Calendar", state: "alive" as const }] }));
    expect(screen.getByRole("img", { name: "Calendar: Alive" })).toBeTruthy();
  });

  test("takes focus nowhere when it mounts", () => {
    render(createElement(AppearanceRoot, null, "day"));
    expect(document.activeElement).toBe(document.body);
  });

  // Behaviours 14 and 15, end to end: nothing else exercises the panel, the
  // store, or the write to this browser. It runs LAST in this describe and puts
  // the scheme back, because the store is module level and would otherwise leak
  // Paper into whatever runs after it.
  test("opens from the rail, applies a scheme, stores it, and hands focus back", async () => {
    render(
      createElement(
        AppearanceRoot,
        null,
        createElement(TodayClient, { data: sampleDay() }),
      ),
    );
    const root = document.querySelector("[data-v2-root]") as HTMLElement;

    // Two triggers, one per layout, each hidden at the other's width. The rail's
    // comes first because the rail comes first in the document.
    const triggers = screen.getAllByRole("button", { name: APPEARANCE_COPY.open });
    expect(triggers).toHaveLength(2);
    const rail = triggers[0];

    await act(async () => {
      fireEvent.click(rail);
    });
    const panel = screen.getByRole("dialog");
    expect(panel.getAttribute("aria-modal")).toBe("true");
    expect(document.activeElement).toBe(panel);

    const paper = SCHEMES[3];
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: paper.name }));
    });
    expect(root.getAttribute("data-v2-scheme")).toBe(paper.id);
    expect(root.style.getPropertyValue("--v2-page")).toBe(paper.background);
    expect(root.style.getPropertyValue("--v2-ink")).toBe(
      deriveTokens(paper.background, paper.accent)["--v2-ink"],
    );
    expect(JSON.parse(localStorage.getItem(APPEARANCE_STORAGE_KEY) ?? "null")).toEqual({
      schemeId: paper.id,
      background: null,
      accent: null,
    });

    // A custom pair keeps the attribute in step too, under "custom".
    await act(async () => {
      fireEvent.change(screen.getByLabelText(APPEARANCE_COPY.background), {
        target: { value: "#120a1f" },
      });
    });
    expect(root.getAttribute("data-v2-scheme")).toBe(CUSTOM_SCHEME_ID);
    expect(root.style.getPropertyValue("--v2-page")).toBe("#120A1F");
    // The accent came from the scheme that was on, not from a reset to black.
    expect(JSON.parse(localStorage.getItem(APPEARANCE_STORAGE_KEY) ?? "null")).toEqual({
      schemeId: CUSTOM_SCHEME_ID,
      background: "#120A1F",
      accent: paper.accent,
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: APPEARANCE_COPY.reset }));
    });
    expect(root.getAttribute("data-v2-scheme")).toBe(DEFAULT_SCHEME_ID);
    expect(root.style.getPropertyValue("--v2-page")).toBe(SCHEMES[0].background);

    await act(async () => {
      fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(rail);
  });
});

describe("the fixtures gate", () => {
  test("opens only when the flag is on", () => {
    expect(fixturesEnabled({ V2_FIXTURES: "1" })).toBe(true);
    expect(fixturesEnabled({})).toBe(false);
    expect(fixturesEnabled({ V2_FIXTURES: "0" })).toBe(false);
    expect(fixturesEnabled({ V2_FIXTURES: "true" })).toBe(false);
  });

  test("never opens in production, whatever the flag says", () => {
    expect(fixturesEnabled({ V2_FIXTURES: "1", VERCEL_ENV: "production" })).toBe(false);
    // A Vercel preview is a production BUILD, and showing the sample on a
    // preview is the point of this route, so the test is on the environment.
    expect(fixturesEnabled({ V2_FIXTURES: "1", VERCEL_ENV: "preview" })).toBe(true);
    expect(fixturesEnabled({ V2_FIXTURES: "1", VERCEL_ENV: "development" })).toBe(true);
  });
});

// The pure gate above is only half of it: the page has to read the right two
// variables and actually refuse. notFound() works by throwing, so a page that
// forgot to call it, or read the wrong name, returns an element instead.
//
// V2_LOCAL_SNAPSHOT is stubbed empty wherever a refusal is expected. The page
// has a third mode now: with the fixtures flag off and that variable pointing at
// a folder, it takes the local snapshot branch instead of refusing. Without the
// stub these tests would pass or fail on whatever the developer's shell happens
// to have exported, which is not a property of this code at all.
describe("the page is wired to the gate", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /** notFound() works by throwing; this is the error it throws. */
  const NOT_FOUND_DIGEST = "NEXT_HTTP_ERROR_FALLBACK;404";

  const digestOf = (run: () => unknown): string => {
    try {
      run();
    } catch (error) {
      return String((error as { digest?: unknown }).digest ?? "no digest");
    }
    return "nothing was thrown";
  };

  // toBeTruthy() on the returned element passed whichever branch the page took,
  // which is the one thing this test exists to tell apart: the page has a local
  // snapshot branch now, and that returns an element too.
  test("renders the sample day with the flag on", async () => {
    vi.stubEnv("V2_FIXTURES", "1");
    vi.stubEnv("V2_LOCAL_SNAPSHOT", "");
    vi.stubEnv("VERCEL_ENV", "preview");
    const { default: TodayPage } = await import("@/app/v2/today/page");
    const element = TodayPage() as {
      type?: { name?: string };
      props?: { data?: unknown; dir?: unknown };
    };
    // What tells the two branches apart is what they are handed: the sample
    // branch gives the screen the sample day itself, with no request check in
    // front of it (the sample is invented data and exists to be shown on a
    // preview), and the snapshot branch is always handed a folder.
    expect(element.type?.name).toBe("TodayClient");
    expect(element.props?.data).toEqual(sampleDay());
    expect(element.props?.dir).toBeUndefined();
  });

  test("is not found with the flag off and no snapshot folder", async () => {
    vi.stubEnv("V2_FIXTURES", "");
    vi.stubEnv("V2_LOCAL_SNAPSHOT", "");
    vi.stubEnv("VERCEL_ENV", "preview");
    const { default: TodayPage } = await import("@/app/v2/today/page");
    // The 404, and not merely "something was thrown": a bare toThrow() passed on
    // any error at all, including one from the gate being misread.
    expect(digestOf(TodayPage)).toBe(NOT_FOUND_DIGEST);
  });

  test("is not found in production, flag or no flag", async () => {
    vi.stubEnv("V2_FIXTURES", "1");
    vi.stubEnv("V2_LOCAL_SNAPSHOT", "");
    vi.stubEnv("VERCEL_ENV", "production");
    const { default: TodayPage } = await import("@/app/v2/today/page");
    expect(digestOf(TodayPage)).toBe(NOT_FOUND_DIGEST);
  });

  test("asks to be rendered per request, so the gate is never prerendered", async () => {
    vi.stubEnv("V2_FIXTURES", "1");
    vi.stubEnv("VERCEL_ENV", "preview");
    const page = await import("@/app/v2/today/page");
    expect(page.dynamic).toBe("force-dynamic");
  });
});

// ===========================================================================
// Round 2: the dialog, and the store
//
// The review found that Escape and the Tab trap only worked while focus was
// inside the panel, and focus leaves: the veil catches clicks but is not
// focusable, so a press on it dropped focus to the body and from there Escape
// did nothing and Tab walked the page behind a window calling itself modal.
// Both listen on the document now, and a press on the veil closes.
//
// It also found that the only root test ran with nothing stored, so the storage
// failure paths and the after-hydration apply were never exercised.
// ===========================================================================

const FOCUSABLE_IN_PANEL = [
  "button:not([disabled])",
  "input:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

describe("the appearance panel is really a dialog", () => {
  afterEach(() => {
    cleanup();
    try {
      localStorage.clear();
    } catch {
      // nothing to clean up
    }
  });

  /** The panel, open, with the rail's trigger as the thing that opened it. */
  const openPanel = async () => {
    render(
      createElement(
        AppearanceRoot,
        null,
        createElement(AppearanceTrigger, { variant: "rail" }),
      ),
    );
    const trigger = screen.getByRole("button", { name: APPEARANCE_COPY.open });
    await act(async () => {
      fireEvent.click(trigger);
    });
    const panel = screen.getByRole("dialog");
    const veil = panel.parentElement as HTMLElement;
    return { trigger, panel, veil };
  };

  const focusablesOf = (panel: HTMLElement) =>
    Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_IN_PANEL));

  // The press's default is prevented, and that is the part jsdom cannot show by
  // itself: a real browser moves focus to the body as the press's default
  // action, AFTER the handler handed it back to the trigger, and jsdom has no
  // such default. fireEvent returns false exactly when it was prevented.
  test("closes on a press on the veil, and hands focus back", async () => {
    const { trigger, veil } = await openPanel();
    let allowed = true;
    await act(async () => {
      allowed = fireEvent.mouseDown(veil);
    });
    expect(allowed).toBe(false);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  // A drag that starts on a control and ends on the veil must not close
  // anything, which is why it is mousedown with target === currentTarget. And
  // its default is left alone, or pressing a control would stop focusing it.
  test("does not close on a press that starts on a control inside it", async () => {
    const { panel } = await openPanel();
    let allowed = false;
    await act(async () => {
      allowed = fireEvent.mouseDown(
        screen.getByRole("button", { name: SCHEMES[0].name }),
      );
    });
    expect(allowed).toBe(true);
    expect(screen.getByRole("dialog")).toBe(panel);
  });

  test("closes on Escape even when focus has left it", async () => {
    const { trigger, panel } = await openPanel();
    (panel as HTMLElement).blur();
    expect(document.activeElement).toBe(document.body);
    await act(async () => {
      fireEvent.keyDown(document.body, { key: "Escape" });
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  test("pulls focus back into itself when Tab is pressed from outside", async () => {
    const { panel } = await openPanel();
    const inside = focusablesOf(panel);
    expect(inside.length).toBeGreaterThan(2);

    panel.blur();
    expect(document.activeElement).toBe(document.body);
    await act(async () => {
      fireEvent.keyDown(document.body, { key: "Tab" });
    });
    expect(document.activeElement).toBe(inside[0]);

    (document.activeElement as HTMLElement).blur();
    await act(async () => {
      fireEvent.keyDown(document.body, { key: "Tab", shiftKey: true });
    });
    expect(document.activeElement).toBe(inside[inside.length - 1]);
  });

  test("still wraps at its own edges", async () => {
    const { panel } = await openPanel();
    const inside = focusablesOf(panel);
    const first = inside[0];
    const last = inside[inside.length - 1];

    last.focus();
    await act(async () => {
      fireEvent.keyDown(last, { key: "Tab" });
    });
    expect(document.activeElement).toBe(first);

    await act(async () => {
      fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    });
    expect(document.activeElement).toBe(last);
  });

  // R4. A background in the middle of the range cannot carry readable text, so
  // the painted page moves; the panel says so rather than letting the page come
  // out a colour the input does not show.
  test("says when the page had to move, and says nothing when it did not", async () => {
    const { panel } = await openPanel();
    const line = () =>
      (panel.querySelector('[aria-live="polite"]') as HTMLElement).textContent ?? "";

    for (const scheme of SCHEMES) {
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: scheme.name }));
      });
      expect(line()).toBe("");
    }

    await act(async () => {
      fireEvent.change(screen.getByLabelText(APPEARANCE_COPY.background), {
        target: { value: "#777777" },
      });
    });
    expect(line()).toBe(APPEARANCE_COPY.lightened);
    expect(pageAdjustment("#777777", SCHEMES[3].accent)).not.toBeNull();

    // And it goes away again when a scheme that does not need it is picked.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: SCHEMES[0].name }));
    });
    expect(line()).toBe("");
  });
});

// Each test gets its own module instance, because the store that holds the
// stored choice is module level: a cache left behind by one test would decide
// the next one's first render.
describe("the appearance root and this browser's storage", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    try {
      localStorage.clear();
    } catch {
      // nothing to clean up
    }
  });

  // Both components come from the SAME fresh module instance: the context that
  // carries the handle is module level, so a trigger from the statically
  // imported copy would read the inert fallback and never open anything.
  const freshRoot = async () => {
    vi.resetModules();
    return import("@/app/v2/_components/appearance-root");
  };

  const rootEl = () => document.querySelector("[data-v2-root]") as HTMLElement;

  const expectTokens = (element: HTMLElement, appearance: Appearance) => {
    const want = tokensFor(appearance);
    for (const name of TOKEN_NAMES) {
      expect(element.style.getPropertyValue(name)).toBe(want[name]);
    }
  };

  test("renders the default scheme when reading storage throws", async () => {
    const getItem = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => {
        throw new Error("site data blocked");
      });
    const fresh = await freshRoot();
    expect(() =>
      render(
        createElement(
          fresh.AppearanceRoot,
          null,
          createElement(fresh.AppearanceTrigger, { variant: "rail" }),
        ),
      ),
    ).not.toThrow();
    expect(rootEl().getAttribute("data-v2-scheme")).toBe(DEFAULT_SCHEME_ID);
    expectTokens(rootEl(), DEFAULT_APPEARANCE);
    expect(getItem).toHaveBeenCalled();
  });

  test("still applies a choice for this session when writing storage throws", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    const fresh = await freshRoot();
    render(
      createElement(
        fresh.AppearanceRoot,
        null,
        createElement(fresh.AppearanceTrigger, { variant: "rail" }),
      ),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: APPEARANCE_COPY.open }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: SCHEMES[2].name }));
    });
    expect(rootEl().getAttribute("data-v2-scheme")).toBe(SCHEMES[2].id);
    expectTokens(rootEl(), {
      schemeId: SCHEMES[2].id,
      background: null,
      accent: null,
    });
  });

  /**
   * Hydration, for real: the markup comes from `renderToString`, which is what
   * the server actually sends, and a module instance that ALREADY has the choice
   * in storage hydrates it. React uses `getServerSnapshot` for the server render
   * and for the hydrating render, then the browser's own value immediately
   * after, so a mismatch would surface as a console.error and nothing else.
   *
   * It is deliberately one module instance and not two: an earlier version built
   * the "server" markup from a CLIENT render, and React then reported a style
   * mismatch whose two sides were identical, because a client render writes
   * custom properties through setProperty and the hydration diff cannot read
   * them back the same way. Real server markup does not have that problem (a
   * probe on a plain div with a custom property was silent both ways), so the
   * defect was in the harness, not in the page.
   */
  const hydrateWith = async (stored: Appearance) => {
    vi.resetModules();
    localStorage.clear();
    localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify(stored));
    const { AppearanceRoot: Root } = await freshRoot();
    const { renderToString } = await import("react-dom/server");

    const element = createElement(Root, null, "day");
    const host = document.createElement("div");
    document.body.appendChild(host);
    host.innerHTML = renderToString(element);

    // The server paints the DEFAULT whatever is stored, which is the other half
    // of the no flash guarantee: the HTML never carries a browser's own choice.
    const served = host.querySelector("[data-v2-root]") as HTMLElement;
    expect(served.getAttribute("data-v2-scheme")).toBe(DEFAULT_SCHEME_ID);

    const seen: string[] = [];
    const errors = vi
      .spyOn(console, "error")
      .mockImplementation((...args: unknown[]) => {
        seen.push(String(args[0]));
      });
    let client: Root | null = null;
    await act(async () => {
      client = hydrateRoot(host, element);
    });
    return { host, errors, seen, client: client as unknown as Root };
  };

  /**
   * Every hydrated root is unmounted and its host removed. They used to be left
   * in the document, so these tests held live React roots over a module level
   * store and the next test's result depended on the order they ran in.
   * `cleanup()` does not help: these roots are not testing-library's.
   */
  const done = (held: { host: HTMLElement; client: Root }) => {
    act(() => {
      held.client.unmount();
    });
    held.host.remove();
  };

  test("applies a stored built in scheme after hydration, quietly", async () => {
    const stored: Appearance = {
      schemeId: "paper-ink",
      background: null,
      accent: null,
    };
    const held = await hydrateWith(stored);
    const root = held.host.querySelector("[data-v2-root]") as HTMLElement;
    expect(root.getAttribute("data-v2-scheme")).toBe("paper-ink");
    expectTokens(root, stored);
    expect(held.seen).toEqual([]);
    expect(held.errors).not.toHaveBeenCalled();
    done(held);
  });

  test("applies a stored custom pair after hydration, quietly", async () => {
    const stored: Appearance = {
      schemeId: CUSTOM_SCHEME_ID,
      background: "#120A1F",
      accent: "#FF8A3D",
    };
    const held = await hydrateWith(stored);
    const root = held.host.querySelector("[data-v2-root]") as HTMLElement;
    expect(root.getAttribute("data-v2-scheme")).toBe(CUSTOM_SCHEME_ID);
    expectTokens(root, stored);
    expect(held.errors).not.toHaveBeenCalled();
    done(held);
  });
});

// ===========================================================================
// The desktop page fills the window
//
// The owner opened the first desktop page on a wide monitor and it used the
// left half: the frame was capped at 1140px. The frame has no cap now, and the
// day's context becomes more columns as the window allows. jsdom lays nothing
// out, so what is pinned here is the two things that layout depends on: the
// elements the stylesheet turns into columns, and the stylesheet's own rules.
// ===========================================================================

describe("the desktop page fills the window", () => {
  afterEach(() => {
    cleanup();
  });

  const sheet = postcss.parse(
    readFileSync(path.join(process.cwd(), "app/v2/v2.css"), "utf8"),
  );

  /** The last value one selector is given for one property inside one tier. */
  const inTier = (minWidth: number, selector: string, prop: string) => {
    let found: string | null = null;
    sheet.walkAtRules("media", (media) => {
      if (media.params.trim() !== `(min-width: ${minWidth}px)`) return;
      media.walkRules((rule) => {
        const own = rule.selectors.map((entry) => entry.trim());
        if (!own.includes(`[data-v2-root] ${selector}`)) return;
        rule.walkDecls(prop, (decl) => {
          found = decl.value;
        });
      });
    });
    return found;
  };

  test("gives status and the two lists their own elements, in reading order", () => {
    const { container } = render(createElement(TodayClient, { data: sampleDay() }));
    const side = container.querySelector(".v2-side") as HTMLElement;
    const [status, lists] = Array.from(side.children);
    expect(status.className).toBe("v2-status");
    expect(lists.className).toBe("v2-lists");

    // The controls and the live region stay with status.
    expect(status.querySelector(".v2-energy")).not.toBeNull();
    expect(status.querySelector('[role="status"]')).not.toBeNull();

    // Past their date first, then what did not fit, each a column of its own.
    const columns = Array.from(lists.children);
    expect(columns.map((column) => column.getAttribute("aria-labelledby"))).toEqual([
      "v2-past-due",
      "v2-not-today",
    ]);
    for (const column of columns) {
      expect(column.classList.contains("v2-list")).toBe(true);
      const rows = column.querySelector(".v2-list-rows") as HTMLElement;
      expect(rows.querySelectorAll(".v2-row").length).toBeGreaterThan(0);
      // Every row is inside the element that lays rows out, none beside it.
      expect(column.querySelectorAll(".v2-row").length).toBe(
        rows.querySelectorAll(".v2-row").length,
      );
    }
  });

  test("keeps the rail, the day and the context in that order in the document", () => {
    const { container } = render(createElement(TodayClient, { data: sampleDay() }));
    const shell = container.querySelector(".v2-shell") as HTMLElement;
    expect(Array.from(shell.children).map((child) => child.className)).toEqual([
      "v2-nav",
      "v2-main",
      "v2-side",
    ]);
  });

  test("puts no width cap on the frame at any desktop width", () => {
    const caps: string[] = [];
    sheet.walkAtRules("media", (media) => {
      // The phone and the framed tablet both carry a max-width in their query,
      // and both cap the frame on purpose. Everything else is a desktop tier.
      if (!media.params.includes("min-width") || media.params.includes("max-width")) {
        return;
      }
      media.walkRules((rule) => {
        if (!rule.selectors.some((entry) => entry.trim().endsWith(".v2-shell"))) return;
        rule.walkDecls("max-width", (decl) => {
          caps.push(`${media.params}: ${decl.value}`);
        });
      });
    });
    expect(caps).toEqual([]);
  });

  test("gives everything left over to the context, not to a fixed column", () => {
    for (const tier of [1024, 1360, 2400]) {
      const columns = inTier(tier, ".v2-shell", "grid-template-columns") ?? "";
      // The last explicit track is flexible at every tier.
      expect(columns.trim().endsWith("fr)")).toBe(true);
    }
    // And the day stops growing, so the rest has somewhere to go.
    expect(inTier(1024, ".v2-shell", "grid-template-columns")).toContain(
      "minmax(420px, 640px)",
    );
  });

  test("turns the context into more columns as the window widens", () => {
    // At 1024 the side is the one column and its halves are nothing.
    expect(inTier(1024, ".v2-side", "display")).toBe("flex");
    expect(inTier(1024, ".v2-status", "display")).toBe("contents");
    expect(inTier(1024, ".v2-lists", "display")).toBe("contents");

    // From 1360 the side is nothing and its halves are the columns.
    expect(inTier(1360, ".v2-side", "display")).toBe("contents");
    expect(inTier(1360, ".v2-status", "display")).toBe("flex");
    expect(inTier(1360, ".v2-lists", "display")).toBe("flex");
    expect(inTier(1360, ".v2-shell", "grid-auto-flow")).toBe("column");

    // From 1760 each list is a column, so the pair's wrapper is nothing.
    expect(inTier(1760, ".v2-lists", "display")).toBe("contents");
    expect(inTier(1760, ".v2-list", "overflow-y")).toBe("auto");
  });

  test("does not keep an empty column when there is nothing to list", () => {
    expect(inTier(1360, ".v2-lists:empty", "display")).toBe("none");
  });

  /** The last value one selector is given for one property OUTSIDE any query. */
  const atRoot = (selector: string, prop: string) => {
    let found: string | null = null;
    sheet.walkRules((rule) => {
      if (rule.parent?.type !== "root") return;
      const own = rule.selectors.map((entry) => entry.trim());
      if (!own.includes(`[data-v2-root] ${selector}`)) return;
      rule.walkDecls(prop, (decl) => {
        found = decl.value;
      });
    });
    return found;
  };

  /**
   * The columns below are only the OUTER half of this guard. The stop has a grid
   * of its own whose content column is 1fr, and a 1fr track's automatic minimum
   * is also its content, so a pasted URL in a title widened it: on the phone the
   * lit card grew past the clipped frame and "Not today" went off screen, and on
   * desktop the card ran under the context column and the page scrolled
   * sideways. Both halves are needed, so both are pinned here: the inner
   * min-width, and a break for the word itself.
   */
  test("lets one long unbroken word break instead of widening its stop", () => {
    expect(atRoot(".v2-stop > *", "min-width")).toBe("0");
    // Every line of text a stop or a row can print, because any of them can
    // carry a string with no place to break: a fixed event prints its location
    // under the title, and a location is often a long meeting link.
    for (const kind of [
      ".v2-stop h3",
      ".v2-stop p",
      ".v2-stop .v2-detail",
      ".v2-row .v2-row-title",
      ".v2-row .v2-detail",
      ".v2-allday-chip",
    ]) {
      expect(atRoot(kind, "overflow-wrap")).toBe("anywhere");
    }
    // Not the right hand end of a row: that is a date or a fixed sentence,
    // never one long word, and letting it break anywhere let a date split in
    // the middle when the group name beside it was long.
    expect(atRoot(".v2-row .v2-row-reason", "overflow-wrap")).toBeNull();
  });

  // The accent ring is held at 3 to 1 on the page, and a lit card is not the
  // page. Whatever takes focus inside a lit card (its buttons, and the heading
  // that receives focus after a press) wears the stop's own identity colour,
  // which is held against exactly that fill.
  test("draws every focus ring inside a lit card in the colour held against its fill", () => {
    for (const target of [
      ".v2-lit button:focus-visible",
      ".v2-lit [tabindex]:focus-visible",
      ".v2-lit:focus-visible",
    ]) {
      expect(atRoot(target, "outline-color")).toBe("var(--v2-ident)");
    }
  });

  test("cannot be pushed sideways by a narrow column or one long word", () => {
    // A column narrower than the rows' own minimum would be overflowed by it.
    expect(inTier(1024, ".v2-list-rows", "grid-template-columns")).toContain("min(");
    // A grid item's automatic minimum is its content.
    expect(inTier(1024, ".v2-main", "min-width")).toBe("0");
    expect(inTier(1024, ".v2-side", "min-width")).toBe("0");
    expect(inTier(1760, ".v2-list", "min-width")).toBe("0");
  });

  test("keeps the rail wide enough for its longest word", () => {
    let railWidth: string | null = null;
    sheet.walkDecls("--v2-rail-w", (decl) => {
      railWidth = decl.value;
    });
    expect(Number.parseInt(railWidth ?? "0", 10)).toBeGreaterThanOrEqual(120);
  });

  // On a wide window a list is a column that scrolls on its own, and nothing
  // on a row presses. Without a stop of its own a keyboard could not reach it
  // to scroll it (Safari does not make a scroller focusable by itself).
  test("lets a keyboard reach each list, and names it", () => {
    const { container } = render(createElement(TodayClient, { data: sampleDay() }));
    const lists = Array.from(container.querySelectorAll<HTMLElement>(".v2-list"));
    expect(lists).toHaveLength(2);
    for (const list of lists) {
      expect(list.tabIndex).toBe(0);
      const heading = document.getElementById(list.getAttribute("aria-labelledby") ?? "");
      expect((heading?.textContent ?? "").length).toBeGreaterThan(0);
    }
    // The ring is drawn inside the box, where the window cannot cut it off.
    let offset: string | null = null;
    sheet.walkRules((rule) => {
      if (!rule.selectors.includes("[data-v2-root] .v2-list:focus-visible")) return;
      rule.walkDecls("outline-offset", (decl) => {
        offset = decl.value;
      });
    });
    expect(offset).toBe("-2px");
  });

  test("renders nothing at all in the lists element when there is nothing to list", () => {
    const sample = sampleDay();
    const data = { ...sample, input: { ...sample.input, candidates: [] } };
    const { container } = render(createElement(TodayClient, { data }));
    const lists = container.querySelector(".v2-lists") as HTMLElement;
    // :empty is what hides the column, and it needs no child of any kind.
    expect(lists.childNodes.length).toBe(0);
  });

  test("leaves the wrappers as nothing below the desktop width", () => {
    const found: string[] = [];
    sheet.each((node) => {
      // Top level rules only: what applies when no media query does.
      if (node.type !== "rule") return;
      const own = node.selectors.map((entry) => entry.trim());
      if (!own.includes("[data-v2-root] .v2-status")) return;
      node.walkDecls("display", (decl) => {
        found.push(`${own.join(", ")} => ${decl.value}`);
      });
    });
    expect(found).toEqual([
      "[data-v2-root] .v2-main, [data-v2-root] .v2-side, [data-v2-root] .v2-status, [data-v2-root] .v2-lists => contents",
    ]);
  });

  test("makes every context column a scroller of its own that stays in view", () => {
    for (const [tier, selector] of [
      [1024, ".v2-side"],
      [1024, ".v2-status"],
      [1024, ".v2-lists"],
      [1760, ".v2-list"],
    ] as const) {
      expect(inTier(tier, selector, "position")).toBe("sticky");
      expect(inTier(tier, selector, "max-height")).toBe("100dvh");
      expect(inTier(tier, selector, "overflow-y")).toBe("auto");
      expect(inTier(tier, selector, "scrollbar-gutter")).toBe("stable");
    }
    // And a list is NOT a scroller while something around it already is: one
    // scroller inside another traps the wheel in the inner one.
    for (const tier of [1024, 1360]) {
      expect(inTier(tier, ".v2-list", "overflow-y")).toBeNull();
      expect(inTier(tier, ".v2-list", "max-height")).toBeNull();
    }
  });

  test("gives the lists most of what is left on the widest screens", () => {
    expect(inTier(2400, ".v2-shell", "grid-auto-columns")).toBe("minmax(300px, 1.4fr)");
    expect(inTier(1360, ".v2-shell", "grid-auto-columns")).toBe("minmax(300px, 1.1fr)");
    // 1760 changes which elements are columns, not how wide a column is.
    expect(inTier(1760, ".v2-shell", "grid-template-columns")).toBeNull();
  });

  test("lets a long group name give way before it pushes the date out of a row", () => {
    let overflow: string | null = null;
    let minWidth: string | null = null;
    sheet.walkRules((rule) => {
      if (!rule.selectors.includes("[data-v2-root] .v2-row .v2-row-ident")) return;
      rule.walkDecls("text-overflow", (decl) => {
        overflow = decl.value;
      });
      rule.walkDecls("min-width", (decl) => {
        minWidth = decl.value;
      });
    });
    expect(overflow).toBe("ellipsis");
    expect(minWidth).toBe("0");
  });
});

// ===========================================================================
// Round 3
// ===========================================================================

describe("the screen and the planner agree on past its date", () => {
  afterEach(() => {
    cleanup();
  });

  /** The sample day, with the clock moved to before the window opens. */
  const atDawn = (): TodayScreenData => {
    const sample = sampleDay();
    const dawn = `${sample.input.date}T05:00:00-07:00`;
    return {
      ...sample,
      input: {
        ...sample.input,
        now: dawn,
        candidates: [
          ...sample.input.candidates,
          {
            id: "t-dawn",
            title: "Kiln cools by six",
            lane: "craft",
            kind: "step" as const,
            due: `${sample.input.date}T06:00:00-07:00`,
            hard: false,
            minutes: 25,
            energyCost: 2,
            expiresAt: null,
            pinned: false,
            earlyTouchDone: false,
          },
        ],
      },
    };
  };

  test("the reference is the window, not the clock, before wake", () => {
    const { input } = atDawn();
    expect(referenceOf(input)).not.toBe(input.now);
    expect(Date.parse(referenceOf(input))).toBeGreaterThan(Date.parse(input.now));
  });

  // The screen is the thing under test here, not the helper: this renders the
  // real client, which computes the reference itself.
  test("the screen lists an item due before wake under its own heading", () => {
    render(createElement(TodayClient, { data: atDawn() }));
    const section = document
      .getElementById("v2-past-due")
      ?.closest("section") as HTMLElement;
    expect(section.textContent).toContain("Kiln cools by six");

    // And the lane it belongs to does not claim its date is still ahead. The
    // craft lane holds it and one undated item, so it should name no date at
    // all; the money lane still names one, because the grant form really is due
    // tonight at 23:00.
    const lanes = Array.from(document.querySelectorAll(".v2-lane-line")).map(
      (line) => line.textContent ?? "",
    );
    const craft = lanes.find((line) => line.startsWith("Craft")) ?? "";
    expect(craft).not.toBe("");
    expect(craft).not.toContain("next");
    expect(lanes.some((line) => line.startsWith("Money") && line.includes("next"))).toBe(
      true,
    );
  });
});

// Two calendars can carry the same holiday, and the title alone then gives React
// two children with one key.
describe("the all day row", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  test("renders two events of the same name without a duplicate key", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      createElement(AllDayRow, {
        items: ["Reading break", "Reading break", "Studio closed"],
      }),
    );
    expect(screen.getAllByText("Reading break")).toHaveLength(2);
    expect(errors).not.toHaveBeenCalled();
  });
});

// Both triggers are always mounted and each is hidden at the other's width, so
// a panel opened at phone width and closed after the window grew past 1024px
// handed focus to a display:none button and lost it.
describe("the appearance panel after a resize", () => {
  afterEach(() => {
    cleanup();
    try {
      localStorage.clear();
    } catch {
      // nothing to clean up
    }
  });

  test("hands focus to a trigger that is on screen, not to a hidden one", async () => {
    render(
      createElement(
        AppearanceRoot,
        null,
        createElement(AppearanceTrigger, { variant: "header" }),
        createElement(AppearanceTrigger, { variant: "rail" }),
      ),
    );
    const [phone, rail] = screen.getAllByRole("button", {
      name: APPEARANCE_COPY.open,
    });

    await act(async () => {
      fireEvent.click(phone);
    });
    expect(screen.getByRole("dialog")).toBeTruthy();

    // The window grew: the control that opened the panel is now the hidden one.
    phone.style.display = "none";

    await act(async () => {
      fireEvent.keyDown(document.body, { key: "Escape" });
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(rail);
  });

  test("still returns focus to the opener while it is on screen", async () => {
    render(
      createElement(
        AppearanceRoot,
        null,
        createElement(AppearanceTrigger, { variant: "header" }),
        createElement(AppearanceTrigger, { variant: "rail" }),
      ),
    );
    const [phone] = screen.getAllByRole("button", { name: APPEARANCE_COPY.open });
    await act(async () => {
      fireEvent.click(phone);
    });
    await act(async () => {
      fireEvent.keyDown(document.body, { key: "Escape" });
    });
    expect(document.activeElement).toBe(phone);
  });
});
