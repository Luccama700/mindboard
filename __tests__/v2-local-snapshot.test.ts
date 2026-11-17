// @vitest-environment node
// Task 10, the Today screen on a local snapshot of real data.
//
// EVERYTHING IN THIS FILE IS INVENTED. The folder is built in a temp directory,
// the two accounts, the groups, the tasks and the calendar are made up, and the
// zone has no daylight saving so every instant below is stable. Nothing here
// reads the owner's export, and nothing here writes anywhere but the temp dir.
//
// The folder is deliberately awkward in the ways a real export is: two accounts
// in every row file, columns the engine has no use for, a null title, a status
// the engine does not know, an event whose start cannot be read, and a cap
// calendar that belongs to the other account.

import { readFileSync } from "node:fs";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { LocalSnapshotError, loadLocalToday, localSnapshotDir } from "@/app/lib/v2/local/snapshot";
import { isLoopbackHost } from "@/app/lib/v2/loopback";
import { wholeSecond } from "@/app/lib/v2/engine/tick";
import { planDay } from "@/app/lib/v2/plan/planner";
import { shiftDateKey } from "@/app/lib/v2/plan/day";
import { zonedDateKey } from "@/app/lib/snapshots/zoned-time";
import type { TodayScreenData } from "@/app/lib/v2/view/screen-data";

// The screen itself is being rewritten in parallel, so the page's one child is
// stubbed: what is under test here is which branch the page takes and what it
// hands over, not what the screen does with it.
vi.mock("@/app/v2/today/today-client", () => ({
  TodayClient: function TodayClient() {
    return null;
  },
}));

// The page reads one request header. There is no request in a test, so the one
// header it reads is stood in for; `sentHost` is what the client claimed to have
// asked for.
const sentHost = vi.hoisted(() => ({ value: null as string | null }));
vi.mock("next/headers", () => ({
  headers: () =>
    Promise.resolve({
      get: (name: string) => (name.toLowerCase() === "host" ? sentHost.value : null),
    }),
}));

/** What `notFound()` throws, as Next spells it (http-access-fallback.js). */
const NOT_FOUND_DIGEST = "NEXT_HTTP_ERROR_FALLBACK;404";

/** The error of something that should have answered 404, or a failure. */
async function refusal(run: () => unknown): Promise<{ digest?: unknown; message: string }> {
  try {
    await run();
  } catch (error) {
    return error as { digest?: unknown; message: string };
  }
  throw new Error("it answered when it should not have");
}

const ROOT = path.resolve(__dirname, "..");

const MINE = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const GROUP_READING = "33333333-3333-4333-8333-333333333333";
const GROUP_SHOP = "44444444-4444-4444-8444-444444444444";
const GROUP_THEIRS = "55555555-5555-4555-8555-555555555555";

const ZONE = "America/Phoenix";
const OFFSET = "-07:00";
/** A Wednesday. Monday to Sunday of its week is the 13th to the 19th. */
const DAY = "2026-04-15";
const NOW = `${DAY}T10:20:00${OFFSET}`;

const at = (clock: string, date: string = DAY) => `${date}T${clock}:00${OFFSET}`;

const SNAPSHOT = {
  userId: MINE,
  timeZone: ZONE,
  takenAt: at("09:05"),
  capCalendarIds: ["cal-shift"],
};

const RULES_DOC = {
  planner: {
    // Deliberately wrong: the snapshot's zone has to win over this one.
    timeZone: "UTC",
    wakeByWeekday: ["07:30", "07:30", "07:30", "07:30", "07:30", "07:30", "07:30"],
    lightsOut: "23:30",
    noFocusBefore: "08:30",
    bufferMinutes: 10,
    weeklyHourCap: 30,
    incomeTarget: { lane: "lane-work", weeklyHours: 10, blockMinutes: 120 },
  },
  lanes: [
    {
      key: "lane-study",
      label: "Reading",
      color: "#7C9BFF",
      groupIds: [GROUP_READING],
      hardDates: true,
    },
    {
      key: "lane-work",
      label: "Shop",
      color: "#2FD6A3",
      groupIds: [GROUP_SHOP],
      hardDates: false,
    },
  ],
  feedLabels: { "feed-calendar": "Calendar" },
};

