// @vitest-environment node
// The calendar, read from a local snapshot folder.
//
// EVERYTHING IN THIS FILE IS INVENTED. The folder is built in a temp directory,
// the two accounts, the groups and the calendar are made up, and the zone has no
// daylight saving so every instant below is stable. Nothing here reads the
// owner's export, and nothing here writes anywhere but the temp dir.
//
// The folder is deliberately awkward in the ways a real one is: a calendar list
// that is not there at all, a range that is not there at all, an event on a
// calendar nothing lists, and the OTHER account's group pointing at one of this
// account's calendars.
//
// WHAT MATTERS MOST HERE is the difference between "nothing is on that day" and
// "this copy cannot say". A folder holds whatever week was exported, and a day
// outside it must never be drawn as a free day.

import { readFileSync } from "node:fs";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, afterEach, describe, expect, test, vi } from "vitest";

import { weekOf } from "@/app/lib/v2/calendar/grid";
import { sampleWeek } from "@/app/lib/v2/fixtures/sample-week";
import { loadLocalCalendar } from "@/app/lib/v2/local/calendar";
import { LocalSnapshotError, loadLocalToday } from "@/app/lib/v2/local/snapshot";
import { buildCalendarView } from "@/app/lib/v2/view/calendar";
import type { CalendarScreenData, TodayScreenData } from "@/app/lib/v2/view/screen-data";

// The page's one child is stubbed: what is under test below is which week the
// page asks for, not what the screen does with it.
vi.mock("@/app/v2/today/today-client", () => ({
  TodayClient: function TodayClient() {
    return null;
  },
}));

// There is no request in a test, and the page reads one header. Every case below
// comes from this machine and says so.
vi.mock("next/headers", () => ({
  headers: () =>
    Promise.resolve({
      get: (name: string) => (name.toLowerCase() === "host" ? "127.0.0.1:3111" : null),
    }),
}));

const MINE = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const GROUP_READING = "33333333-3333-4333-8333-333333333333";
const GROUP_SHOP = "44444444-4444-4444-8444-444444444444";
const GROUP_THEIRS = "55555555-5555-4555-8555-555555555555";

const ZONE = "America/Phoenix";
const OFFSET = "-07:00";
/** A Wednesday. Monday first, its week is the 13th to the 19th. */
const DAY = "2026-04-15";
const NOW = `${DAY}T10:20:00${OFFSET}`;
const WEEK = weekOf(DAY);
const NEXT = weekOf("2026-04-22");

const at = (clock: string, date: string = DAY) => `${date}T${clock}:00${OFFSET}`;

const SNAPSHOT = {
  userId: MINE,
  timeZone: ZONE,
  takenAt: at("09:05"),
  capCalendarIds: ["cal-shift"],
};

const RULES_DOC = {
  planner: {
    timeZone: ZONE,
    wakeByWeekday: ["07:30", "07:30", "07:30", "07:30", "07:30", "07:30", "07:30"],
    lightsOut: "23:30",
    noFocusBefore: "08:30",
    bufferMinutes: 10,
    weeklyHourCap: 30,
    incomeTarget: { lane: "lane-work", weeklyHours: 10, blockMinutes: 120 },
  },
  lanes: [
    { key: "lane-study", label: "Reading", color: "#7C9BFF", groupIds: [GROUP_READING] },
  ],
  feedLabels: {},
};

const TASK_ROWS = [
  {
    id: "ta-essay",
    user_id: MINE,
    group_id: GROUP_READING,
    title: "Second draft",
    due_date: "2026-04-16",
    status: "todo",
    estimated_minutes: 120,
  },
  // Time blocked for this afternoon, and never pushed to Google: it has a slot
  // on the day and no event anywhere, which is why the day and the calendar can
  // only be compared on the events that came from the calendar.
  {
    id: "ta-clinic",
    user_id: MINE,
    group_id: GROUP_READING,
    title: "Clinic",
    due_date: DAY,
    due_time: "14:30",
    status: "todo",
    duration_min: 60,
  },
];

