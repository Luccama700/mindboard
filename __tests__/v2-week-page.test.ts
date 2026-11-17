// PLAN-OS Task 2, behaviour 12: the Week page.
//
// It goes through the gate exactly as Today does: the page decides the source
// synchronously, so a route that is off answers a real 404 before anything
// streams, and everything that has to wait (the loopback check, the search
// parameters, the folder) lives in the one child it returns. The static half of
// that rule is __tests__/v2-source.test.ts, which walks this page the moment it
// exists; what is pinned here is that it actually behaves that way.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { createElement, type ReactElement } from "react";

import postcss from "postcss";
import { cleanup, render, screen } from "@testing-library/react";
import { afterAll, afterEach, describe, expect, test, vi } from "vitest";

// There is no request in a test, and the snapshot branch reads one header.
vi.mock("next/headers", () => ({
  headers: () =>
    Promise.resolve({
      get: (name: string) => (name.toLowerCase() === "host" ? "127.0.0.1:3111" : null),
    }),
}));

import { SAMPLE_NOTICE, sampleDay } from "@/app/lib/v2/fixtures/sample-day";
import { sampleWeek } from "@/app/lib/v2/fixtures/sample-week";
import { CALENDAR_COPY } from "@/app/lib/v2/view/calendar";
import type { TodayScreenData } from "@/app/lib/v2/view/screen-data";
import { TODAY_COPY } from "@/app/lib/v2/view/today";
import { SnapshotError } from "@/app/v2/_components/snapshot-error";
import WeekPage, { dynamic } from "@/app/v2/week/page";
import { WeekClient } from "@/app/v2/week/week-client";

/** What `notFound()` throws, as Next spells it (http-access-fallback.js). */
const NOT_FOUND_DIGEST = "NEXT_HTTP_ERROR_FALLBACK;404";

/** An invented account's snapshot, taken at an invented time. */
const SNAPSHOT_JSON = JSON.stringify({
  userId: "66666666-6666-4666-8666-666666666666",
  timeZone: "America/Phoenix",
  takenAt: "2026-04-15T09:05:00-07:00",
});

/** What Today and Week both say about that snapshot. */
const LOCAL_NOTICE =
  "Your data as of Wednesday 15 April 09:05. A local copy: nothing you tap is saved.";

/** A whole folder, small and invented, that both pages can read. */
const WHOLE_FOLDER: Record<string, string> = {
  "snapshot.json": SNAPSHOT_JSON,
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
  "calendar-events.json": JSON.stringify([
    {
      id: "cal-a:ev-one",
      summary: "Studio induction",
      start: "2026-04-15T11:00:00-07:00",
      end: "2026-04-15T12:00:00-07:00",
      allDay: false,
      calendarId: "cal-a",
    },
  ]),
};

const made: string[] = [];

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await Promise.all(made.map((dir) => rm(dir, { recursive: true, force: true })));
});

function sample() {
  vi.stubEnv("V2_FIXTURES", "1");
  vi.stubEnv("V2_LOCAL_SNAPSHOT", "");
  vi.stubEnv("VERCEL_ENV", "preview");
}

/** A snapshot folder holding only the files given. */
async function local(files: Record<string, string> = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "v2-week-page-"));
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

/** The page, rendered one level deep: the source it chose, and what its child returns. */
async function page(search: Record<string, string | string[]> = {}) {
  const outer = WeekPage({ searchParams: Promise.resolve(search) }) as unknown as {
    type: (props: unknown) => Promise<ReactElement<Record<string, unknown>>>;
    props: { source?: unknown };
  };
  return { source: outer.props.source, inner: await outer.type(outer.props) };
}

describe("the Week page is gated as Today is", () => {
  test("is not found with the flag off and no snapshot folder", () => {
    vi.stubEnv("V2_FIXTURES", "");
    vi.stubEnv("V2_LOCAL_SNAPSHOT", "");
    vi.stubEnv("VERCEL_ENV", "preview");
    expect(digestOf(() => WeekPage())).toBe(NOT_FOUND_DIGEST);
  });

  test("is not found in production, flag or no flag", () => {
    vi.stubEnv("V2_FIXTURES", "1");
    vi.stubEnv("V2_LOCAL_SNAPSHOT", "");
    vi.stubEnv("VERCEL_ENV", "production");
    expect(digestOf(() => WeekPage())).toBe(NOT_FOUND_DIGEST);
  });

  test("asks to be rendered per request, so the gate is never prerendered", () => {
    expect(dynamic).toBe("force-dynamic");
  });
});

