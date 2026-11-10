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

import { afterEach, describe, expect, test, vi } from "vitest";

import { planDay } from "@/app/lib/v2/plan/planner";
import { fixturesEnabled, sampleDay } from "@/app/lib/v2/fixtures/sample-day";
import {
  STOP_STATUS_COPY,
  TODAY_COPY,
  buildTodayView,
  droppedTitles,
  type TodayView,
} from "@/app/lib/v2/view/today";
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
    feeds: sample.feeds,
    feedLabels: sample.feedLabels,
    openAsks: sample.openAsks,
    energy,
    titles: droppedTitles(input.candidates),
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
    expect(view.stops.some((stop) => stop.lane !== null)).toBe(true);
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
      feeds: sampleDay().feeds,
      feedLabels: sampleDay().feedLabels,
      openAsks: sampleDay().openAsks,
      energy: input.energy,
      titles: droppedTitles(input.candidates),
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
    "app/v2/_components/day-header.tsx",
    "app/v2/_components/day-line.tsx",
    "app/v2/_components/energy-row.tsx",
    "app/v2/_components/stop-card.tsx",
    "app/v2/_components/not-today-list.tsx",
    "app/v2/_components/nav-bar.tsx",
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

  test("is not found with the flag off", async () => {
    vi.stubEnv("V2_FIXTURES", "");
    vi.stubEnv("VERCEL_ENV", "preview");
    const { default: TodayPage } = await import("@/app/v2/today/page");
    expect(() => TodayPage()).toThrow();
  });

  test("is not found in production, flag or no flag", async () => {
    vi.stubEnv("V2_FIXTURES", "1");
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