/** Rows as the export has them: more columns than the engine reads. */
const TASK_ROWS = [
  {
    id: "ta-essay",
    user_id: MINE,
    group_id: GROUP_READING,
    title: "Second draft",
    due_date: "2026-04-16",
    due_time: null,
    status: "todo",
    estimated_minutes: 120,
    duration_min: null,
    gcal_event_id: null,
    gcal_calendar_id: null,
    notes: "a column the engine has no use for",
    priority: 2,
    ai_state: null,
    created_at: at("08:00", "2026-04-10"),
  },
  {
    id: "ta-ledger",
    user_id: MINE,
    group_id: GROUP_SHOP,
    // A null title is a row the export really can hold.
    title: null,
    due_date: null,
    due_time: null,
    status: "doing",
    estimated_minutes: 50,
    duration_min: null,
    completed_at: null,
  },
  {
    id: "ta-clinic",
    user_id: MINE,
    group_id: GROUP_READING,
    title: "Clinic",
    due_date: DAY,
    due_time: "14:30:00",
    status: "todo",
    estimated_minutes: 60,
    duration_min: 60,
  },
  {
    id: "ta-later",
    user_id: MINE,
    group_id: null,
    title: "Pack the box",
    due_date: "2026-04-18",
    due_time: "10:00",
    status: "todo",
    estimated_minutes: 30,
    duration_min: 30,
  },
  // Pushed to Google once, and its event now sits on another day. Its own slot
  // today is all there is to go on, so the day must still hold it.
  {
    id: "ta-pushed",
    user_id: MINE,
    group_id: GROUP_SHOP,
    title: "Stock count",
    due_date: DAY,
    due_time: "16:00",
    status: "todo",
    estimated_minutes: 45,
    duration_min: 45,
    gcal_event_id: "ev-pushed",
    gcal_calendar_id: "cal-campus",
  },
  // Pushed to Google and still there, moved to a later hour since. The event is
  // where it was last moved, so the day holds it once, at the event's time.
  {
    id: "ta-synced",
    user_id: MINE,
    group_id: GROUP_SHOP,
    title: "Deliveries",
    due_date: DAY,
    due_time: "19:30",
    status: "todo",
    estimated_minutes: 30,
    duration_min: 30,
    gcal_event_id: "ev-synced",
    gcal_calendar_id: "cal-campus",
  },
  // Timed for ten to midnight yesterday, with half an hour on it, so its slot
  // runs into today. It belongs to the day it starts on, not to this one.
  {
    id: "ta-overnight",
    user_id: MINE,
    group_id: null,
    title: "Last night's list",
    due_date: "2026-04-14",
    due_time: "23:50",
    status: "todo",
    estimated_minutes: 30,
    duration_min: 30,
  },
  { id: "ta-done", user_id: MINE, group_id: GROUP_SHOP, title: "Filed", status: "done" },
  // A status the engine does not know. It is not open, so it is not offered.
  { id: "ta-parked", user_id: MINE, group_id: GROUP_SHOP, title: "Parked", status: "parked" },
  {
    id: "ta-theirs",
    user_id: OTHER,
    group_id: GROUP_THEIRS,
    title: "Not yours",
    due_date: "2026-04-16",
    status: "todo",
  },
  // The other account's malformed row must not fail this account's file.
  { id: "ta-theirs-broken", user_id: OTHER, title: "Also not yours", due_date: "yesterday", status: "todo" },
];

const GROUP_ROWS = [
  {
    id: GROUP_READING,
    user_id: MINE,
    name: "Reading",
    color: "#7C9BFF",
    type: "project",
    archived: false,
    google_calendar_id: null,
  },
  { id: GROUP_SHOP, user_id: MINE, name: "Shop", color: "#2FD6A3", archived: false },
  { id: GROUP_THEIRS, user_id: OTHER, name: "Not yours", color: "#111111", archived: false },
];

const INCOME_ROWS = [
  { user_id: MINE, calendar_id: "cal-tutoring", hourly_wage: 25, tax_rate: 10 },
  { user_id: MINE, calendar_id: null, fixed_amount: 400, fixed_day: 1 },
  { user_id: OTHER, calendar_id: "cal-theirs", hourly_wage: 30 },
];

const EVENT_ROWS = [
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
  },
  // On an income source's calendar, so it counts toward the cap.
  {
    id: "cal-tutoring:ev-tutor-today",
    summary: "Tutoring",
    start: at("11:00"),
    end: at("12:00"),
    allDay: false,
    calendarId: "cal-tutoring",
  },
  {
    id: "cal-campus:ev-allday",
    summary: "Library closed",
    start: DAY,
    end: "2026-04-16",
    allDay: true,
    calendarId: "cal-campus",
  },
  // Ends exactly where the planning day starts, so it is not on it.
  {
    id: "cal-campus:ev-yesterday",
    summary: "Yesterday only",
    start: "2026-04-14",
    end: DAY,
    allDay: true,
    calendarId: "cal-campus",
  },
  {
    id: "cal-tutoring:ev-tutor-a",
    summary: "Tutoring",
    start: at("13:00", "2026-04-14"),
    end: at("15:00", "2026-04-14"),
    allDay: false,
    calendarId: "cal-tutoring",
  },
  // Overlaps the one above: three hours between them, not four.
  {
    id: "cal-tutoring:ev-tutor-b",
    summary: "Tutoring",
    start: at("14:00", "2026-04-14"),
    end: at("16:00", "2026-04-14"),
    allDay: false,
    calendarId: "cal-tutoring",
  },
  // The other account's income calendar. Eight hours that must not be counted.
  {
    id: "cal-theirs:ev-theirs",
    summary: "Their shift",
    start: at("09:00", "2026-04-14"),
    end: at("17:00", "2026-04-14"),
    allDay: false,
    calendarId: "cal-theirs",
  },
  // An all day event on a cap calendar is not a day of work.
  {
    id: "cal-shift:ev-allday-shift",
    summary: "Shop stocktake week",
    start: "2026-04-16",
    end: "2026-04-17",
    allDay: true,
    calendarId: "cal-shift",
  },
  // Next week's Monday: outside this week, so outside the week's cap.
  {
    id: "cal-shift:ev-next-week",
    summary: "Shop shift",
    start: at("09:00", "2026-04-20"),
    end: at("17:00", "2026-04-20"),
    allDay: false,
    calendarId: "cal-shift",
  },
  // The Google copy of ta-pushed, two days later than the task itself.
  {
    id: "cal-campus:ev-pushed",
    summary: "Stock count",
    start: at("09:00", "2026-04-17"),
    end: at("10:00", "2026-04-17"),
    allDay: false,
    calendarId: "cal-campus",
  },
  // The Google copy of ta-synced, on the day and an hour later than the task.
  {
    id: "cal-campus:ev-synced",
    summary: "Deliveries",
    start: at("20:30"),
    end: at("21:15"),
    allDay: false,
    calendarId: "cal-campus",
  },
  // No name at all, and a name that is only spaces. Both get the words the live
  // reader uses rather than an empty heading.
  {
    id: "cal-campus:ev-nameless",
    start: at("07:00"),
    end: at("07:30"),
    allDay: false,
    calendarId: "cal-campus",
  },
  {
    id: "cal-campus:ev-blank",
    summary: "   ",
    start: at("07:40"),
    end: at("08:00"),
    allDay: false,
    calendarId: "cal-campus",
  },
  {
    id: "cal-campus:ev-broken",
    summary: "Unreadable",
    start: "soon",
    end: "later",
    allDay: false,
    calendarId: "cal-campus",
  },
];