describe("the Week page shows the week it is asked for", () => {
  test("hands the sample's own week to the screen with no parameter", async () => {
    sample();
    const { source, inner } = await page();
    expect(source).toEqual({ kind: "sample" });
    expect(inner.type).toBe(WeekClient);
    expect(inner.props.calendar).toEqual(sampleWeek(null));
  });

  test("hands over the week the link asks for, and ignores one it cannot use", async () => {
    sample();
    expect((await page({ week: "2026-04-22" })).inner.props.calendar).toEqual(
      sampleWeek("2026-04-22"),
    );
    // A repeated parameter arrives as a list, which is not a week.
    expect((await page({ week: ["2026-04-22", "2026-04-22"] })).inner.props.calendar).toEqual(
      sampleWeek(null),
    );
  });

  test("says in one sentence that a folder holds no calendar", async () => {
    await local({ "snapshot.json": SNAPSHOT_JSON });
    const { inner } = await page();
    expect(inner.type).toBe(WeekClient);
    expect(inner.props.calendar).toBeNull();
    render(inner);
    expect(screen.getAllByText(CALENDAR_COPY.noCalendar)).toHaveLength(1);
    expect(document.querySelector(".v2-cal")).toBeNull();
    // The rail is still there to leave by.
    expect(document.querySelector(".v2-nav")).not.toBeNull();
  });

  test("names the file it could not read, and draws no week from it", async () => {
    await local({ "snapshot.json": SNAPSHOT_JSON, "calendar-events.json": "this is not json" });
    const { inner } = await page();
    expect(inner.type).toBe(SnapshotError);
    render(inner);
    expect(document.body.textContent).toContain("calendar-events.json");
    expect(document.querySelector(".v2-cal")).toBeNull();
  });

  // Today survives a bad calendar list, because its day never reads one. This
  // page has nothing but the calendar, so for it the same file is the error.
  test("names a calendar list it could not read, where Today would carry on", async () => {
    await local({ ...WHOLE_FOLDER, "calendars.json": "{ not json" });
    const { inner } = await page();
    expect(inner.type).toBe(SnapshotError);
    render(inner);
    expect(document.body.textContent).toContain("calendars.json is not valid JSON.");
    expect(document.querySelector(".v2-cal")).toBeNull();
  });
});

// Today says what its data is under the date. The Week page used to say
// nothing, so a sample week and a stale copy looked exactly like a live one.
describe("the Week page says what its data is", () => {
  const noticeLine = () =>
    Array.from(document.querySelectorAll(".v2-week-main > .v2-notice")).map(
      (line) => line.textContent,
    );

  /** What the Today page hands its screen for the same request. */
  async function todayNotice(): Promise<string | null> {
    const { default: TodayPage } = await import("@/app/v2/today/page");
    const outer = TodayPage({ searchParams: Promise.resolve({}) }) as unknown as {
      type: (props: unknown) => Promise<ReactElement<{ data: TodayScreenData }>>;
      props: unknown;
    };
    return (await outer.type(outer.props)).props.data.notice;
  }

  test("in the sample, with the sample day's own sentence", async () => {
    sample();
    const { inner } = await page();
    expect(inner.props.notice).toBe(SAMPLE_NOTICE);
    expect(inner.props.notice).toBe(sampleDay().notice);
    render(inner);
    expect(noticeLine()).toEqual([SAMPLE_NOTICE]);
  });

  test("in a local copy, with the very sentence Today gives for the same folder", async () => {
    await local(WHOLE_FOLDER);
    const { inner } = await page();
    expect(inner.props.notice).toBe(LOCAL_NOTICE);
    expect(inner.props.notice).toBe(await todayNotice());
    render(inner);
    expect(noticeLine()).toEqual([LOCAL_NOTICE]);
    // One quiet line above the pane, and the pane as it always is.
    const main = document.querySelector(".v2-week-main") as HTMLElement;
    expect(Array.from(main.children).map((child) => child.className)).toEqual([
      "v2-hidden",
      "v2-notice",
      "v2-cal",
    ]);
  });

  test("and in a local copy with no calendar, saying that too", async () => {
    await local(
      Object.fromEntries(
        Object.entries(WHOLE_FOLDER).filter(([name]) => name !== "calendar-events.json"),
      ),
    );
    const { inner } = await page();
    expect(inner.props.notice).toBe(`${LOCAL_NOTICE} Calendar not included.`);
    expect(inner.props.notice).toBe(await todayNotice());
  });
});