const GROUP_ROWS = [
  {
    id: GROUP_READING,
    user_id: MINE,
    name: "Reading",
    color: "#7C9BFF",
    archived: false,
    // This account's own group, linked to one of its calendars.
    google_calendar_id: "cal-campus",
  },
  {
    id: GROUP_SHOP,
    user_id: MINE,
    name: "Shop",
    color: "#2FD6A3",
    archived: false,
    google_calendar_id: null,
  },
  // The OTHER account's group, pointing at a calendar in this account's export.
  // It must not name anything here.
  {
    id: GROUP_THEIRS,
    user_id: OTHER,
    name: "Not yours",
    color: "#111111",
    archived: false,
    google_calendar_id: "cal-shift",
  },
];

const EVENT_ROWS = [
  {
    id: "cal-campus:ev-mon",
    summary: "Studio induction",
    start: at("11:00", "2026-04-13"),
    end: at("12:00", "2026-04-13"),
    allDay: false,
    calendarId: "cal-campus",
  },
  {
    id: "cal-campus:ev-seminar",
    summary: "Morning seminar",
    start: at("09:00"),
    end: at("10:15"),
    allDay: false,
    calendarId: "cal-campus",
    location: "Hall B",
  },
  {
    id: "cal-shift:ev-shift",
    summary: "Shop shift",
    start: at("18:30"),
    end: at("21:00"),
    allDay: false,
    calendarId: "cal-shift",
    recurring: true,
  },
  {
    id: "cal-campus:ev-allday",
    summary: "Library closed",
    start: DAY,
    end: "2026-04-16",
    allDay: true,
    calendarId: "cal-campus",
  },
  // On a calendar neither the list nor any group knows.
  {
    id: "cal-stranger:ev-stranger",
    summary: "Someone else's booking",
    start: at("09:00", "2026-04-17"),
    end: at("10:00", "2026-04-17"),
    allDay: false,
    calendarId: "cal-stranger",
  },
  // The last day this export has anything on: it is what the derived range ends
  // at, which puts part of the following week inside the copy and none of the
  // week before it.
  {
    id: "cal-shift:ev-next",
    summary: "Shop shift",
    start: at("09:00", "2026-04-24"),
    end: at("13:00", "2026-04-24"),
    allDay: false,
    calendarId: "cal-shift",
  },
];

const CALENDAR_ROWS = [
  { id: "cal-campus", label: "Campus", color: "#7C9BFF", writable: true },
  { id: "cal-shift", label: "Print shop", color: null, writable: false },
];

const DEFAULT_FILES: Record<string, string> = {
  "snapshot.json": JSON.stringify(SNAPSHOT, null, 2),
  "rules.json": JSON.stringify(RULES_DOC, null, 2),
  "tasks.json": JSON.stringify(TASK_ROWS, null, 2),
  "groups.json": JSON.stringify(GROUP_ROWS, null, 2),
  "income_sources.json": JSON.stringify([], null, 2),
  "calendar-events.json": JSON.stringify(EVENT_ROWS, null, 2),
};

const made: string[] = [];

/** A snapshot folder. `null` leaves that file out, a string replaces it. */
async function folder(overrides: Record<string, string | null> = {}): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "v2-local-calendar-"));
  made.push(dir);
  for (const [name, body] of Object.entries({ ...DEFAULT_FILES, ...overrides })) {
    if (body === null) continue;
    await writeFile(path.join(dir, name), body, "utf8");
  }
  return dir;
}

async function load(
  overrides: Record<string, string | null> = {},
  weekParam: string | null = null,
): Promise<CalendarScreenData> {
  const week = await loadLocalCalendar(await folder(overrides), NOW, weekParam);
  if (week === null) throw new Error("the folder answered no calendar at all");
  return week;
}