const DEFAULT_FILES: Record<string, string> = {
  "snapshot.json": JSON.stringify(SNAPSHOT, null, 2),
  "rules.json": JSON.stringify(RULES_DOC, null, 2),
  "tasks.json": JSON.stringify(TASK_ROWS, null, 2),
  "groups.json": JSON.stringify(GROUP_ROWS, null, 2),
  "income_sources.json": JSON.stringify(INCOME_ROWS, null, 2),
  "calendar-events.json": JSON.stringify(EVENT_ROWS, null, 2),
};

const made: string[] = [];

/**
 * A snapshot folder. `null` leaves that file out, a string or a buffer replaces
 * it. Buffers are how the encoding cases are written, since the encoding is the
 * thing under test.
 */
async function folder(
  overrides: Record<string, string | Buffer | null> = {},
): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "v2-local-snapshot-"));
  made.push(dir);
  for (const [name, body] of Object.entries({ ...DEFAULT_FILES, ...overrides })) {
    if (body === null) continue;
    await writeFile(path.join(dir, name), body, "utf8");
  }
  return dir;
}

async function load(
  overrides: Record<string, string | Buffer | null> = {},
  dateParam: string | null = null,
): Promise<TodayScreenData> {
  return loadLocalToday(await folder(overrides), NOW, dateParam);
}

/** U+FEFF, as a string, so this test file carries no byte order mark itself. */
const MARK = String.fromCodePoint(0xfeff);

