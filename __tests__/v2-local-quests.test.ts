// @vitest-environment node
// PLAN-DESK Task 3, behaviour 10: the quests of a local snapshot folder.
//
// EVERYTHING IN THIS FILE IS INVENTED. The folder is built in a temp directory,
// and the two accounts, the groups and the tasks are made up. The zone has no
// daylight saving so every instant below is stable. Nothing here reads the
// owner's export, and nothing here writes anywhere but the temp dir.
//
// The task file is awkward in the ways a real export is: two accounts, open rows
// beside finished ones, finish times in more than one spelling, and finished
// rows whose time is missing, unreadable or has no offset at all.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { LocalSnapshotError } from "@/app/lib/v2/local/files";
import { loadLocalQuests } from "@/app/lib/v2/local/quests";
import { loadLocalToday } from "@/app/lib/v2/local/snapshot";
import type { QuestsScreenData } from "@/app/lib/v2/view/desk-data";
import type { TodayScreenData } from "@/app/lib/v2/view/screen-data";

const MINE = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const GROUP_READING = "33333333-3333-4333-8333-333333333333";
const GROUP_SHOP = "44444444-4444-4444-8444-444444444444";
const GROUP_LOOSE = "55555555-5555-4555-8555-555555555555";
const GROUP_PLAIN = "66666666-6666-4666-8666-666666666666";

const ZONE = "America/Phoenix";
const OFFSET = "-07:00";
/** A Wednesday. */
const DAY = "2026-04-15";
const NOW = `${DAY}T10:20:00${OFFSET}`;

const at = (clock: string, date: string = DAY) => `${date}T${clock}:00${OFFSET}`;

const SNAPSHOT = { userId: MINE, timeZone: ZONE, takenAt: at("09:05"), capCalendarIds: [] };

const RULES_DOC = {
  planner: {
    // Deliberately wrong: the snapshot's zone has to win over this one.
    timeZone: "UTC",
    wakeByWeekday: ["07:30", "07:30", "07:30", "07:30", "07:30", "07:30", "07:30"],
    lightsOut: "23:30",
    noFocusBefore: "08:30",
    bufferMinutes: 10,
    weeklyHourCap: 30,
    incomeTarget: null,
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
      key: "lane-shop",
      label: "Shop",
      color: "#2FD6A3",
      groupIds: [GROUP_SHOP, GROUP_PLAIN],
      hardDates: false,
    },
  ],
  feedLabels: {},
};

const GROUP_ROWS = [
  { id: GROUP_READING, user_id: MINE, name: "Reading room", color: "#7C9BFF", archived: false },
  { id: GROUP_SHOP, user_id: MINE, name: "Shop floor", color: "#2FD6A3", archived: false },
  // A group in no lane: what is finished in it is a side quest that wears it.
  { id: GROUP_LOOSE, user_id: MINE, name: "Odd jobs", color: "#C58BFF", archived: false },
  // A group with no colour gives no tag, as on Today.
  { id: GROUP_PLAIN, user_id: MINE, name: "Back room", color: null, archived: false },
];