// One home for the screen a folder that cannot be read gets, so Today and Week
// cannot come to say different things about the same folder.
describe("the snapshot error screen", () => {
  test("is the one component both pages hand the folder's error to", async () => {
    // A folder with nothing in it: Today cannot find its day.
    await local();
    const { default: TodayPage } = await import("@/app/v2/today/page");
    const outer = TodayPage({ searchParams: Promise.resolve({}) }) as unknown as {
      type: (props: unknown) => Promise<ReactElement<{ message?: unknown }>>;
      props: unknown;
    };
    const today = await outer.type(outer.props);
    expect(today.type).toBe(SnapshotError);
    expect(typeof today.props.message).toBe("string");

    await local({ "calendar-events.json": "this is not json" });
    expect((await page()).inner.type).toBe(SnapshotError);
  });

  test("says what failed, and that the folder was not touched", () => {
    render(createElement(SnapshotError, { message: "rules.json: not valid JSON" }));
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("The snapshot is not ready");
    expect(document.body.textContent).toContain("rules.json: not valid JSON");
    expect(document.body.textContent).toContain("Nothing was changed in it.");
  });
});

describe("the Week screen", () => {
  test("is the rail and the pane, with nothing planned on it", () => {
    const { container } = render(
      createElement(WeekClient, { calendar: sampleWeek(null), notice: null }),
    );
    const frame = container.firstElementChild as HTMLElement;
    expect(frame.className).toBe("v2-week");
    expect(Array.from(frame.children).map((child) => child.tagName.toLowerCase())).toEqual([
      "nav",
      "main",
    ]);
    const main = frame.querySelector("main") as HTMLElement;
    expect(main.querySelector(".v2-cal")).not.toBeNull();
    expect(container.querySelector('.v2-cal-chip[data-kind="planned"]')).toBeNull();
  });

  test("names the page for a screen reader, and marks Week in the rail", () => {
    render(createElement(WeekClient, { calendar: sampleWeek(null), notice: null }));
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(TODAY_COPY.nav.week);
    const current = document.querySelector('.v2-nav [aria-current="page"]');
    expect(current?.textContent).toBe("Week");
    expect(current?.getAttribute("href")).toBe("/v2/week");
  });

  test("keeps its week links on the Week page", () => {
    render(createElement(WeekClient, { calendar: sampleWeek(null), notice: null }));
    const links = Array.from(document.querySelectorAll<HTMLAnchorElement>(".v2-cal a"));
    expect(links.map((link) => link.getAttribute("href"))).toEqual(["/v2/week?week=2026-04-20"]);
  });

  test("fills the window beside the rail, at every width", () => {
    const sheet = postcss.parse(
      readFileSync(path.join(path.resolve(__dirname, ".."), "app/v2/calendar.css"), "utf8"),
    );
    const at = (params: string | null, selector: string, prop: string) => {
      let found: string | null = null;
      sheet.walkRules((rule) => {
        const parent = rule.parent;
        const media = parent?.type === "atrule" ? (parent as postcss.AtRule).params : null;
        if (media !== params) return;
        if (!rule.selectors.includes(`[data-v2-root] ${selector}`)) return;
        rule.walkDecls(prop, (decl) => {
          found = decl.value;
        });
      });
      return found;
    };
    expect(at(null, ".v2-week", "height")).toBe("100dvh");
    expect(at(null, ".v2-week-main", "flex")).toBe("1");
    expect(at("(min-width: 1024px)", ".v2-week", "grid-template-columns")).toBe(
      "auto minmax(0, 1fr)",
    );
    expect(at("(min-width: 1024px)", ".v2-week", "height")).toBe("100dvh");
  });
});