/** The bytes Windows PowerShell 5.1 writes: UTF-16 with a byte order mark. */
function utf16(json: string, order: "le" | "be"): Buffer {
  const bytes = Buffer.from(`${MARK}${json}`, "utf16le");
  if (order === "le") return bytes;
  // Node has no UTF-16BE encoder, so the pairs are swapped by hand.
  const swapped = Buffer.from(bytes);
  swapped.swap16();
  return swapped;
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

async function thrown(
  overrides: Record<string, string | Buffer | null>,
): Promise<LocalSnapshotError> {
  try {
    await load(overrides);
  } catch (error) {
    if (error instanceof LocalSnapshotError) return error;
    throw error;
  }
  throw new Error("the folder loaded when it should not have");
}

let data: TodayScreenData;

beforeAll(async () => {
  data = await load();
});

afterAll(async () => {
  for (const dir of made) await rm(dir, { recursive: true, force: true });
});

describe("the gate on local mode", () => {
  test("opens for an absolute path outside production", () => {
    expect(localSnapshotDir({ V2_LOCAL_SNAPSHOT: os.tmpdir() })).toBe(os.tmpdir());
    expect(
      localSnapshotDir({ V2_LOCAL_SNAPSHOT: "/var/data/snapshot", VERCEL_ENV: "preview" }),
    ).toBe("/var/data/snapshot");
    expect(localSnapshotDir({ V2_LOCAL_SNAPSHOT: "C:\\data\\snapshot" })).toBe(
      "C:\\data\\snapshot",
    );
  });

  test("refuses a relative path, an empty one and no variable at all", () => {
    expect(localSnapshotDir({})).toBeNull();
    expect(localSnapshotDir({ V2_LOCAL_SNAPSHOT: "" })).toBeNull();
    expect(localSnapshotDir({ V2_LOCAL_SNAPSHOT: "   " })).toBeNull();
    expect(localSnapshotDir({ V2_LOCAL_SNAPSHOT: "snapshot" })).toBeNull();
    expect(localSnapshotDir({ V2_LOCAL_SNAPSHOT: "./snapshot" })).toBeNull();
    expect(localSnapshotDir({ V2_LOCAL_SNAPSHOT: "../snapshot" })).toBeNull();
    expect(localSnapshotDir({ V2_LOCAL_SNAPSHOT: "data/snapshot" })).toBeNull();
  });

  test("never opens in production, whatever the path says", () => {
    expect(
      localSnapshotDir({ V2_LOCAL_SNAPSHOT: "/var/data/snapshot", VERCEL_ENV: "production" }),
    ).toBeNull();
    expect(
      localSnapshotDir({ V2_LOCAL_SNAPSHOT: "C:\\data\\snapshot", VERCEL_ENV: "production" }),
    ).toBeNull();
  });
});

describe("the day it builds", () => {
  test("is a real plan input the planner can plan", () => {
    const plan = planDay(data.input);
    expect(plan.date).toBe(DAY);
    expect(plan.blocks.length).toBeGreaterThan(0);
  });

  test("runs on the snapshot's zone, not the rules document's", () => {
    expect(data.input.rules.timeZone).toBe(ZONE);
    // The rest of the planner half is still the document's.
    expect(data.input.rules.lightsOut).toBe("23:30");
    expect(data.input.rules.weeklyHourCap).toBe(30);
  });

  test("plans the day now falls on, with now floored to the whole second", async () => {
    expect(data.input.date).toBe(DAY);
    expect(Date.parse(data.input.now) % 1000).toBe(0);

    const fuzzy = await loadLocalToday(await folder(), `${DAY}T10:20:00.750${OFFSET}`, null);
    expect(fuzzy.input.now).toBe(wholeSecond(NOW));
    expect(Date.parse(fuzzy.input.now)).toBe(Date.parse(NOW));
  });

  test("starts empty, unanswered and in normal mode", () => {
    expect(data.input.existing).toEqual([]);
    expect(data.input.energy).toBeNull();
    expect(data.input.mode).toBe("normal");
  });

  test("has the real energy question open, so the control works", () => {
    expect(data.openAsks).toHaveLength(1);
    const ask = data.openAsks[0];
    expect(ask.kind).toBe("energy");
    expect(ask.status).toBe("open");
    expect(ask.id.length).toBeGreaterThan(0);
    expect(ask.dedupeKey).toBe(`energy:${DAY}`);
    expect(ask.options.map((option) => option.label)).toEqual(["Low", "OK", "Good"]);
  });
});

describe("the date parameter", () => {
  const dateOf = async (param: string | null) => (await load({}, param)).input.date;

  test("plans another day when it is within a fortnight either way", async () => {
    expect(await dateOf("2026-04-20")).toBe("2026-04-20");
    expect(await dateOf("2026-04-29")).toBe("2026-04-29");
    expect(await dateOf("2026-04-01")).toBe("2026-04-01");
  });

  test("is ignored past a fortnight, in either direction", async () => {
    expect(await dateOf("2026-04-30")).toBe(DAY);
    expect(await dateOf("2026-03-31")).toBe(DAY);
    expect(await dateOf("2027-04-15")).toBe(DAY);
  });

  test("is ignored when it is not a real date", async () => {
    expect(await dateOf("2026-02-30")).toBe(DAY);
    expect(await dateOf("2026-4-15")).toBe(DAY);
    expect(await dateOf("15/04/2026")).toBe(DAY);
    expect(await dateOf("")).toBe(DAY);
    expect(await dateOf("tomorrow")).toBe(DAY);
    expect(await dateOf(null)).toBe(DAY);
  });
});

describe("what is already on the day", () => {
  const ids = () => data.input.fixed.map((event) => event.id).sort();

  test("is this day's events and this day's time blocked tasks, and nothing else", () => {
    expect(ids()).toEqual([
      "cal-campus:ev-allday",
      "cal-campus:ev-blank",
      "cal-campus:ev-nameless",
      "cal-campus:ev-seminar",
      "cal-shift:ev-shift",
      "cal-tutoring:ev-tutor-today",
      "task:ta-clinic",
      "task:ta-pushed",
      "task:ta-synced",
    ]);
  });

  test("puts a task that is already on Google on the day once, at the event's time", () => {
    const synced = data.input.fixed.filter((event) => event.id === "task:ta-synced");
    expect(synced).toHaveLength(1);
    expect(synced[0].source).toBe("google");
    expect(Date.parse(synced[0].start)).toBe(Date.parse(at("20:30")));
    expect(data.input.candidates.map((candidate) => candidate.id)).not.toContain("ta-synced");
  });

  // The defect this pins: merging the task with its Google copy before the
  // calendar is narrowed to the day puts the one record on the day the EVENT
  // sits on, so a task with a slot today loses it and is offered again instead.
  // A task's slot belongs to the day it STARTS on, the way the engine's own day
  // test decides it. On a plain overlap rule last night's 23:50 block would come
  // back this morning as a stop that had already ended, and the task behind it
  // would be withheld from today's candidates into the bargain.
  test("leaves last night's overrunning task on last night", () => {
    expect(data.input.fixed.map((event) => event.id)).not.toContain("task:ta-overnight");
    expect(data.input.candidates.map((candidate) => candidate.id)).toContain("ta-overnight");
  });

  test("keeps a task's own slot when its Google copy is on another day", () => {
    const pushed = data.input.fixed.find((event) => event.id === "task:ta-pushed");
    expect(pushed?.source).toBe("task");
    expect(Date.parse(pushed?.start ?? "")).toBe(Date.parse(at("16:00")));
    expect(data.input.candidates.map((candidate) => candidate.id)).not.toContain("ta-pushed");
  });

  test("calls an event with no name what the live reader calls it", () => {
    const named = (id: string) => data.input.fixed.find((event) => event.id === id)?.title;
    expect(named("cal-campus:ev-nameless")).toBe("untitled event");
    expect(named("cal-campus:ev-blank")).toBe("untitled event");
  });

  test("keeps an all day event as one, with the day's own bounds", () => {
    const allDay = data.input.fixed.find((event) => event.id === "cal-campus:ev-allday");
    expect(allDay?.allDay).toBe(true);
    expect(allDay?.title).toBe("Library closed");
  });

  test("gives a time blocked task its own slot, under its task id", () => {
    const clinic = data.input.fixed.find((event) => event.id === "task:ta-clinic");
    expect(clinic?.source).toBe("task");
    expect(Date.parse(clinic?.start ?? "")).toBe(Date.parse(at("14:30")));
    expect(Date.parse(clinic?.end ?? "")).toBe(Date.parse(at("15:30")));
  });

  test("marks the cap calendars from the snapshot and from the income sources", () => {
    const capped = data.input.fixed
      .filter((event) => event.countsTowardCap)
      .map((event) => event.id)
      .sort();
    // The shift calendar comes from the snapshot, the tutoring one from an
    // income source. The other account's income calendar is not in either.
    expect(capped).toEqual(["cal-shift:ev-shift", "cal-tutoring:ev-tutor-today"]);
  });

  test("is only the task's own slot when the calendar is not included", async () => {
    const noCalendar = await load({ "calendar-events.json": null });
    expect(noCalendar.input.fixed.map((event) => event.id).sort()).toEqual([
      "task:ta-clinic",
      "task:ta-pushed",
      "task:ta-synced",
    ]);
  });
});

describe("the week behind the day", () => {
  test("counts the cap hours of the other six days, overlaps once", () => {
    expect(data.input.week.capHoursElsewhere).toBe(3);
  });

  test("has no engine history to report", () => {
    expect(data.input.week.incomeHoursElsewhere).toBe(0);
    expect(data.input.week.gymSessionsDone).toBe(0);
  });

  test("counts nothing at all without a calendar", async () => {
    const noCalendar = await load({ "calendar-events.json": null });
    expect(noCalendar.input.week.capHoursElsewhere).toBe(0);
  });

  test("counts an income calendar the snapshot did not list", async () => {
    const noSnapshotCaps = await load({
      "snapshot.json": JSON.stringify({ ...SNAPSHOT, capCalendarIds: [] }),
    });
    // The shift calendar is no longer capped, the tutoring one still is.
    expect(noSnapshotCaps.input.week.capHoursElsewhere).toBe(3);
    expect(
      noSnapshotCaps.input.fixed
        .filter((event) => event.countsTowardCap)
        .map((event) => event.id),
    ).toEqual(["cal-tutoring:ev-tutor-today"]);
  });
});

describe("what it may place", () => {
  test("offers the open tasks and nothing else", () => {
    expect(data.input.candidates.map((candidate) => candidate.id)).toEqual([
      "ta-essay",
      "ta-ledger",
      "ta-later",
      "ta-overnight",
    ]);
  });

  test("builds them the way the engine does", () => {
    const essay = data.input.candidates.find((candidate) => candidate.id === "ta-essay");
    expect(essay).toMatchObject({
      title: "Second draft",
      lane: "lane-study",
      kind: "step",
      hard: true,
      minutes: 120,
      pinned: false,
      earlyTouchDone: false,
    });
    expect(Date.parse(essay?.due ?? "")).toBe(Date.parse(at("23:59", "2026-04-16")));

    const ledger = data.input.candidates.find((candidate) => candidate.id === "ta-ledger");
    expect(ledger).toMatchObject({ title: "untitled", lane: "lane-work", due: null });

    const later = data.input.candidates.find((candidate) => candidate.id === "ta-later");
    expect(later).toMatchObject({ lane: null, kind: "side", hard: false });
  });

  test("drops a task that is already one of the day's fixed events", () => {
    expect(data.input.candidates.map((candidate) => candidate.id)).not.toContain("ta-clinic");
  });
});

describe("how the screen dresses it", () => {
  test("carries the document's lanes, and only what the screen shows", () => {
    expect(data.lanes).toEqual([
      { key: "lane-study", label: "Reading", color: "#7C9BFF" },
      { key: "lane-work", label: "Shop", color: "#2FD6A3" },
    ]);
  });

  test("tags each candidate with its own group's name and colour", () => {
    expect(data.tags).toEqual({
      "ta-essay": { label: "Reading", color: "#7C9BFF" },
      "ta-ledger": { label: "Shop", color: "#2FD6A3" },
    });
  });

  test("has no feeds and the document's feed labels", () => {
    expect(data.feeds).toEqual([]);
    expect(data.feedLabels).toEqual({ "feed-calendar": "Calendar" });
  });

  test("says what this data is and that nothing is saved", () => {
    expect(data.notice).toBe(
      "Your data as of Wednesday 15 April 09:05. A local copy: nothing you tap is saved.",
    );
  });

  test("says so when the calendar is not included", async () => {
    const noCalendar = await load({ "calendar-events.json": null });
    expect(noCalendar.notice).toBe(
      "Your data as of Wednesday 15 April 09:05. A local copy: nothing you tap is saved." +
        " Calendar not included.",
    );
  });
});

// Three of the four row files carry a `user_id` and are scoped by it at the
// door. The fourth, calendar-events.json, carries no account at all (it is a
// list of `EngineCalendarEvent`), so the loader cannot filter it and does not
// pretend to: see the comment on `readCalendarEvents`. A stray calendar in that
// file is the snapshot writer's problem, which is why this names the three it
// really covers rather than claiming the calendar as well.
describe("the other account's tasks, groups and income sources", () => {
  test("never reach the screen", () => {
    const everything = strings(data).join("|");
    expect(everything).not.toContain("Not yours");
    expect(everything).not.toContain(OTHER);
    expect(everything).not.toContain(GROUP_THEIRS);
    expect(data.input.candidates.map((candidate) => candidate.id)).not.toContain("ta-theirs");
    expect(Object.values(data.tags).map((tag) => tag.label)).toEqual(["Reading", "Shop"]);
  });

  // The income sources ARE scoped, and this is what that buys: the other
  // account's income calendar has eight hours on another day of this week, and
  // none of them count. A loader that read every account's income sources would
  // report 11 here, not 3.
  test("do not make their calendar count toward this account's cap", () => {
    expect(data.input.week.capHoursElsewhere).toBe(3);
    const capped = data.input.fixed
      .filter((event) => event.countsTowardCap)
      .map((event) => event.calendarId);
    expect(capped).not.toContain("cal-theirs");
  });
});

describe("a folder that is wrong", () => {
  test("names a missing file, in words", async () => {
    const error = await thrown({ "tasks.json": null });
    expect(error.file).toBe("tasks.json");
    expect(error.message).toContain("tasks.json");
    expect(error.message).toContain("missing");
  });

  test("names each of the required files", async () => {
    for (const file of [
      "snapshot.json",
      "rules.json",
      "tasks.json",
      "groups.json",
      "income_sources.json",
    ]) {
      expect((await thrown({ [file]: null })).file).toBe(file);
    }
  });

  test("names a file that is not valid JSON", async () => {
    const error = await thrown({ "rules.json": "{ not json" });
    expect(error.file).toBe("rules.json");
    expect(error.message).toContain("JSON");
  });

  test("names a rules document that does not fit", async () => {
    const lanes = await thrown({
      "rules.json": JSON.stringify({ planner: {}, lanes: [{ key: 7 }], feedLabels: {} }),
    });
    expect(lanes.file).toBe("rules.json");
    expect(lanes.message).toContain("lanes");

    const planner = await thrown({
      "rules.json": JSON.stringify({ planner: { lightsOut: "9am" }, lanes: [] }),
    });
    expect(planner.file).toBe("rules.json");
    expect(planner.message).toContain("lightsOut");
  });

  test("blames the snapshot for a zone nothing knows", async () => {
    const error = await thrown({
      "snapshot.json": JSON.stringify({ ...SNAPSHOT, timeZone: "Mars/Olympus" }),
    });
    expect(error.file).toBe("snapshot.json");
    expect(error.message).toContain("timeZone");
  });

  test("names a row file that is not a list of rows", async () => {
    expect((await thrown({ "tasks.json": JSON.stringify({ rows: [] }) })).file).toBe("tasks.json");
    expect((await thrown({ "groups.json": JSON.stringify(["nope"]) })).file).toBe("groups.json");
  });

  test("names the column when one of this account's rows does not fit", async () => {
    const error = await thrown({
      "tasks.json": JSON.stringify([
        { id: "ta-bad", user_id: MINE, status: "todo", due_date: "yesterday" },
      ]),
    });
    expect(error.file).toBe("tasks.json");
    expect(error.message).toContain("due_date");
  });

  test("never quotes a value from the file", async () => {
    const error = await thrown({
      "tasks.json": JSON.stringify([
        { id: "ta-bad", user_id: MINE, status: "todo", due_date: "a-secret-value" },
      ]),
    });
    expect(error.message).not.toContain("a-secret-value");
  });

  test("refuses a date that names a day nothing has", async () => {
    // "2026-13-45" passes a shape check and every piece of date arithmetic
    // downstream would carry it forward as 2027-02-14.
    const error = await thrown({
      "tasks.json": JSON.stringify([
        { id: "ta-bad", user_id: MINE, status: "todo", due_date: "2026-13-45" },
      ]),
    });
    expect(error.file).toBe("tasks.json");
    expect(error.message).toContain("due_date");
    expect(error.message).not.toContain("2026-13-45");
  });

  test("refuses minutes that cannot make a block", async () => {
    const negative = await thrown({
      "tasks.json": JSON.stringify([
        { id: "ta-bad", user_id: MINE, status: "todo", estimated_minutes: -30 },
      ]),
    });
    expect(negative.file).toBe("tasks.json");
    expect(negative.message).toContain("estimated_minutes");

    const zero = await thrown({
      "tasks.json": JSON.stringify([
        { id: "ta-bad", user_id: MINE, status: "todo", duration_min: 0 },
      ]),
    });
    expect(zero.message).toContain("duration_min");

    const fraction = await thrown({
      "tasks.json": JSON.stringify([
        { id: "ta-bad", user_id: MINE, status: "todo", duration_min: 12.5 },
      ]),
    });
    expect(fraction.message).toContain("duration_min");
  });

  // What `>` and `Out-File` write in Windows PowerShell 5.1. Read as UTF-8 it
  // decodes into replacement characters, so the generic answer would be "is not
  // valid JSON" about a file whose JSON is perfect.
  test("names the encoding when the file is UTF-16", async () => {
    for (const order of ["le", "be"] as const) {
      const error = await thrown({ "tasks.json": utf16(JSON.stringify(TASK_ROWS), order) });
      expect(error.file).toBe("tasks.json");
      expect(error.message).toContain("UTF-8");
      expect(error.message).not.toContain("JSON");
    }
  });

  test("reads a file a Windows editor wrote with a byte order mark", async () => {
    const withMark = await load({
      "snapshot.json": `${MARK}${JSON.stringify(SNAPSHOT)}`,
    });
    expect(withMark.input.rules.timeZone).toBe(ZONE);
  });
});

describe("it only ever reads, and only inside the folder", () => {
  test("leaves the folder exactly as it found it", async () => {
    const dir = await folder();
    const before = (await readdir(dir)).sort();
    await loadLocalToday(dir, NOW, null);
    expect((await readdir(dir)).sort()).toEqual(before);
  });

  const source = (file: string) => readFileSync(path.join(ROOT, file), "utf8");
  const owned = ["app/lib/v2/local/snapshot.ts", "app/lib/v2/local/files.ts"];

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
        expect(code).not.toContain(forbidden);
      }
    }
  });

  test("builds every path from the folder and a fixed name", () => {
    const code = owned.map(source).join("\n");
    // One read, and the names it may read are literals in the same file.
    expect(code.match(/readFile\(/g)).toHaveLength(1);
    for (const name of [
      "snapshot.json",
      "rules.json",
      "tasks.json",
      "groups.json",
      "income_sources.json",
      "calendar-events.json",
    ]) {
      expect(code).toContain(`"${name}"`);
    }
  });
});