const TASK_ROWS = [
  // Open: Today's candidates, not history.
  { id: "ta-open", user_id: MINE, group_id: GROUP_READING, title: "Read the next chapter", status: "todo" },
  { id: "ta-open-untitled", user_id: MINE, group_id: GROUP_SHOP, title: null, status: "doing" },
  // Reopened: it has a finish time and is not finished.
  {
    id: "ta-reopened",
    user_id: MINE,
    group_id: GROUP_SHOP,
    title: "Price the new stock",
    status: "doing",
    completed_at: "2026-04-14T18:00:00+00:00",
  },
  // Postgres spellings: fractional seconds, and a space before the time.
  {
    id: "tb-recent",
    user_id: MINE,
    group_id: GROUP_READING,
    title: "Margin notes (chapter two)",
    status: "done",
    completed_at: "2026-04-15T15:30:00.123456+00:00",
    notes: "a column the reader has no use for",
  },
  {
    id: "tb-shop",
    user_id: MINE,
    group_id: GROUP_SHOP,
    title: "Restock the counter",
    status: "done",
    completed_at: "2026-04-14 23:05:00+00:00",
  },
  {
    id: "tb-plain",
    user_id: MINE,
    group_id: GROUP_PLAIN,
    title: "Sweep the back room",
    status: "done",
    completed_at: "2026-04-12T09:00:00Z",
  },
  {
    id: "tb-loose",
    user_id: MINE,
    group_id: GROUP_LOOSE,
    title: "Oil the gate hinge",
    status: "done",
    completed_at: at("12:00", "2026-04-10"),
  },
  // No group and no title. 26 days back, inside the window.
  { id: "tb-nogroup", user_id: MINE, group_id: null, title: null, status: "done", completed_at: at("18:00", "2026-03-20") },
  // 28 days back: one day outside the window.
  { id: "tb-old", user_id: MINE, group_id: GROUP_SHOP, title: "Old chore", status: "done", completed_at: at("10:00", "2026-03-18") },
  // After the planned day.
  { id: "tb-after", user_id: MINE, group_id: GROUP_SHOP, title: "Not yet", status: "done", completed_at: at("10:00", "2026-04-16") },
  // Finished, with no time anyone can read: skipped, never an error.
  { id: "tb-no-time", user_id: MINE, group_id: GROUP_SHOP, title: "No time", status: "done" },
  { id: "tb-null-time", user_id: MINE, group_id: GROUP_SHOP, title: "Null time", status: "done", completed_at: null },
  { id: "tb-words", user_id: MINE, group_id: GROUP_SHOP, title: "Words", status: "done", completed_at: "last week" },
  { id: "tb-naive", user_id: MINE, group_id: GROUP_SHOP, title: "No offset", status: "done", completed_at: "2026-04-14T10:00:00" },
  { id: "tb-short", user_id: MINE, group_id: GROUP_SHOP, title: "Short offset", status: "done", completed_at: "2026-04-14 10:00:00+00" },
  { id: "tb-day-only", user_id: MINE, group_id: GROUP_SHOP, title: "Day only", status: "done", completed_at: "2026-04-14" },
  { id: "tb-number", user_id: MINE, group_id: GROUP_SHOP, title: "Number", status: "done", completed_at: 1776182700000 },
  // The other account's rows, one of them malformed: neither is this account's.
  { id: "tc-theirs", user_id: OTHER, group_id: GROUP_SHOP, title: "Not yours", status: "done", completed_at: at("09:00") },
  { user_id: OTHER, title: 7, status: "done", completed_at: at("09:00") },
];

const DEFAULT_FILES: Record<string, string> = {
  "snapshot.json": JSON.stringify(SNAPSHOT, null, 2),
  "rules.json": JSON.stringify(RULES_DOC, null, 2),
  "tasks.json": JSON.stringify(TASK_ROWS, null, 2),
  "groups.json": JSON.stringify(GROUP_ROWS, null, 2),
  "income_sources.json": "[]",
};

const made: string[] = [];

/** A snapshot folder. `null` leaves that file out, a string or buffer replaces it. */
async function folder(overrides: Record<string, string | Buffer | null> = {}): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "v2-local-quests-"));
  made.push(dir);
  for (const [name, body] of Object.entries({ ...DEFAULT_FILES, ...overrides })) {
    if (body === null) continue;
    await writeFile(path.join(dir, name), body, "utf8");
  }
  return dir;
}

/** The quests of a folder, beside the day the same folder loads. */
async function load(
  overrides: Record<string, string | Buffer | null> = {},
  dateParam: string | null = null,
): Promise<{ today: TodayScreenData; quests: QuestsScreenData | null }> {
  const dir = await folder(overrides);
  const today = await loadLocalToday(dir, NOW, dateParam);
  return { today, quests: await loadLocalQuests(dir, today) };
}

/** A snapshot taken at another instant. */
const takenAt = (instant: string) => JSON.stringify({ ...SNAPSHOT, takenAt: instant });

/** The rules with lights out after midnight. */
const LATE_RULES = JSON.stringify({
  ...RULES_DOC,
  planner: { ...RULES_DOC.planner, lightsOut: "01:30" },
});

/** Finished rows of this account, one per completed_at, in the shop group. */
function finishedRows(times: Record<string, unknown>): string {
  return JSON.stringify(
    Object.entries(times).map(([id, completed_at]) => ({
      id,
      user_id: MINE,
      group_id: GROUP_SHOP,
      title: `Finished ${id}`,
      status: "done",
      completed_at,
    })),
  );
}

async function thrown(dir: string, today: TodayScreenData): Promise<LocalSnapshotError> {
  try {
    await loadLocalQuests(dir, today);
  } catch (error) {
    if (error instanceof LocalSnapshotError) return error;
    throw error;
  }
  throw new Error("the folder loaded when it should not have");
}

let today: TodayScreenData;
let quests: QuestsScreenData | null;

beforeAll(async () => {
  ({ today, quests } = await load());
});

afterAll(async () => {
  for (const dir of made) await rm(dir, { recursive: true, force: true });
});

