// PLAN-DESK Task 5, behaviours 4 to 7: the five panes of the day, the registry
// that answers a body for a pane id, the box a body is drawn in, the stylesheet
// rules that let a leaf size by its pane, and the gallery that draws one pane
// alone at a fixed size.
//
// WHAT IS NOT PINNED HERE. How a pane LOOKS at 230, 464 and 1300 px: jsdom lays
// nothing out. What the stylesheet says is read with postcss below; what it
// draws is the controller's capture.
//
// THE QUEST AND MONEY MAPS ARE BEING FILLED BY OTHER TASKS, so nothing here
// asserts what they hold: a quest or money id is checked against whatever its
// own map says at the time.
//
// JSX would need a .tsx file, hence createElement, as in the other v2 tests.

import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createElement,
  type Attributes,
  type ComponentType,
  type ReactElement,
  type ReactNode,
} from "react";

import postcss, { type AtRule, type Rule } from "postcss";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterAll, afterEach, describe, expect, test, vi } from "vitest";

// There is no request in a test, and the snapshot branch reads one header.
vi.mock("next/headers", () => ({
  headers: () =>
    Promise.resolve({
      get: (name: string) => (name.toLowerCase() === "host" ? "127.0.0.1:3111" : null),
    }),
}));

import { sampleDesk } from "@/app/lib/v2/fixtures/sample-desk";
import { sampleMoneyStale } from "@/app/lib/v2/fixtures/sample-money";
import { sampleWeek } from "@/app/lib/v2/fixtures/sample-week";
import { planDay } from "@/app/lib/v2/plan/planner";
import { CALENDAR_COPY } from "@/app/lib/v2/view/calendar";
import type { DeskScreenData } from "@/app/lib/v2/view/desk-data";
import {
  DESK_COPY,
  GALLERY_SIZE,
  galleryKeep,
  galleryLine,
  galleryRequest,
} from "@/app/lib/v2/view/desk";
import { NOT_TODAY_VISIBLE, TODAY_COPY } from "@/app/lib/v2/view/today";
import { DayProvider } from "@/app/v2/_components/day-provider";
import { MONEY_PANE_BODIES } from "@/app/v2/_components/money/money-panes";
import { QUEST_PANE_BODIES } from "@/app/v2/_components/quests/quest-panes";
import { SnapshotError } from "@/app/v2/_components/snapshot-error";
import { DAY_PANE_BODIES } from "@/app/v2/_desk/day-panes";
import { DeskDataProvider, useDeskData, useDeskKeep } from "@/app/v2/_desk/desk-data-provider";
import { PaneBox } from "@/app/v2/_desk/pane-box";
import { KNOWN_PANE_IDS, NotBuilt, paneBody } from "@/app/v2/_desk/pane-registry";
import { GalleryClient } from "@/app/v2/panes/gallery-client";
import PanesPage, { dynamic } from "@/app/v2/panes/page";

const ROOT = path.resolve(__dirname, "..");

/** What `notFound()` throws, as Next spells it (http-access-fallback.js). */
const NOT_FOUND_DIGEST = "NEXT_HTTP_ERROR_FALLBACK;404";

/** The fourteen panes of the plan's table, in its order. */
const FOURTEEN = [
  "today",
  "status",
  "past-due",
  "not-today",
  "calendar",
  "lanes",
  "steps",
  "side-quests",
  "done",
  "forecast",
  "accounts",
  "coming-up",
  "hours",
  "ledger",
];

const DAY_IDS = ["today", "status", "past-due", "not-today", "calendar"];
const QUEST_IDS = ["lanes", "steps", "side-quests", "done"];
const MONEY_IDS = ["forecast", "accounts", "coming-up", "hours", "ledger"];

/** The pane's accessible name: the word, then whichever week it is showing. */
const CALENDAR_NAME = new RegExp(`^${CALENDAR_COPY.heading} `);

const made: string[] = [];

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await Promise.all(made.map((dir) => rm(dir, { recursive: true, force: true })));
});

const press = async (name: string) => {
  const button = screen.getByRole("button", { name });
  await act(async () => {
    fireEvent.click(button);
  });
};

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
 * One pane in a box, the way the desk will draw it: the desk's data, the day
 * keyed on the planned day, and the box. Any number of ids share the providers,
 * so a test can watch a press in one pane reach another.
 */