describe("the copy rules", () => {
  // Built from code points so this file stays pure ASCII: a repo wide grep for
  // U+2014 should find the copy that broke the rule, not the test that guards it.
  const EM_DASH = String.fromCodePoint(0x2014);
  const EN_DASH = String.fromCodePoint(0x2013);

  test("uses no em dash and no en dash", async () => {
    const everything = [
      ...strings(data),
      ...strings(await load({ "calendar-events.json": null })),
      ...strings(await thrown({ "tasks.json": null }).then((error) => error.message)),
    ];
    expect(everything.length).toBeGreaterThan(20);
    for (const text of everything) {
      expect(text).not.toContain(EM_DASH);
      expect(text).not.toContain(EN_DASH);
    }
  });
});

// The pure gate is only half of it: the page has to read the right variables,
// take the branches in the right order, and show a bad folder rather than
// crashing on it.
// The loopback check is a speed bump and nothing more (a Host header is the
// client's own claim), so what is pinned is exactly that: the three spellings a
// real loopback request carries are served, everything else is sent to the
// not-found page with no data, and the value a stranger sent never comes back
// out anywhere. It guards the snapshot only; the sample is invented and a Vercel
// preview is where it is meant to be looked at.
describe("the loopback speed bump", () => {
  test("knows the three spellings, with or without a port", () => {
    for (const host of [
      "localhost",
      "localhost:3111",
      "LOCALHOST:3111",
      "127.0.0.1",
      "127.0.0.1:3111",
      "[::1]",
      "[::1]:3111",
      "::1",
      " localhost:3111 ",
    ]) {
      expect(isLoopbackHost(host)).toBe(true);
    }
  });

  test("refuses every other host, and no host at all", () => {
    for (const host of [
      null,
      undefined,
      "",
      "   ",
      "192.168.1.24:3111",
      "10.0.0.5",
      "172.16.3.9:3111",
      "0.0.0.0:3111",
      "[::]:3111",
      "[fe80::1]:3111",
      "127.0.0.2:3111",
      // The name is the whole value, not a prefix or a suffix of it.
      "localhost.example.com",
      "notlocalhost",
      "127.0.0.1.example.com",
      "localhost:not-a-port",
      "mindboard.example.com",
    ]) {
      expect(isLoopbackHost(host)).toBe(false);
    }
  });
});