async function thrown(
  overrides: Record<string, string | null>,
): Promise<LocalSnapshotError> {
  try {
    await loadLocalCalendar(await folder(overrides), NOW, null);
  } catch (error) {
    if (error instanceof LocalSnapshotError) return error;
    throw error;
  }
  throw new Error("the folder loaded when it should not have");
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

afterAll(async () => {
  for (const dir of made) await rm(dir, { recursive: true, force: true });
});

describe("the week it reads", () => {
  test("is the week the planning day falls in", async () => {
    expect((await load()).week).toEqual(WEEK);
  });

  test("runs on the snapshot's zone and the clock it was given", async () => {
    const week = await load();
    expect(week.timeZone).toBe(ZONE);
    expect(Date.parse(week.now)).toBe(Date.parse(NOW));
    // Sub-second precision is poison downstream, so it is floored.
    const fuzzy = await loadLocalCalendar(await folder(), `${DAY}T10:20:00.750${OFFSET}`, null);
    expect(Date.parse(String(fuzzy?.now)) % 1000).toBe(0);
  });

  test("spans the hours the rules document says a day spans", async () => {
    expect((await load()).dayWindow).toEqual({ fromMinute: 510, toMinute: 1410 });
  });

  test("is nothing at all when the folder has no events file", async () => {
    expect(await loadLocalCalendar(await folder({ "calendar-events.json": null }), NOW, null))
      .toBeNull();
  });

  test("carries every event of the week and none from outside it", async () => {
    const ids = (await load()).events.map((event) => event.id).sort();
    expect(ids).toEqual([
      "cal-campus:ev-allday",
      "cal-campus:ev-mon",
      "cal-campus:ev-seminar",
      "cal-shift:ev-shift",
      "cal-stranger:ev-stranger",
    ]);
  });

  test("reads an all day event as the days it covers, Google's end exclusive", async () => {
    const notice = (await load()).events.find((event) => event.allDay);
    expect(notice?.start).toBe(DAY);
    expect(notice?.end).toBe("2026-04-16");
  });

  test("carries the repeating flag, and false where the file is silent", async () => {
    const events = new Map((await load()).events.map((event) => [event.id, event]));
    expect(events.get("cal-shift:ev-shift")?.recurring).toBe(true);
    expect(events.get("cal-campus:ev-seminar")?.recurring).toBe(false);
  });

  test("takes writability from the calendar the event is on", async () => {
    const events = new Map(
      (await load({ "calendars.json": JSON.stringify(CALENDAR_ROWS) })).events.map(
        (event) => [event.id, event],
      ),
    );
    expect(events.get("cal-campus:ev-seminar")?.editable).toBe(true);
    expect(events.get("cal-shift:ev-shift")?.editable).toBe(false);
    // A calendar nothing lists is not known to be writable, so it is not.
    expect(events.get("cal-stranger:ev-stranger")?.editable).toBe(false);
  });
});

describe("which days this copy can speak for", () => {
  test("is every day from the first event to the last, when nothing says", async () => {
    const week = await load();
    expect(week.covered).toEqual(WEEK);
    // The first event is on the Monday and the last is in the following week, so
    // there is a way forward and none back.
    expect(week.nextWeek).toBe(NEXT[0]);
    expect(week.prevWeek).toBeNull();
    expect(week.thisWeek).toBeNull();
  });

  test("is exactly the range when the snapshot gives one", async () => {
    const week = await load({
      "snapshot.json": JSON.stringify({
        ...SNAPSHOT,
        calendarRange: { from: DAY, to: "2026-04-17" },
      }),
    });
    expect(week.covered).toEqual([DAY, "2026-04-16", "2026-04-17"]);
    expect(week.prevWeek).toBeNull();
    expect(week.nextWeek).toBeNull();
  });

  // The defect this pins: a day the export does not cover drawn as a free day.
  // There IS an event on the Monday, and the range says the copy cannot speak
  // for that day, so the day reads as unknown and holds nothing.
  test("leaves a day outside the range uncovered, event or no event", async () => {
    const week = await load({
      "snapshot.json": JSON.stringify({
        ...SNAPSHOT,
        calendarRange: { from: DAY, to: "2026-04-17" },
      }),
    });
    expect(week.covered).not.toContain("2026-04-13");
    const view = buildCalendarView(week, []);
    const monday = view.days[0];
    expect(monday.covered).toBe(false);
    expect(monday.chips).toEqual([]);
  });

  test("can speak for nothing at all when the events file is empty", async () => {
    const week = await load({ "calendar-events.json": "[]" });
    expect(week.events).toEqual([]);
    expect(week.covered).toEqual([]);
    expect(week.prevWeek).toBeNull();
    expect(week.nextWeek).toBeNull();
    // Not "nothing on this week": the copy says nothing about this week at all.
    expect(buildCalendarView(week, []).empty).toBe(false);
  });
});

describe("which week it is asked for", () => {
  test("takes a day of a week the copy covers", async () => {
    const week = await load({}, "2026-04-22");
    expect(week.week).toEqual(NEXT);
    expect(week.prevWeek).toBe(WEEK[0]);
    expect(week.nextWeek).toBeNull();
    expect(week.thisWeek).toBe(WEEK[0]);
    // The copy ends on the Friday of that week.
    expect(week.covered).toEqual(NEXT.slice(0, 5));
  });

  test("ignores a week the copy cannot speak for", async () => {
    for (const asked of ["2026-04-06", "2026-06-01", "2025-12-29"]) {
      expect((await load({}, asked)).week, asked).toEqual(WEEK);
    }
  });

  test("ignores anything that is not a day that exists", async () => {
    for (const asked of ["", "2026-4-22", "2026-02-30", "2026-13-45", "tomorrow", "../.."]) {
      expect((await load({}, asked)).week, asked).toEqual(WEEK);
    }
  });
});

describe("the calendars it names", () => {
  test("are the list in the folder when there is one", async () => {
    const week = await load({ "calendars.json": JSON.stringify(CALENDAR_ROWS) });
    expect(week.calendars).toEqual([
      { id: "cal-campus", label: "Campus", color: "#7C9BFF", writable: true },
      { id: "cal-shift", label: "Print shop", color: null, writable: false },
    ]);
  });

  test("names one per calendar in the events when there is not", async () => {
    const week = await load();
    expect(week.calendars.map((calendar) => calendar.id)).toEqual([
      "cal-campus",
      "cal-shift",
      "cal-stranger",
    ]);
  });

  test("take this account's own group's name and colour where one is linked", async () => {
    const week = await load();
    expect(week.calendars[0]).toEqual({
      id: "cal-campus",
      label: "Reading",
      color: "#7C9BFF",
      writable: false,
    });
  });

  test("are called plainly where no group of this account is linked", async () => {
    const week = await load();
    expect(week.calendars[1]).toEqual({
      id: "cal-shift",
      label: "Calendar",
      color: null,
      writable: false,
    });
  });

  test("never take the OTHER account's group's name", async () => {
    const week = await load();
    const everywhere = strings(week).join("|");
    expect(everywhere).not.toContain("Not yours");
    expect(everywhere).not.toContain(OTHER);
    expect(everywhere).not.toContain(GROUP_THEIRS);
  });

  test("fall back to a plain name when the list leaves one blank", async () => {
    const week = await load({
      "calendars.json": JSON.stringify([{ id: "cal-campus", label: "   " }]),
    });
    expect(week.calendars).toEqual([
      { id: "cal-campus", label: "Calendar", color: null, writable: false },
    ]);
  });

  test("keep an event whose calendar nothing names, labelled plainly", async () => {
    const view = buildCalendarView(
      await load({ "calendars.json": JSON.stringify(CALENDAR_ROWS) }),
      [],
    );
    const friday = view.days[4];
    expect(friday.chips.map((chip) => chip.id)).toEqual(["cal-stranger:ev-stranger"]);
    expect(friday.chips[0].calendar).toBe("Calendar");
    expect(friday.chips[0].color).toBeNull();
  });
});

// The day and the calendar are two views of the same Wednesday, built by two
// different functions. Everything that came OUT OF THE CALENDAR has to be the
// same thing in both: the same id and the same instants. A task's own time block
// is not one of those (it has no event at all, and the planner re-ids a task
// that does), which is why this names what it covers.
describe("the day and the calendar beside it agree", () => {
  test("the day carries the week of its own planned day", async () => {
    const today = await loadLocalToday(await folder(), NOW, null);
    expect(today.calendar).not.toBeNull();
    expect(today.calendar?.week).toEqual(WEEK);
    expect(today.calendar?.now).toBe(today.input.now);
  });

  test("every calendar event on the day is in the week, same id and time", async () => {
    const dir = await folder();
    const today = await loadLocalToday(dir, NOW, null);
    const events = new Map((today.calendar?.events ?? []).map((event) => [event.id, event]));
    const fromCalendar = today.input.fixed.filter((event) => !event.id.startsWith("task:"));
    expect(fromCalendar.length).toBeGreaterThan(0);
    for (const event of fromCalendar) {
      const same = events.get(event.id);
      expect(same, event.id).toBeDefined();
      expect(same?.title).toBe(event.title);
      if (!event.allDay) {
        expect(Date.parse(String(same?.start))).toBe(Date.parse(event.start));
        expect(Date.parse(String(same?.end))).toBe(Date.parse(event.end));
      }
    }
  });

  test("follows the day when the day is moved to another week", async () => {
    const today = await loadLocalToday(await folder(), NOW, "2026-04-22");
    expect(today.input.date).toBe("2026-04-22");
    expect(today.calendar?.week).toEqual(NEXT);
  });

  test("is null when the folder has no calendar at all", async () => {
    const today = await loadLocalToday(await folder({ "calendar-events.json": null }), NOW, null);
    expect(today.calendar).toBeNull();
    expect(today.notice).toContain("Calendar not included.");
  });
});

// The calendar's week links are plain links back to the page the pane is on, so
// the page has to read `week`. Without this the Previous, Next and This week
// links on the Today screen would be dead, and nothing on the screen would say
// why: the pane would simply redraw the same week.
describe("the page hands the calendar the week it was asked for", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /**
   * The page, rendered one level deep: it decides the source synchronously and
   * returns one child that awaits everything else.
   */
  async function render(
    search: Record<string, string | string[]> = {},
  ): Promise<TodayScreenData> {
    const { default: TodayPage } = await import("@/app/v2/today/page");
    const outer = TodayPage({ searchParams: Promise.resolve(search) }) as unknown as {
      type: (props: unknown) => Promise<{ props: { data: TodayScreenData } }>;
      props: unknown;
    };
    return (await outer.type(outer.props)).props.data;
  }

  async function local(overrides: Record<string, string | null> = {}) {
    vi.stubEnv("V2_FIXTURES", "");
    vi.stubEnv("V2_LOCAL_SNAPSHOT", await folder(overrides));
    vi.stubEnv("VERCEL_ENV", "preview");
  }

  function sample() {
    vi.stubEnv("V2_FIXTURES", "1");
    vi.stubEnv("V2_LOCAL_SNAPSHOT", "");
    vi.stubEnv("VERCEL_ENV", "preview");
  }

  test("shows a week of the snapshot that the link asks for", async () => {
    await local();
    const asked = await render({ week: "2026-04-22" });
    expect(asked.calendar?.week).toEqual(NEXT);
    // The day beside it has not moved: the link is the calendar's, not the day's.
    const plain = await render();
    expect(asked.input.date).toBe(plain.input.date);
  });

  test("ignores a week parameter it cannot use, and shows the default week", async () => {
    await local();
    const plain = await render();
    for (const week of ["", "2026-4-22", "2026-02-30", "nonsense", "2020-01-06"]) {
      const asked = await render({ week });
      expect(asked.calendar?.week, week).toEqual(plain.calendar?.week);
    }
    // A repeated parameter arrives as a list, which is not a week.
    const listed = await render({ week: ["2026-04-22", "2026-04-22"] });
    expect(listed.calendar?.week).toEqual(plain.calendar?.week);
  });

  test("shows the sample's other week when the link asks for it", async () => {
    sample();
    const asked = await render({ week: "2026-04-22" });
    expect(asked.calendar).toEqual(sampleWeek("2026-04-22"));
    expect(asked.calendar?.week).toEqual(NEXT);
  });

  test("shows the sample's own week with no parameter at all", async () => {
    sample();
    expect((await render()).calendar).toEqual(sampleWeek(null));
  });
});