function drawPanes(
  ids: string[],
  data: DeskScreenData = sampleDesk(null),
  keep?: Readonly<Record<string, string>>,
) {
  const boxes = ids.map((id) =>
    wrap(
      PaneBox,
      { key: id, paneId: id, style: { width: 464, height: 600 } },
      createElement(paneBody(id), { options: {} }),
    ),
  );
  return render(
    wrap(
      DeskDataProvider,
      { data, keep },
      wrap(DayProvider, { key: data.today.input.date, data: data.today }, ...boxes),
    ),
  );
}

const boxOf = (container: HTMLElement, id: string) =>
  container.querySelector(`.v2-pane[data-pane="${id}"]`) as HTMLElement;

// ---------------------------------------------------------------- behaviour 5

describe("the registry", () => {
  test("knows the fourteen panes of the plan, in its order", () => {
    expect([...KNOWN_PANE_IDS]).toEqual(FOURTEEN);
  });

  test("answers each of the five day ids with a real body", () => {
    for (const id of DAY_IDS) {
      expect(paneBody(id), id).toBe(DAY_PANE_BODIES[id]);
      expect(paneBody(id), id).not.toBe(NotBuilt);
    }
    expect(Object.keys(DAY_PANE_BODIES).sort()).toEqual([...DAY_IDS].sort());
  });

  test("answers a quest or a money id from its own map, or NotBuilt", () => {
    for (const id of QUEST_IDS) {
      expect(paneBody(id), id).toBe(
        Object.hasOwn(QUEST_PANE_BODIES, id) ? QUEST_PANE_BODIES[id] : NotBuilt,
      );
    }
    for (const id of MONEY_IDS) {
      expect(paneBody(id), id).toBe(
        Object.hasOwn(MONEY_PANE_BODIES, id) ? MONEY_PANE_BODIES[id] : NotBuilt,
      );
    }
  });

  // An id comes from a URL. A plain object lookup would answer "toString" with
  // the prototype's function, and React would then call it as a component.
  test("answers NotBuilt for anything else, and never throws", () => {
    for (const id of ["", "nothing", "Today", " today", "toString", "__proto__", "constructor"]) {
      expect(() => paneBody(id), id).not.toThrow();
      expect(paneBody(id), id).toBe(NotBuilt);
    }
  });

  // The same function for the same id on every call, or a re-render would hand
  // React a new component type and remount the body, losing its own state.
  test("answers the same body for the same id every time", () => {
    for (const id of [...FOURTEEN, "nothing"]) {
      expect(paneBody(id), id).toBe(paneBody(id));
    }
  });

  test("draws NotBuilt as one sentence", () => {
    const { container } = render(createElement(NotBuilt, { options: {} }));
    expect(container.textContent).toBe(DESK_COPY.notBuilt);
    expect(container.querySelectorAll("p")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- behaviour 4

describe("the five day panes, each in a box", () => {
  test("puts each body in the v2-pane box, inside the scroller every body shares", () => {
    const { container } = drawPanes(DAY_IDS);
    for (const id of DAY_IDS) {
      const box = boxOf(container, id);
      expect(box, id).not.toBeNull();
      expect(box.style.width).toBe("464px");
      expect(box.style.height).toBe("600px");
      const scroller = box.firstElementChild as HTMLElement;
      expect(scroller.className).toBe("v2-pane-body");
      // A keyboard has to reach a box that scrolls, as it does a list.
      expect(scroller.tabIndex).toBe(0);
      expect(scroller.childNodes.length).toBeGreaterThan(0);
    }
  });

  test("holds no live region, in any of them: the page owns the one", () => {
    const { container } = drawPanes(DAY_IDS);
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(0);
    expect(container.querySelectorAll("[aria-live]")).toHaveLength(0);
  });

  test("today: the day header, the energy row and the line", () => {
    const data = sampleDesk(null);
    const { container } = drawPanes(["today"], data);
    const box = boxOf(container, "today");
    expect(box.querySelector("h1")?.textContent).toBe("Wednesday 15 April");
    expect(box.querySelector(".v2-energy [role='group']")?.getAttribute("aria-label")).toBe(
      TODAY_COPY.energyGroup,
    );
    expect(box.querySelectorAll(".v2-line .v2-stop").length).toBeGreaterThan(1);
    expect(box.querySelector(".v2-empty")).toBeNull();
  });

  test("today: the empty sentence when nothing is planned", () => {
    const desk = sampleDesk(null);
    const quiet: DeskScreenData = {
      ...desk,
      today: {
        ...desk.today,
        input: { ...desk.today.input, candidates: [], fixed: [], rules: desk.today.input.rules },
      },
    };
    const plan = planDay(quiet.today.input);
    // The sentence is for a day with nothing on it at all; the sample's rules
    // may still place a block of their own, and then the line is drawn.
    const { container } = drawPanes(["today"], quiet);
    const box = boxOf(container, "today");
    if (plan.blocks.length === 0) {
      expect(box.querySelector(".v2-empty")?.textContent).toBe(TODAY_COPY.empty);
      expect(box.querySelector(".v2-line")).toBeNull();
    } else {
      expect(box.querySelector(".v2-line")).not.toBeNull();
    }
  });

  test("status: the said sentence with no role, the all day row, the feeds and the lanes", () => {
    const { container } = drawPanes(["status"]);
    const box = boxOf(container, "status");
    const said = box.querySelector(".v2-said") as HTMLElement;
    expect(said.getAttribute("role")).toBeNull();
    expect(said.textContent?.length).toBeGreaterThan(0);
    expect(box.querySelectorAll(".v2-allday-chip").length).toBeGreaterThan(0);
    expect(box.querySelector(`[aria-label="${TODAY_COPY.feeds}"]`)).not.toBeNull();
    expect(box.querySelector("#v2-lanes")?.textContent).toBe(TODAY_COPY.lanesHeading);
  });

  test("status: says what a press in another pane did, in the same render", async () => {
    const { container } = drawPanes(["today", "status"]);
    const said = () => boxOf(container, "status").querySelector(".v2-said")?.textContent ?? "";
    const before = said();
    await press(TODAY_COPY.notToday);
    expect(said()).not.toBe(before);
    expect(said()).toContain(TODAY_COPY.acted.skipped);
  });

  test("past-due and not-today: the existing lists, one each", () => {
    const { container } = drawPanes(["past-due", "not-today"]);
    const past = boxOf(container, "past-due");
    const drops = boxOf(container, "not-today");
    expect(past.querySelector("#v2-past-due")?.textContent).toBe(TODAY_COPY.pastDueHeading);
    expect(past.querySelector("#v2-not-today")).toBeNull();
    expect(drops.querySelector("#v2-not-today")?.textContent).toBe(TODAY_COPY.notTodayHeading);
    expect(drops.querySelectorAll(".v2-row").length).toBeGreaterThan(0);
    expect(drops.querySelectorAll(".v2-row").length).toBeLessThanOrEqual(NOT_TODAY_VISIBLE);
  });

  test("calendar: the day's planned blocks, links to the desk carrying what it keeps", () => {
    const keep = { layout: "week", date: "2026-04-15" };
    const { container } = drawPanes(["calendar"], sampleDesk(null), keep);
    const box = boxOf(container, "calendar");
    expect(screen.getByRole("region", { name: CALENDAR_NAME })).not.toBeNull();
    expect(box.querySelectorAll('[data-kind="planned"]').length).toBeGreaterThan(0);
    const hrefs = Array.from(box.querySelectorAll<HTMLAnchorElement>("a.v2-cal-link")).map(
      (link) => link.getAttribute("href") ?? "",
    );
    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) {
      expect(href).toMatch(/^\/v2\/desk\?week=\d{4}-\d{2}-\d{2}&layout=week&date=2026-04-15$/);
    }
  });

  test("calendar: one sentence when the day has no calendar", () => {
    const desk = sampleDesk(null);
    const { container } = drawPanes(["calendar"], { ...desk, today: { ...desk.today, calendar: null } });
    const box = boxOf(container, "calendar");
    expect(box.textContent).toBe(CALENDAR_COPY.noCalendar);
    expect(box.querySelector(".v2-cal")).toBeNull();
  });
});

describe("the desk's data", () => {
  test("is handed down, with the links' kept parameters", () => {
    const data = sampleDesk(null);
    const seen: Array<{ data: DeskScreenData; keep: Readonly<Record<string, string>> }> = [];
    const Probe = (): ReactNode => {
      seen.push({ data: useDeskData(), keep: useDeskKeep() });
      return null;
    };
    render(wrap(DeskDataProvider, { data, keep: { layout: "money" } }, createElement(Probe)));
    expect(seen.at(-1)?.data).toBe(data);
    expect(seen.at(-1)?.keep).toEqual({ layout: "money" });
  });

  test("keeps nothing when it is given nothing to keep", () => {
    const seen: Array<Readonly<Record<string, string>>> = [];
    const Probe = (): ReactNode => {
      seen.push(useDeskKeep());
      return null;
    };
    render(wrap(DeskDataProvider, { data: sampleDesk(null) }, createElement(Probe)));
    expect(seen.at(-1)).toEqual({});
  });

  test("refuses to be read outside a provider", () => {
    const Lost = (): ReactNode => {
      useDeskData();
      return null;
    };
    const quiet = console.error;
    console.error = () => {};
    try {
      expect(() => render(createElement(Lost))).toThrow(/outside a DeskDataProvider/);
    } finally {
      console.error = quiet;
    }
  });
});

// ---------------------------------------------------------------- behaviour 7

describe("what the gallery is asked for", () => {
  test("defaults to the day's pane in a 464 by 600 box", () => {
    expect(GALLERY_SIZE).toEqual({ width: 464, height: 600, min: 160, max: 2400 });
    expect(galleryRequest({})).toEqual({
      paneId: "today",
      width: 464,
      height: 600,
      options: {},
      stale: false,
      date: null,
      week: null,
    });
  });

  test("holds each side to 160..2400, and ignores what is not a whole number", () => {
    const size = (w: string | string[], h: string | string[]) => {
      const { width, height } = galleryRequest({ w, h });
      return [width, height];
    };
    expect(size("230", "150")).toEqual([230, 160]);
    expect(size("10", "99999")).toEqual([160, 2400]);
    expect(size("1300", "2401")).toEqual([1300, 2400]);
    expect(size("abc", "")).toEqual([464, 600]);
    expect(size("-5", "1e3")).toEqual([464, 600]);
    expect(size("464.5", " 600")).toEqual([464, 600]);
    expect(size(["230", "1300"], ["300"])).toEqual([464, 600]);
  });

  test("reads every o.<key> as an option, and nothing else", () => {
    const asked = galleryRequest({
      pane: "forecast",
      "o.view": "chart",
      "o.span": "30",
      "o.": "nameless",
      "o.twice": ["a", "b"],
      other: "x",
    });
    expect(asked.paneId).toBe("forecast");
    expect(asked.options).toEqual({ view: "chart", span: "30" });
  });

  test("takes stale only as exactly 1, and the date and the week as strings", () => {
    expect(galleryRequest({ stale: "1" }).stale).toBe(true);
    for (const value of ["0", "true", "", ["1", "1"]]) {
      expect(galleryRequest({ stale: value }).stale).toBe(false);
    }
    expect(galleryRequest({ date: "2026-04-15", week: "2026-04-20" })).toMatchObject({
      date: "2026-04-15",
      week: "2026-04-20",
    });
    expect(galleryRequest({ date: ["a", "b"] }).date).toBeNull();
  });

  // A week link redraws the same pane at the same size with the same options;
  // a link that dropped the date planned the clock's day instead.
  test("keeps the pane, the size, the options, stale, and the planned date", () => {
    const asked = galleryRequest({
      pane: "calendar",
      w: "1300",
      h: "10",
      "o.view": "grid",
      stale: "1",
      date: "2026-04-15",
      week: "2026-04-20",
    });
    expect(galleryKeep(asked, "2026-04-15")).toEqual({
      pane: "calendar",
      w: "1300",
      h: "160",
      "o.view": "grid",
      stale: "1",
      date: "2026-04-15",
    });
    // A date the source did not plan changed nothing, so it is not carried.
    expect(galleryKeep(asked, "2026-04-16")).not.toHaveProperty("date");
    expect(galleryKeep(galleryRequest({}), "2026-04-15")).toEqual({
      pane: "today",
      w: "464",
      h: "600",
    });
  });

  test("names the pane and the size in one line", () => {
    expect(galleryLine("past-due", 230, 600)).toBe("past-due, 230 by 600 px");
  });

  // No other copy walk reads the desk's words yet, so this one does. Built from
  // code points, so this file stays free of the characters it looks for.
  test("words the desk in plain copy, with no dash and no score", () => {
    const words = Object.values(DESK_COPY);
    expect(words.length).toBeGreaterThan(3);
    for (const text of words) {
      expect(text).not.toContain(String.fromCodePoint(0x2014));
      expect(text).not.toContain(String.fromCodePoint(0x2013));
      expect(text).not.toMatch(/\b(streaks?|points?|levels?|penalt(y|ies)|xp)\b/i);
    }
    expect(DESK_COPY.heading).toBe("Desk");
    expect(DESK_COPY.notBuilt).toBe("This pane is not built yet.");
  });
});

/** A whole snapshot folder, small and invented, that the desk can read. */
const SNAPSHOT_FOLDER: Record<string, string> = {
  "snapshot.json": JSON.stringify({
    userId: "77777777-7777-4777-8777-777777777777",
    timeZone: "America/Phoenix",
    takenAt: "2026-04-15T09:05:00-07:00",
  }),
  "rules.json": JSON.stringify({
    planner: {
      timeZone: "America/Phoenix",
      wakeByWeekday: ["07:30", "07:30", "07:30", "07:30", "07:30", "07:30", "07:30"],
      lightsOut: "23:30",
      noFocusBefore: "08:30",
    },
    lanes: [],
    feedLabels: {},
  }),
  "tasks.json": "[]",
  "groups.json": "[]",
  "income_sources.json": "[]",
};

function sample() {
  vi.stubEnv("V2_FIXTURES", "1");
  vi.stubEnv("V2_LOCAL_SNAPSHOT", "");
  vi.stubEnv("VERCEL_ENV", "preview");
}

async function local(files: Record<string, string>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "v2-pane-gallery-"));
  made.push(dir);
  for (const [name, body] of Object.entries(files)) {
    await writeFile(path.join(dir, name), body, "utf8");
  }
  vi.stubEnv("V2_FIXTURES", "");
  vi.stubEnv("V2_LOCAL_SNAPSHOT", dir);
  vi.stubEnv("VERCEL_ENV", "preview");
}

const digestOf = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    return String((error as { digest?: unknown }).digest ?? "no digest");
  }
  return "nothing was thrown";
};

