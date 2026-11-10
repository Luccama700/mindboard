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
import { hydrateRoot } from "react-dom/client";

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { TodayClient } from "@/app/v2/today/today-client";
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
import { FeedDots } from "@/app/v2/_components/feed-strip";
import { NotTodayList } from "@/app/v2/_components/not-today-list";
import type { Block, Energy, PlanInput } from "@/app/lib/v2/types";

const LANE_LABELS = ["Study", "Work", "Money", "People", "Craft", "Body"];

function viewOf(energy: Energy | null, existing: Block[] = []): TodayView {
  const sample = sampleDay();
  const input: PlanInput = { ...sample.input, energy, existing };
  const plan = planDay(input);
  return buildTodayView({
    date: input.date,
    now: input.now,
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

  test("renders the sample day with the flag on", async () => {
    vi.stubEnv("V2_FIXTURES", "1");
    vi.stubEnv("VERCEL_ENV", "preview");
    const { default: TodayPage } = await import("@/app/v2/today/page");
    expect(TodayPage()).toBeTruthy();
  });

  test("is not found with the flag off and no snapshot folder", async () => {
    vi.stubEnv("V2_FIXTURES", "");
    vi.stubEnv("V2_LOCAL_SNAPSHOT", "");
    vi.stubEnv("VERCEL_ENV", "preview");
    const { default: TodayPage } = await import("@/app/v2/today/page");
    expect(() => TodayPage()).toThrow();
  });

  test("is not found in production, flag or no flag", async () => {
    vi.stubEnv("V2_FIXTURES", "1");
    vi.stubEnv("V2_LOCAL_SNAPSHOT", "");
    vi.stubEnv("VERCEL_ENV", "production");
    const { default: TodayPage } = await import("@/app/v2/today/page");
    expect(() => TodayPage()).toThrow();
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

  test("closes on a press on the veil, and hands focus back", async () => {
    const { trigger, veil } = await openPanel();
    await act(async () => {
      fireEvent.mouseDown(veil);
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  // A drag that starts on a control and ends on the veil must not close
  // anything, which is why it is mousedown with target === currentTarget.
  test("does not close on a press that starts on a control inside it", async () => {
    const { panel } = await openPanel();
    await act(async () => {
      fireEvent.mouseDown(screen.getByRole("button", { name: SCHEMES[0].name }));
    });
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
    await act(async () => {
      hydrateRoot(host, element);
    });
    return { host, errors, seen };
  };

  test("applies a stored built in scheme after hydration, quietly", async () => {
    const stored: Appearance = {
      schemeId: "paper-ink",
      background: null,
      accent: null,
    };
    const { host, errors, seen } = await hydrateWith(stored);
    const root = host.querySelector("[data-v2-root]") as HTMLElement;
    expect(root.getAttribute("data-v2-scheme")).toBe("paper-ink");
    expectTokens(root, stored);
    expect(seen).toEqual([]);
    expect(errors).not.toHaveBeenCalled();
  });

  test("applies a stored custom pair after hydration, quietly", async () => {
    const stored: Appearance = {
      schemeId: CUSTOM_SCHEME_ID,
      background: "#120A1F",
      accent: "#FF8A3D",
    };
    const { host, errors } = await hydrateWith(stored);
    const root = host.querySelector("[data-v2-root]") as HTMLElement;
    expect(root.getAttribute("data-v2-scheme")).toBe(CUSTOM_SCHEME_ID);
    expectTokens(root, stored);
    expect(errors).not.toHaveBeenCalled();
  });
});