describe("a folder that is wrong", () => {
  test("names a range whose day does not exist", async () => {
    const error = await thrown({
      "snapshot.json": JSON.stringify({
        ...SNAPSHOT,
        calendarRange: { from: "2026-02-30", to: "2026-04-17" },
      }),
    });
    expect(error.file).toBe("snapshot.json");
    expect(error.message).toContain("calendarRange");
    expect(error.message).toContain("from");
    expect(error.message).not.toContain("2026-02-30");
  });

  test("names a range that is missing an end", async () => {
    const error = await thrown({
      "snapshot.json": JSON.stringify({ ...SNAPSHOT, calendarRange: { from: DAY } }),
    });
    expect(error.message).toContain("calendarRange.to");
  });

  test("names a colour that is not a six digit hex", async () => {
    for (const color of ["red", "#ABC", "#1234567", "rgb(1,2,3)"]) {
      const error = await thrown({
        "calendars.json": JSON.stringify([{ id: "cal-campus", label: "Campus", color }]),
      });
      expect(error.file).toBe("calendars.json");
      expect(error.message).toContain("color");
      expect(error.message).not.toContain(color);
    }
  });

  test("names a calendar list that is not a list of calendars", async () => {
    expect((await thrown({ "calendars.json": JSON.stringify({ rows: [] }) })).file).toBe(
      "calendars.json",
    );
    const noId = await thrown({ "calendars.json": JSON.stringify([{ label: "Campus" }]) });
    expect(noId.message).toContain("id");
  });

  test("names a calendar list that is not valid JSON", async () => {
    const error = await thrown({ "calendars.json": "{ not json" });
    expect(error.file).toBe("calendars.json");
    expect(error.message).toContain("JSON");
  });

  test("never quotes a value out of the folder", async () => {
    const error = await thrown({
      "calendars.json": JSON.stringify([
        { id: "cal-campus", label: "a-secret-name", color: "a-secret-colour" },
      ]),
    });
    expect(error.message).not.toContain("a-secret-name");
    expect(error.message).not.toContain("a-secret-colour");
  });
});