interface GalleryProps {
  data: DeskScreenData;
  paneId: string;
  width: number;
  height: number;
  options: Record<string, string>;
  keep: Record<string, string>;
}

/** The page, one level deep: what its guarded child returns. */
async function page(search: Record<string, string | string[]> = {}) {
  const outer = PanesPage({ searchParams: Promise.resolve(search) }) as unknown as {
    type: (props: unknown) => Promise<ReactElement<GalleryProps>>;
    props: unknown;
  };
  return outer.type(outer.props);
}

describe("the gallery page", () => {
  test("is not found with the flag off and no snapshot folder, or in production", () => {
    vi.stubEnv("V2_FIXTURES", "");
    vi.stubEnv("V2_LOCAL_SNAPSHOT", "");
    vi.stubEnv("VERCEL_ENV", "preview");
    expect(digestOf(() => PanesPage())).toBe(NOT_FOUND_DIGEST);

    vi.stubEnv("V2_FIXTURES", "1");
    vi.stubEnv("VERCEL_ENV", "production");
    expect(digestOf(() => PanesPage())).toBe(NOT_FOUND_DIGEST);
  });

  test("asks to be rendered per request, so the gate is never prerendered", () => {
    expect(dynamic).toBe("force-dynamic");
  });

  test("loads the whole sample desk and draws one pane in a box of the size asked", async () => {
    sample();
    const inner = await page({ pane: "past-due", w: "230", h: "300" });
    expect(inner.type).toBe(GalleryClient);
    expect(inner.props.data).toEqual(sampleDesk(null));
    expect(inner.props).toMatchObject({ paneId: "past-due", width: 230, height: 300 });

    const { container } = render(inner);
    const boxes = container.querySelectorAll(".v2-pane");
    expect(boxes).toHaveLength(1);
    const box = boxes[0] as HTMLElement;
    expect(box.dataset.pane).toBe("past-due");
    expect(box.style.width).toBe("230px");
    expect(box.style.height).toBe("300px");
    expect(box.querySelector("#v2-past-due")).not.toBeNull();
    expect(container.textContent).toContain(galleryLine("past-due", 230, 300));
  });

  test("passes the week asked for to the desk, and the options to the body", async () => {
    sample();
    const inner = await page({ pane: "calendar", week: "2026-04-20", "o.view": "grid" });
    expect(inner.props.data.today.calendar).toEqual(sampleWeek("2026-04-20"));
    expect(inner.props.options).toEqual({ view: "grid" });
  });

  test("draws NotBuilt for an id it does not know, and names it", async () => {
    sample();
    const { container } = render(await page({ pane: "nothing-here" }));
    const box = container.querySelector(".v2-pane") as HTMLElement;
    expect(box.textContent).toBe(DESK_COPY.notBuilt);
    expect(container.textContent).toContain(galleryLine("nothing-here", 464, 600));
  });

  test("holds the one live region, and it speaks a press inside the pane", async () => {
    sample();
    const { container } = render(await page({ pane: "today" }));
    const regions = () => container.querySelectorAll('[role="status"]');
    expect(regions()).toHaveLength(1);
    const before = regions()[0].textContent ?? "";
    expect(before.length).toBeGreaterThan(0);

    await press(TODAY_COPY.notToday);
    expect(regions()).toHaveLength(1);
    expect(regions()[0].textContent).toContain(TODAY_COPY.acted.skipped);
    // Outside the box: the box is only the pane.
    expect((container.querySelector(".v2-pane") as HTMLElement).contains(regions()[0])).toBe(
      false,
    );
  });

  test("sends the calendar's week links back to the gallery, for the same pane", async () => {
    sample();
    const { container } = render(await page({ pane: "calendar", w: "1300", h: "700" }));
    const hrefs = Array.from(container.querySelectorAll<HTMLAnchorElement>("a.v2-cal-link")).map(
      (link) => link.getAttribute("href") ?? "",
    );
    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) {
      expect(href).toMatch(/^\/v2\/panes\?week=\d{4}-\d{2}-\d{2}&pane=calendar&w=1300&h=700$/);
    }
  });

  test("swaps in the sample's stale money on ?stale=1, and only then", async () => {
    sample();
    const desk = sampleDesk(null);
    const stale = await page({ pane: "accounts", stale: "1" });
    expect(stale.props.data.money).toEqual(sampleMoneyStale(desk.today));
    expect(stale.props.data.money).not.toEqual(desk.money);
    // Everything else is the desk as it was.
    expect({ ...stale.props.data, money: null }).toEqual({ ...desk, money: null });
    expect(stale.props.keep).toMatchObject({ stale: "1" });

    const fresh = await page({ pane: "accounts", stale: "0" });
    expect(fresh.props.data.money).toEqual(desk.money);
    expect(fresh.props.keep).not.toHaveProperty("stale");
  });

  test("shows the snapshot error when the folder's day cannot be read", async () => {
    await local({});
    const inner = await page({ pane: "today" });
    expect(inner.type).toBe(SnapshotError);
    expect(String((inner.props as unknown as { message: string }).message).length).toBeGreaterThan(
      0,
    );
  });

  // The folder plans from the real clock, so the planned day is read off the
  // first answer rather than written here.
  test("loads the whole desk from a folder, and keeps only the date it planned", async () => {
    await local(SNAPSHOT_FOLDER);
    const first = await page({ pane: "status" });
    expect(first.type).toBe(GalleryClient);
    const planned = first.props.data.today.input.date;
    expect(planned).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(first.props.keep).toEqual({ pane: "status", w: "464", h: "600" });

    const asked = await page({ pane: "status", date: planned });
    expect(asked.props.data.today.input.date).toBe(planned);
    expect(asked.props.keep).toEqual({ pane: "status", w: "464", h: "600", date: planned });

    // A date the folder will not plan changed nothing, so it is not carried.
    const ignored = await page({ pane: "status", date: "2001-01-01" });
    expect(ignored.props.keep).not.toHaveProperty("date");

    const { container } = render(asked);
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(1);
    expect(container.querySelector('.v2-pane[data-pane="status"] .v2-said')).not.toBeNull();
  });
});