describe("the quests of a local folder", () => {
  test("are handed the very input, lanes and tags the day plans from", () => {
    expect(quests).not.toBeNull();
    expect(quests?.input).toBe(today.input);
    expect(quests?.lanes).toBe(today.lanes);
    expect(quests?.tags).toBe(today.tags);
  });

  test("hold this account's finished rows of the last 28 days, newest first", () => {
    expect(quests?.done.map((entry) => entry.id)).toEqual([
      "tb-recent",
      "tb-shop",
      "tb-plain",
      "tb-loose",
      "tb-nogroup",
    ]);
  });

  test("read each finish time in the user's zone, whatever its spelling", () => {
    expect(quests?.done.map((entry) => entry.doneAt)).toEqual([
      at("08:30"),
      at("16:05", "2026-04-14"),
      at("02:00", "2026-04-12"),
      at("12:00", "2026-04-10"),
      at("18:00", "2026-03-20"),
    ]);
  });

  test("give each the lane its group belongs to and its group's tag", () => {
    const byId = Object.fromEntries((quests?.done ?? []).map((entry) => [entry.id, entry]));
    expect(byId["tb-recent"]).toMatchObject({
      lane: "lane-study",
      tag: { label: "Reading room", color: "#7C9BFF" },
      title: "Margin notes (chapter two)",
    });
    expect(byId["tb-shop"]).toMatchObject({ lane: "lane-shop", tag: { label: "Shop floor", color: "#2FD6A3" } });
    // In a lane, with a group that has no colour: the lane, and no tag.
    expect(byId["tb-plain"]).toMatchObject({ lane: "lane-shop", tag: null });
    // A group in no lane: a side quest that still wears its group.
    expect(byId["tb-loose"]).toMatchObject({ lane: null, tag: { label: "Odd jobs", color: "#C58BFF" } });
    // No group and no title.
    expect(byId["tb-nogroup"]).toMatchObject({ lane: null, tag: null, title: "untitled" });
  });

  test("speak for 28 days up to the day the copy was taken", () => {
    // Taken at 09:05 on the planned day itself.
    expect(quests?.historyThrough).toBe(DAY);
    expect(quests?.historyDays).toBe(28);
  });

  test("speak for 28 days even when every finished row is older than the window", async () => {
    const rows = [
      { id: "ta-open", user_id: MINE, group_id: GROUP_READING, title: "Open", status: "todo" },
      { id: "tb-old", user_id: MINE, group_id: GROUP_SHOP, title: "Old", status: "done", completed_at: at("10:00", "2026-01-05") },
    ];
    const { quests: loaded } = await load({ "tasks.json": JSON.stringify(rows) });
    expect(loaded?.done).toEqual([]);
    expect(loaded?.historyThrough).toBe(DAY);
    expect(loaded?.historyDays).toBe(28);
  });

  test("speak for no day at all when nothing finished has a time", async () => {
    const rows = [
      { id: "ta-open", user_id: MINE, group_id: GROUP_READING, title: "Open", status: "todo" },
      { id: "tb-no-time", user_id: MINE, group_id: GROUP_SHOP, title: "No time", status: "done" },
      { id: "tc-theirs", user_id: OTHER, title: "Theirs", status: "done", completed_at: at("09:00") },
    ];
    const { quests: loaded } = await load({ "tasks.json": JSON.stringify(rows) });
    expect(loaded?.done).toEqual([]);
    expect(loaded?.historyThrough).toBeNull();
    expect(loaded?.historyDays).toBe(0);
  });
});

// A copy stops knowing on the day it was taken. Its history is the 28 days up
// to that day, never up to a planned day it cannot see.
describe("a copy taken before the planned day", () => {
  test("its history ends on the day it was taken", async () => {
    const { today: day, quests: loaded } = await load({
      "snapshot.json": takenAt(at("20:00", "2026-04-12")),
    });
    expect(day.input.date).toBe(DAY);
    expect(loaded?.historyThrough).toBe("2026-04-12");
    expect(loaded?.historyDays).toBe(28);
    // The 28 days up to the 12th: the two finishes after it are not the copy's
    // to speak for, and the 18 March one is now inside the window.
    expect(loaded?.done.map((entry) => entry.id)).toEqual([
      "tb-plain",
      "tb-loose",
      "tb-nogroup",
      "tb-old",
    ]);
  });

  test("and never later than the planned day", async () => {
    const { today: day, quests: loaded } = await load({}, "2026-04-13");
    expect(day.input.date).toBe("2026-04-13");
    expect(loaded?.historyThrough).toBe("2026-04-13");
    expect(loaded?.done.map((entry) => entry.id)).toEqual([
      "tb-plain",
      "tb-loose",
      "tb-nogroup",
      "tb-old",
    ]);
  });
});