describe("it only ever reads, and only inside the folder", () => {
  test("leaves the folder exactly as it found it", async () => {
    const dir = await folder({ "calendars.json": JSON.stringify(CALENDAR_ROWS) });
    const before = (await readdir(dir)).sort();
    await loadLocalCalendar(dir, NOW, null);
    expect((await readdir(dir)).sort()).toEqual(before);
  });

  const ROOT = path.resolve(__dirname, "..");
  const source = (file: string) => readFileSync(path.join(ROOT, file), "utf8");
  const owned = [
    "app/lib/v2/local/calendar.ts",
    "app/lib/v2/local/snapshot.ts",
    "app/lib/v2/local/files.ts",
  ];

  test("writes nothing and logs nothing", () => {
    for (const file of owned) {
      const code = source(file);
      for (const forbidden of [
        "console.",
        "writeFile",
        "appendFile",
        "unlink",
        "mkdir",
        "rmdir",
        "createWriteStream",
      ]) {
        expect(code, file).not.toContain(forbidden);
      }
    }
  });

  test("still reads through the one door, with the names as literals", () => {
    const code = owned.map(source).join("\n");
    expect(code.match(/readFile\(/g)).toHaveLength(1);
    for (const name of ["calendars.json", "calendar-events.json", "snapshot.json"]) {
      expect(code).toContain(`"${name}"`);
    }
  });
});

describe("the copy rules", () => {
  // Built from code points on purpose, so this file stays pure ASCII.
  const EM_DASH = String.fromCodePoint(0x2014);
  const EN_DASH = String.fromCodePoint(0x2013);

  test("use no em dash and no en dash, in the week or in an error", async () => {
    const everything = [
      ...strings(await load()),
      ...strings(buildCalendarView(await load(), [])),
      (await thrown({ "calendars.json": "{ not json" })).message,
    ];
    expect(everything.length).toBeGreaterThan(20);
    for (const text of everything) {
      expect(text).not.toContain(EM_DASH);
      expect(text).not.toContain(EN_DASH);
    }
  });
});