// ---------------------------------------------------------------- behaviour 6

describe("a leaf sizes by its pane", () => {
  const v2 = postcss.parse(readFileSync(path.join(ROOT, "app/v2/v2.css"), "utf8"));
  const desk = postcss.parse(readFileSync(path.join(ROOT, "app/v2/desk.css"), "utf8"));

  /** Every rule of a sheet with where it sits: the at-rule params around it, or "". */
  const rulesOf = (sheet: postcss.Root) => {
    const out: Array<{ rule: Rule; where: string }> = [];
    sheet.walkRules((rule) => {
      const parent = rule.parent as AtRule | undefined;
      const where = parent?.type === "atrule" ? `@${parent.name} ${parent.params.trim()}` : "";
      out.push({ rule, where });
    });
    return out;
  };

  /** The last value one selector is given for one property, in one place. */
  const valueOf = (sheet: postcss.Root, where: string, selector: string, prop: string) => {
    let found: string | null = null;
    for (const entry of rulesOf(sheet)) {
      if (entry.where !== where) continue;
      if (!entry.rule.selectors.map((one) => one.trim()).includes(selector)) continue;
      entry.rule.walkDecls(prop, (decl) => {
        found = decl.value;
      });
    }
    return found;
  };

  /**
   * Specificity as (classes and attributes and pseudo classes, elements), for
   * the plain selectors these sheets use. `:where()` counts nothing, which is
   * the point of it.
   */
  const specificity = (selector: string): [number, number] => {
    const bare = selector.replace(/:where\([^)]*\)/g, " ");
    const classes = (bare.match(/\.[\w-]+|\[[^\]]+\]|:(?!:)[\w-]+/g) ?? []).length;
    const elements = (bare.match(/(^|[\s>+~])[a-z][\w-]*/g) ?? []).length;
    return [classes, elements];
  };
  const beats = (a: [number, number], b: [number, number]) =>
    a[0] > b[0] || (a[0] === b[0] && a[1] > b[1]);
  const ties = (a: [number, number], b: [number, number]) => a[0] === b[0] && a[1] === b[1];

  const DESKTOP = "@media (min-width: 1024px)";
  const BOTH = "[data-v2-root] :where(.v2-side, .v2-pane)";

  /**
   * The nine leaf rules that restyled a leaf for sitting in the side column,
   * each with the rule it used to override. The title's own rule is the one
   * that needed its weight put back: `:where()` took the side column's class
   * out of the count, and `.v2-row .v2-row-title` would have won.
   */
  const LEAVES: Array<{ selector: string; base: string }> = [
    { selector: `${BOTH} .v2-feeds`, base: "[data-v2-root] .v2-feeds" },
    { selector: `${BOTH} .v2-allday-label`, base: "[data-v2-root] .v2-allday-label" },
    { selector: `${BOTH} .v2-energy`, base: "[data-v2-root] .v2-energy" },
    { selector: `${BOTH} .v2-said`, base: "[data-v2-root] .v2-said" },
    { selector: `${BOTH} .v2-allday`, base: "[data-v2-root] .v2-allday" },
    { selector: `${BOTH} .v2-sub`, base: "[data-v2-root] .v2-sub" },
    { selector: `${BOTH} .v2-row`, base: "[data-v2-root] .v2-row" },
    { selector: `${BOTH} .v2-row b.v2-row-title`, base: "[data-v2-root] .v2-row .v2-row-title" },
    { selector: `${BOTH} .v2-more`, base: "[data-v2-root] .v2-more" },
  ];

  test("restyles each side column leaf inside a pane too, from the desktop tier", () => {
    for (const { selector } of LEAVES) {
      const found = rulesOf(v2).filter(
        (entry) =>
          entry.where === DESKTOP &&
          entry.rule.selectors.map((one) => one.trim()).includes(selector),
      );
      expect(found.length, selector).toBeGreaterThan(0);
    }
    // And no rule still restyles one of them for the side column alone.
    const stale = rulesOf(v2)
      .flatMap((entry) => entry.rule.selectors.map((one) => one.trim()))
      .filter((one) => one.startsWith("[data-v2-root] .v2-side ."));
    expect(stale).toEqual([]);
  });

  // The existing page keeps every pixel: each rewritten rule still out-ranks
  // the rule it overrode, or ties it and comes after it in the file.
  test("still wins over the rule each one overrode", () => {
    const line = (selector: string, where: string | null) => {
      const entry = rulesOf(v2).find(
        (one) =>
          (where === null || one.where === where) &&
          one.rule.selectors.map((s) => s.trim()).includes(selector),
      );
      return entry?.rule.source?.start?.line ?? Number.NaN;
    };
    for (const { selector, base } of LEAVES) {
      const mine = specificity(selector);
      const theirs = specificity(base);
      const wins =
        beats(mine, theirs) || (ties(mine, theirs) && line(selector, DESKTOP) > line(base, ""));
      expect(wins, `${selector} over ${base}`).toBe(true);
    }
    // The one that would have flipped: the title's size in the side column.
    expect(valueOf(v2, DESKTOP, `${BOTH} .v2-row b.v2-row-title`, "font-size")).toBe("14px");
    expect(beats(specificity(`${BOTH} .v2-row b.v2-row-title`), [3, 0])).toBe(true);
  });

  // The rewritten rules now tie their base at two classes, and both later
  // sheets load after v2.css. A bare leaf rule in either would win on Today's
  // own page by order alone, so a pane's restyle there has to be scoped under
  // .v2-pane (or any other class) and never be the leaf on its own.
  test("leaves no later sheet a bare rule on any of those leaves", () => {
    const bare = new Set(LEAVES.map(({ base }) => base));
    bare.add("[data-v2-root] .v2-row b");
    for (const [name, sheet] of [
      ["desk.css", desk],
      ["calendar.css", postcss.parse(readFileSync(path.join(ROOT, "app/v2/calendar.css"), "utf8"))],
    ] as const) {
      const found = rulesOf(sheet)
        .flatMap((entry) => entry.rule.selectors.map((one) => one.trim()))
        .filter((one) => bare.has(one));
      expect(found, name).toEqual([]);
    }
  });

  test("sizes the date and the lit title by the pane, over the desktop tier's sizes", () => {
    const h1 = "[data-v2-root] .v2-pane .v2-top h1";
    const lit = "[data-v2-root] .v2-pane .v2-lit h3";
    expect(valueOf(v2, "", h1, "font-size")).toBe("clamp(18px, 5.4cqw, 21px)");
    expect(valueOf(v2, "", lit, "font-size")).toBe("clamp(18px, 5.2cqw, 21px)");
    // The tier's 30px and 21px are written on a weaker selector, so a pane's
    // own size holds on a desktop window too.
    expect(beats(specificity(h1), specificity("[data-v2-root] .v2-top h1"))).toBe(true);
    expect(beats(specificity(lit), specificity("[data-v2-root] .v2-lit h3"))).toBe(true);
    // And the page's own vw sizes are untouched.
    expect(valueOf(v2, "", "[data-v2-root] .v2-top h1", "font")).toContain("5.4vw");
    expect(valueOf(v2, "", "[data-v2-root] .v2-lit h3", "font")).toContain("5.2vw");
  });

  test("lays a list out one, two and three across by the pane's own width", () => {
    const rows = "[data-v2-root] .v2-pane .v2-list-rows";
    expect(valueOf(v2, "", rows, "grid-template-columns")).toBe("minmax(0, 1fr)");
    expect(valueOf(v2, "@container v2-pane (width >= 600px)", rows, "grid-template-columns")).toBe(
      "repeat(2, minmax(0, 1fr))",
    );
    expect(valueOf(v2, "@container v2-pane (width >= 900px)", rows, "grid-template-columns")).toBe(
      "repeat(3, minmax(0, 1fr))",
    );
    // The page's own rows are as they were.
    expect(valueOf(v2, DESKTOP, "[data-v2-root] .v2-list-rows", "grid-template-columns")).toBe(
      "repeat(auto-fill, minmax(min(280px, 100%), 1fr))",
    );
  });

  // The cap is on the day pane's whole column, so the date and the energy
  // control stay with the line rather than stretching across a wide pane.
  test("never lets the day's line grow wider than 640px in a pane", () => {
    expect(valueOf(desk, "", "[data-v2-root] .v2-pane-day", "max-width")).toBe("640px");
    const { container } = drawPanes(["today"]);
    const column = boxOf(container, "today").querySelector(".v2-pane-day") as HTMLElement;
    expect(column.querySelector(".v2-line")).not.toBeNull();
    expect(column.querySelector(".v2-energy")).not.toBeNull();
    expect(column.querySelector(".v2-top")).not.toBeNull();
  });

  test("makes the box a named inline-size container that scrolls on the block axis", () => {
    expect(valueOf(desk, "", "[data-v2-root] .v2-pane", "container-type")).toBe("inline-size");
    expect(valueOf(desk, "", "[data-v2-root] .v2-pane", "container-name")).toBe("v2-pane");
    expect(valueOf(desk, "", "[data-v2-root] .v2-pane", "width")).toBe("100%");
    expect(valueOf(desk, "", "[data-v2-root] .v2-pane", "height")).toBe("100%");
    const body = "[data-v2-root] .v2-pane-body";
    expect(valueOf(desk, "", body, "overflow-y")).toBe("auto");
    expect(valueOf(desk, "", body, "min-height")).toBe("0");
    // The ring the lists have: inside the box, where an edge cannot cut it off.
    expect(valueOf(desk, "", `${body}:focus-visible`, "outline-offset")).toBe("-2px");
  });

  test("is loaded after the sheets whose tokens and leaves it builds on", () => {
    const layout = readFileSync(path.join(ROOT, "app/v2/layout.tsx"), "utf8");
    const at = (sheet: string) => layout.indexOf(`import "./${sheet}";`);
    expect(at("v2.css")).toBeGreaterThan(-1);
    expect(at("calendar.css")).toBeGreaterThan(at("v2.css"));
    expect(at("desk.css")).toBeGreaterThan(at("calendar.css"));
  });
});