describe("the page is wired to both sources", () => {
  type Element = { type: unknown; props: Record<string, unknown> };

  // Every case starts from a request that came from this machine and says so,
  // and the cases that are about the host say otherwise themselves.
  beforeEach(() => {
    sentHost.value = "127.0.0.1:3111";
  });

  // Unstubbed here rather than at the end of each case, so a failed assertion
  // cannot leave a stubbed VERCEL_ENV behind for the cases after it.
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function page() {
    return import("@/app/v2/today/page");
  }

  async function sample(dir?: string) {
    vi.stubEnv("V2_FIXTURES", "1");
    vi.stubEnv("V2_LOCAL_SNAPSHOT", dir ?? (await folder()));
    vi.stubEnv("VERCEL_ENV", "preview");
  }

  async function local(dir?: string) {
    vi.stubEnv("V2_FIXTURES", "");
    vi.stubEnv("V2_LOCAL_SNAPSHOT", dir ?? (await folder()));
    vi.stubEnv("VERCEL_ENV", "preview");
  }

  /**
   * The page, rendered one level deep.
   *
   * The page itself is synchronous and does one thing: it decides the source and
   * hands it to a child that awaits everything (the request's host, the search
   * parameters, the folder). So the branch is read off the source the page
   * chose, and the child is then called to get the element the browser would
   * see: the screen, or the panel naming a file that is wrong.
   */
  async function render(search: Record<string, string | string[]> = {}) {
    const { default: TodayPage } = await page();
    const { TodayClient } = await import("@/app/v2/today/today-client");
    const outer = TodayPage({ searchParams: Promise.resolve(search) }) as unknown as Element;
    const branch = (outer.props.source as { kind: string }).kind;
    const element = (await (outer.type as (props: unknown) => Promise<unknown>)(
      outer.props,
    )) as Element;
    if (element.type !== TodayClient) return { branch: "panel", element, screen: undefined };
    return { branch, element, screen: element.props.data as TodayScreenData };
  }

  test("asks to be rendered per request, so the gate is never prerendered", async () => {
    expect((await page()).dynamic).toBe("force-dynamic");
  });

  test("shows the sample day when the fixtures flag is on", async () => {
    await sample();
    const { branch, element } = await render();
    expect(branch).toBe("sample");
    expect(element.props.data).toBeTruthy();
  });

  // The sample is invented, and a Vercel preview is where it is meant to be
  // looked at, so the loopback check must not reach it.
  test("shows the sample day to any host, including a preview deployment", async () => {
    for (const host of [
      "mindboard-git-rebuild-example.vercel.app",
      "192.168.1.24:3111",
      null,
    ]) {
      sentHost.value = host;
      await sample();
      expect((await render()).branch).toBe("sample");
      vi.unstubAllEnvs();
    }
  });

  test("falls to the local snapshot when the fixtures flag is off", async () => {
    await local();
    const { branch, screen } = await render();
    expect(branch).toBe("local");
    expect(screen?.notice).toContain("Your data as of");
    expect(screen?.lanes).toHaveLength(2);
  });

  test("passes the date parameter through", async () => {
    await local();
    const tomorrow = shiftDateKey(zonedDateKey(Date.now(), ZONE), 1);
    const { screen } = await render({ date: tomorrow });
    expect(screen?.input.date).toBe(tomorrow);

    // A repeated parameter arrives as a list, which is not a date.
    const listed = await render({ date: [tomorrow, tomorrow] });
    expect(listed.screen?.input.date).not.toBe(tomorrow);
  });

  test("shows a panel naming the file when the folder is wrong", async () => {
    await local(await folder({ "tasks.json": null }));
    const { branch, element } = await render();
    expect(branch).toBe("panel");
    const html = renderToStaticMarkup(element as never);
    expect(html).toContain("tasks.json");
  });

  test("is not found with no fixtures and no snapshot", async () => {
    await local("");
    const { default: TodayPage } = await page();
    const error = await refusal(() => TodayPage({ searchParams: Promise.resolve({}) }));
    expect(error.digest).toBe(NOT_FOUND_DIGEST);
  });

  test("is not found in production, whatever is set", async () => {
    await sample();
    vi.stubEnv("VERCEL_ENV", "production");
    const { default: TodayPage } = await page();
    const error = await refusal(() => TodayPage({ searchParams: Promise.resolve({}) }));
    expect(error.digest).toBe(NOT_FOUND_DIGEST);
  });

  test("sends a host on the house network to the not-found page in snapshot mode", async () => {
    sentHost.value = "192.168.1.24:3111";
    await local();
    expect((await refusal(() => render())).digest).toBe(NOT_FOUND_DIGEST);
  });

  test("does the same when the request sent no host at all", async () => {
    sentHost.value = null;
    await local();
    expect((await refusal(() => render())).digest).toBe(NOT_FOUND_DIGEST);
  });

  test("serves each spelling of the loopback address", async () => {
    for (const host of ["localhost:3111", "127.0.0.1:3111", "[::1]:3111"]) {
      sentHost.value = host;
      await local();
      expect((await render()).branch).toBe("local");
      vi.unstubAllEnvs();
    }
  });

  test("never repeats the host it refused, in a log or in the answer", async () => {
    const forged = "Host-From-A-Stranger.example.com";
    sentHost.value = forged;
    await local();
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => {}),
    );
    try {
      const error = await refusal(() => render());
      expect(error.digest).toBe(NOT_FOUND_DIGEST);
      expect(error.message).not.toContain(forged);
      expect(JSON.stringify(error.digest)).not.toContain(forged);
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});