// A finish is read on its PLANNING day: with lights out at 01:30, 00:30 is still
// the day before. The window and the day the copy was taken both follow it.
describe("with lights out after midnight", () => {
  test("a finish at 00:30 belongs to the day before", async () => {
    const tasks = finishedRows({
      "tb-edge": at("00:30", "2026-03-19"),
      "tb-inside": at("02:00", "2026-03-19"),
    });
    const late = await load({ "rules.json": LATE_RULES, "tasks.json": tasks });
    // The 18th is 28 days back, one outside the window; the 19th is inside.
    expect(late.quests?.done.map((entry) => entry.id)).toEqual(["tb-inside"]);

    const early = await load({ "tasks.json": tasks });
    expect(early.quests?.done.map((entry) => entry.id)).toEqual(["tb-inside", "tb-edge"]);
  });

  test("a copy taken at 00:30 speaks for the day before", async () => {
    const { quests: loaded } = await load({
      "rules.json": LATE_RULES,
      "snapshot.json": takenAt(at("00:30")),
    });
    expect(loaded?.historyThrough).toBe("2026-04-14");
    expect(loaded?.done.map((entry) => entry.id)).not.toContain("tb-recent");
  });
});

// The full offset is required, in either of Postgres's spellings, so the same
// file reads the same instant in every engine.
describe("finish time spellings", () => {
  test("each accepted spelling reads the same instant", async () => {
    const instant = at("09:05", "2026-04-14");
    const { quests: loaded } = await load({
      "tasks.json": finishedRows({
        "s-z": "2026-04-14T16:05:00Z",
        "s-colon": "2026-04-14T16:05:00+00:00",
        "s-compact": "2026-04-14T16:05:00+0000",
        "s-local": "2026-04-14T09:05:00-07:00",
        "s-local-compact": "2026-04-14T09:05:00-0700",
        "s-micro": "2026-04-14T16:05:00.123456+00:00",
        "s-space": "2026-04-14 16:05:00+00:00",
        "s-space-compact": "2026-04-14 16:05:00.5+0000",
        "s-no-seconds": "2026-04-14T16:05Z",
      }),
    });
    expect(loaded?.done.map((entry) => entry.id)).toEqual([
      "s-colon",
      "s-compact",
      "s-local",
      "s-local-compact",
      "s-micro",
      "s-no-seconds",
      "s-space",
      "s-space-compact",
      "s-z",
    ]);
    for (const entry of loaded?.done ?? []) expect(entry.doneAt, entry.id).toBe(instant);
  });

  test("a short offset, no offset, a bare day or another letter case is skipped", async () => {
    const { quests: loaded } = await load({
      "tasks.json": finishedRows({
        "r-short": "2026-04-14T16:05:00+00",
        "r-space-short": "2026-04-14 16:05:00+00",
        "r-naive": "2026-04-14T16:05:00",
        "r-day": "2026-04-14",
        "r-lower": "2026-04-14t16:05:00z",
        "r-hour-only": "2026-04-14T16Z",
      }),
    });
    expect(loaded?.done).toEqual([]);
    expect(loaded?.historyThrough).toBeNull();
  });
});

describe("what the folder cannot give", () => {
  test("no task file is null, not an error", async () => {
    expect(await loadLocalQuests(await folder({ "tasks.json": null }), today)).toBeNull();
  });

  test("a task file that is not JSON is that file's error, in its own words", async () => {
    const dir = await folder({ "tasks.json": "[{ not json" });
    const error = await thrown(dir, today);
    expect(error.file).toBe("tasks.json");
    expect(error.message).toBe("tasks.json is not valid JSON.");
  });

  test("a task file in the wrong encoding says so", async () => {
    const bytes = Buffer.from(`${String.fromCodePoint(0xfeff)}${DEFAULT_FILES["tasks.json"]}`, "utf16le");
    const error = await thrown(await folder({ "tasks.json": bytes }), today);
    expect(error.message).toBe("tasks.json is not UTF-8 text. Save it as UTF-8.");
  });

  test("a row of this account without an id names the column, never a value or a path", async () => {
    const rows = [{ user_id: MINE, title: "A private title", status: "done", completed_at: at("09:00") }];
    const dir = await folder({ "tasks.json": JSON.stringify(rows) });
    const error = await thrown(dir, today);
    expect(error.message).toBe("tasks.json does not have the shape this screen needs (at 0.id).");
    expect(error.message).not.toContain("A private title");
    expect(error.message).not.toContain(dir);
  });
});
