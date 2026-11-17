// @vitest-environment node
// Task 7, behaviour 1 to 4 and 14: the ten minute tick, on the memory stores
// with the real planDay and a FakeTelegram. No network, no database, no clock
// read: every instant and every id arrives as an argument.
//
// The zone is America/Phoenix, which has no daylight saving, so a wall time in
// these tests means one instant all year.

import { describe, expect, test } from "vitest";

import { FakeTelegram, type FakeTelegramCall } from "@/app/lib/v2/channel/fake-telegram";
import { TelegramError, type TelegramClient } from "@/app/lib/v2/channel/telegram";
import {
  ALERT_REOPEN_QUIET_HOURS,
  ENGINE_TICK_FEED,
  FEED_RUN_RETENTION_DAYS,
  SLIP_GRACE_MINUTES,
  TELEGRAM_FEED,
  createEngineContext,
  runTick,
  tickStatus,
  type TickDeps,
} from "@/app/lib/v2/engine/tick";
import { handleIncoming } from "@/app/lib/v2/engine/incoming";
import { createMemoryStores } from "@/app/lib/v2/store/memory";
import { zonedWallTimeToUtcMs } from "@/app/lib/snapshots/zoned-time";
import type { RulesDocument, StoredExpectation, Stores } from "@/app/lib/v2/store/types";
import type { Alert, Block, Candidate, FeedRun, FixedEvent } from "@/app/lib/v2/types";

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const TASK_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const TASK_B = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const CHAT = "4242";
const HASH = "a".repeat(64);

const ZONE = "America/Phoenix";
/** A Monday, so the week this tick plans in starts on it. */
const DATE = "2026-11-09";
const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/** The instant of a wall time in the user's zone, through the one helper. */
function local(wall: string, date = DATE): string {
  const [hour, minute] = wall.split(":").map(Number);
  return new Date(zonedWallTimeToUtcMs(date, hour, minute, ZONE)).toISOString();
}

function plus(instant: string, ms: number): string {
  return new Date(Date.parse(instant) + ms).toISOString();
}

const RULES: RulesDocument = {
  planner: {
    timeZone: ZONE,
    wakeByWeekday: ["08:00", "08:00", "08:00", "08:00", "08:00", "08:00", "08:00"],
    lightsOut: "23:00",
    noFocusBefore: "09:00",
    bufferMinutes: 10,
    blockMinutes: { floor: 25, standard: 50, long: 120 },
    capacity: {
      low: { blocks: 0, small: 1, gym: false, social: false },
      ok: { blocks: 2, small: 0, gym: false, social: false },
      good: { blocks: 3, small: 0, gym: false, social: false },
    },
    slipDefaultAfterMinutes: 30,
    interruptsPerDay: 3,
  },
  lanes: [
    { key: "lane-a", label: "Lane A", color: "#b5ff3c", groupIds: ["g1"], hardDates: false },
  ],
  feedLabels: { "home-worker": "the home pc" },
};

/** An account with a hard weekly cap and an income lane to spend it on. */
const CAPPED_RULES: RulesDocument = {
  ...RULES,
  planner: {
    ...RULES.planner,
    weeklyHourCap: 30,
    incomeTarget: { lane: "lane-income", weeklyHours: 10, blockMinutes: 120 },
  },
};

function candidate(over: Partial<Candidate> = {}): Candidate {
  return {
    id: TASK_A,
    title: "Write the brief",
    lane: "lane-a",
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

// The afternoon on purpose: every test that is not about the morning message
// runs after noon, so the morning step cannot add a second message to it.
function aBlock(over: Partial<Block> = {}): Block {
  return {
    id: `${DATE}:focus:${TASK_A}`,
    date: DATE,
    start: local("14:00"),
    end: local("14:50"),
    kind: "focus",
    lane: "lane-a",
    taskId: TASK_A,
    title: "Write the brief",
    state: "planned",
    reason: "lane-next",
    ...over,
  };
}

function okRun(startedAt: string): FeedRun {
  return {
    feed: "calendar",
    startedAt,
    finishedAt: startedAt,
    status: "ok",
    count: 0,
    errorClass: null,
  };
}

interface Harness {
  stores: Stores;
  deps: TickDeps;
  telegram: FakeTelegram;
}

async function harness(
  over: {
    rules?: RulesDocument;
    linked?: boolean;
    telegram?: TelegramClient | null;
    candidates?: Candidate[];
    deps?: Partial<TickDeps>;
    userId?: string;
  } = {},
): Promise<Harness> {
  const userId = over.userId ?? USER;
  const stores = createMemoryStores();
  await stores.users.save(userId, { rules: over.rules ?? RULES, enabled: true });
  if (over.linked !== false) {
    await stores.channels.setPairing(userId, HASH, plus(local("00:00"), DAY));
    await stores.channels.redeemPairing(HASH, CHAT, local("07:00"));
  }
  const telegram = new FakeTelegram();
  let n = 0;
  const deps: TickDeps = {
    stores,
    telegram: over.telegram === undefined ? telegram : over.telegram,
    loadFixed: async () => ({ fixed: [], calendar: okRun(local("09:00")) }),
    loadCandidates: async () => over.candidates ?? [candidate()],
    loadWeekCapHours: async () => ({ hours: 0, ok: true }),
    newId: () => `bbbbbbbb-bbbb-4bbb-8bbb-${String(++n).padStart(12, "0")}`,
    probes: [],
    ...over.deps,
  };
  return { stores, deps, telegram };
}

type SentMessage = Extract<FakeTelegramCall, { method: "sendMessage" }>;

function sentMessages(telegram: FakeTelegram): SentMessage[] {
  return telegram.sent.filter((call): call is SentMessage => call.method === "sendMessage");
}

const sentTexts = (telegram: FakeTelegram): string[] =>
  sentMessages(telegram).map((call) => call.msg.text);

async function runsOf(stores: Stores, userId: string, feed: string): Promise<FeedRun[]> {
  const runs = await stores.feeds.listRuns(userId, local("00:00", "2026-01-01"));
  return runs.filter((run) => run.feed === feed);
}

// --------------------------------------------------------------- the step list

describe("runTick, the step list", () => {
  test("runs every step in order and says ok when all of them were", async () => {
    const { deps } = await harness();
    const result = await runTick(deps, USER, local("09:30"));
    expect(Object.keys(result.steps)).toEqual([
      "load",
      "expire",
      "close-out",
      "slips",
      "plan",
      "morning",
      "watchdog",
      "send",
      "prune",
    ]);
    expect(Object.values(result.steps).every((state) => state === "ok")).toBe(true);
    expect(result.ok).toBe(true);
  });

  test("a step that throws is recorded as error and the rest still run", async () => {
    const { stores, deps } = await harness({
      deps: {
        loadCandidates: async () => {
          throw new Error("tasks are unreadable");
        },
      },
    });
    const result = await runTick(deps, USER, local("09:30"));
    expect(result.ok).toBe(false);
    expect(result.steps.plan).toBe("error");
    expect(result.steps.expire).toBe("ok");
    expect(result.steps.morning).toBe("ok");
    expect(result.steps.send).toBe("ok");
    expect(result.steps.prune).toBe("ok");
    // The morning still went out: one failing step does not stop the tick.
    expect((await stores.days.get(USER, DATE))?.morningSentAt).toBe(local("09:30"));
  });

  test("writes its own feed run, with the failing step as the error class", async () => {
    const { stores, deps } = await harness({
      deps: {
        loadCandidates: async () => {
          throw new Error("tasks are unreadable");
        },
      },
    });
    await runTick(deps, USER, local("09:30"));
    const [run] = await runsOf(stores, USER, ENGINE_TICK_FEED);
    expect(run.status).toBe("error");
    expect(run.errorClass).toBe("plan-failed");
    expect(run.startedAt).toBe(local("09:30"));
    expect(run.finishedAt).toBe(local("09:30"));
  });

  test("an account with no rules row fails its own tick cleanly", async () => {
    const stores = createMemoryStores();
    const deps: TickDeps = {
      stores,
      telegram: null,
      loadFixed: async () => ({ fixed: [], calendar: okRun(local("09:00")) }),
      loadCandidates: async () => [],
      loadWeekCapHours: async () => ({ hours: 0, ok: true }),
      newId: () => "bbbbbbbb-bbbb-4bbb-8bbb-000000000001",
    };
    const result = await runTick(deps, USER, local("09:30"));
    expect(result.ok).toBe(false);
    expect(result.steps.load).toBe("error");
    const [run] = await runsOf(stores, USER, ENGINE_TICK_FEED);
    expect(run.status).toBe("error");
    expect(run.errorClass).toBe("load-failed");
  });

  test("rules that do not parse fail that account's tick, not the stores", async () => {
    const { stores, deps } = await harness({
      rules: { planner: { lightsOut: "25:00" }, lanes: [], feedLabels: {} },
    });
    const result = await runTick(deps, USER, local("09:30"));
    expect(result.steps.load).toBe("error");
    expect((await runsOf(stores, USER, ENGINE_TICK_FEED))[0].status).toBe("error");
  });

  test("touches no other account", async () => {
    const { stores, deps } = await harness();
    await stores.users.save(OTHER, { rules: RULES, enabled: true });
    await runTick(deps, USER, local("09:30"));
    expect(await stores.blocks.listForDate(OTHER, DATE)).toEqual([]);
    expect(await runsOf(stores, OTHER, ENGINE_TICK_FEED)).toEqual([]);
    expect(await stores.outbox.listUnsent(OTHER)).toEqual([]);
  });
});

// ------------------------------------------------------------------- the plan

describe("runTick, planning", () => {
  test("plans today and stores the blocks", async () => {
    const { stores, deps } = await harness();
    await runTick(deps, USER, local("09:30"));
    const blocks = await stores.blocks.listForDate(USER, DATE);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      taskId: TASK_A,
      state: "planned",
      start: local("09:30"),
      end: local("10:20"),
    });
    const day = await stores.days.get(USER, DATE);
    expect(day?.plannedAt).toBe(local("09:30"));
    // Nobody has said anything about energy, so the row still says nothing.
    expect(day?.energy).toBeNull();
  });

  test("a block in progress is not moved by a tick", async () => {
    const { stores, deps } = await harness();
    await stores.blocks.replacePlanned(USER, DATE, [aBlock()]);
    await stores.blocks.setState(USER, aBlock().id, "started");

    await runTick(deps, USER, local("14:20"));
    await runTick(deps, USER, local("14:30"));

    const blocks = await stores.blocks.listForDate(USER, DATE);
    const started = blocks.find((block) => block.id === aBlock().id);
    expect(started).toMatchObject({
      state: "started",
      start: local("14:00"),
      end: local("14:50"),
    });
    // Its task is not planned a second time on the same day.
    expect(blocks.filter((block) => block.taskId === TASK_A)).toHaveLength(1);
  });

  test("a tick with a failing calendar still plans", async () => {
    const failed: FeedRun = {
      feed: "calendar",
      startedAt: local("09:30"),
      finishedAt: local("09:30"),
      status: "error",
      count: 0,
      errorClass: "invalid_grant",
    };
    const { stores, deps } = await harness({
      deps: { loadFixed: async () => ({ fixed: [], calendar: failed }) },
    });
    const result = await runTick(deps, USER, local("09:30"));
    expect(result.steps.plan).toBe("ok");
    expect(await stores.blocks.listForDate(USER, DATE)).toHaveLength(1);
    expect((await runsOf(stores, USER, "calendar"))[0]).toMatchObject({
      status: "error",
      errorClass: "invalid_grant",
    });
  });

  test("a task that already has a time today is not planned a second time", async () => {
    const timed: FixedEvent = {
      id: `task:${TASK_A}`,
      title: "Write the brief",
      start: local("13:00"),
      end: local("14:30"),
      allDay: false,
      calendarId: null,
      location: null,
      countsTowardCap: false,
      source: "task",
    };
    const { stores, deps } = await harness({
      deps: { loadFixed: async () => ({ fixed: [timed], calendar: okRun(local("09:00")) }) },
    });

    await runTick(deps, USER, local("09:30"));

    expect(
      (await stores.blocks.listForDate(USER, DATE)).filter((block) => block.taskId === TASK_A),
    ).toEqual([]);
  });

  test("a task whose time lives on Google is not planned a second time either", async () => {
    // The common path for a time-blocked task: `tasks.gcal_event_id` is set, so
    // the only fixed event is the calendar's, carrying the task's id.
    const pushed: FixedEvent = {
      id: `task:${TASK_A}`,
      title: "Write the brief",
      start: local("13:00"),
      end: local("14:30"),
      allDay: false,
      calendarId: "cal-1",
      location: null,
      countsTowardCap: false,
      source: "google",
    };
    const { stores, deps } = await harness({
      deps: { loadFixed: async () => ({ fixed: [pushed], calendar: okRun(local("09:00")) }) },
    });

    await runTick(deps, USER, local("09:30"));

    expect(
      (await stores.blocks.listForDate(USER, DATE)).filter((block) => block.taskId === TASK_A),
    ).toEqual([]);
  });

  test("capped hours on the week's other days leave no room for income work", async () => {
    const roomy = await harness({ rules: CAPPED_RULES });
    await runTick(roomy.deps, USER, local("09:30"));
    expect(
      (await roomy.stores.blocks.listForDate(USER, DATE)).some((block) => block.kind === "income"),
    ).toBe(true);

    const full = await harness({
      rules: CAPPED_RULES,
      deps: { loadWeekCapHours: async () => ({ hours: 30, ok: true }) },
    });
    await runTick(full.deps, USER, local("09:30"));
    expect(
      (await full.stores.blocks.listForDate(USER, DATE)).some((block) => block.kind === "income"),
    ).toBe(false);
    expect((await full.stores.days.get(USER, DATE))?.dropped).toEqual([
      { candidateId: "income", reason: "cap" },
    ]);
  });

  test("a week whose capped hours cannot be read plans as if the week were full, visibly", async () => {
    const { stores, deps } = await harness({
      rules: CAPPED_RULES,
      deps: { loadWeekCapHours: async () => ({ hours: 0, ok: false }) },
    });

    const result = await runTick(deps, USER, local("09:30"));

    expect(
      (await stores.blocks.listForDate(USER, DATE)).some((block) => block.kind === "income"),
    ).toBe(false);
    // Visible three ways: the step, the tick's own run, and the calendar feed.
    expect(result.steps.plan).toBe("error");
    expect((await runsOf(stores, USER, ENGINE_TICK_FEED))[0].errorClass).toBe("cap-unknown");
    expect(
      (await runsOf(stores, USER, "calendar")).some((run) => run.errorClass === "cap-unknown"),
    ).toBe(true);
    // The rest of the day was still planned.
    expect((await stores.blocks.listForDate(USER, DATE)).length).toBeGreaterThan(0);
  });

  // F1. The cap CALENDARS are a different read from the week's hours, and it
  // used to sit outside loadFixed's try: one unreadable income_sources row
  // threw out of fixedToday and took the plan, the morning message and "later
  // today" down with it, on every tick. Now the plan runs and the cap, not
  // knowing which calendars count, fails closed exactly as an unknown week does.
  test("an unreadable set of cap calendars still plans the day, with the cap closed", async () => {
    const { stores, deps } = await harness({
      rules: CAPPED_RULES,
      deps: {
        // The week's hours are known. Only the cap calendars are not.
        loadWeekCapHours: async () => ({ hours: 0, ok: true }),
        loadFixed: async () => ({
          fixed: [],
          calendar: okRun(local("09:00")),
          capUnknown: true,
        }),
      },
    });

    const result = await runTick(deps, USER, local("09:30"));

    const blocks = await stores.blocks.listForDate(USER, DATE);
    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks.some((block) => block.kind === "income")).toBe(false);
    expect(result.steps.plan).toBe("error");
    expect((await runsOf(stores, USER, ENGINE_TICK_FEED))[0].errorClass).toBe("cap-unknown");
  });

  test("an unknown week is not a problem for an account with no cap at all", async () => {
    const { stores, deps } = await harness({
      deps: { loadWeekCapHours: async () => ({ hours: 0, ok: false }) },
    });
    const result = await runTick(deps, USER, local("09:30"));
    expect(result.steps.plan).toBe("ok");
    expect((await stores.blocks.listForDate(USER, DATE)).length).toBe(1);
  });

  test("loads the calendar once per tick, however many steps need it", async () => {
    let calls = 0;
    const { deps } = await harness({
      deps: {
        loadFixed: async () => {
          calls += 1;
          return { fixed: [], calendar: okRun(local("09:00")) };
        },
      },
    });
    await runTick(deps, USER, local("09:30"));
    expect(calls).toBe(1);
  });
});

// ---------------------------------------------------------------- closing out

describe("runTick, closing out", () => {
  test("a started block whose end has passed becomes done", async () => {
    const { stores, deps } = await harness();
    await stores.blocks.replacePlanned(USER, DATE, [aBlock()]);
    await stores.blocks.setState(USER, aBlock().id, "started");
    await runTick(deps, USER, local("15:00"));
    const blocks = await stores.blocks.listForDate(USER, DATE);
    expect(blocks.find((block) => block.id === aBlock().id)?.state).toBe("done");
  });

  test("yesterday's planned block is skipped and its started block is done", async () => {
    const { stores, deps } = await harness();
    const yesterday = "2026-11-08";
    await stores.blocks.replacePlanned(USER, yesterday, [
      aBlock({
        id: `${yesterday}:focus:${TASK_A}`,
        date: yesterday,
        start: local("10:00", yesterday),
        end: local("10:50", yesterday),
      }),
      aBlock({
        id: `${yesterday}:focus:${TASK_B}`,
        date: yesterday,
        taskId: TASK_B,
        start: local("14:00", yesterday),
        end: local("14:50", yesterday),
      }),
    ]);
    await stores.blocks.setState(USER, `${yesterday}:focus:${TASK_B}`, "started");

    await runTick(deps, USER, local("09:30"));

    const blocks = await stores.blocks.listForDate(USER, yesterday);
    expect(blocks.find((block) => block.taskId === TASK_A)).toMatchObject({
      state: "skipped",
      reason: "day ended",
    });
    expect(blocks.find((block) => block.taskId === TASK_B)?.state).toBe("done");
    expect(await stores.blocks.listOpenBefore(USER, DATE)).toEqual([]);
  });
});

// ------------------------------------------------------ lights out after midnight

// F3. The tick worked on the CALENDAR day, so at 00:00 a day whose lights out
// is 01:30 had already "ended": close-out skipped the blocks the 23:20 tick had
// just planned for after midnight, with the reason "day ended", before they
// started, and then the plan step put them back. Every night.
describe("runTick, a day whose lights out is after midnight", () => {
  const LATE_RULES: RulesDocument = {
    ...RULES,
    planner: { ...RULES.planner, lightsOut: "01:30" },
  };
  const TOMORROW = "2026-11-10";
  /** Fills 23:00 to midnight, so the evening's first free slot is 00:10. */
  const evening: FixedEvent = {
    id: "cal-1:evening",
    title: "Shift",
    start: local("23:00"),
    end: local("00:00", TOMORROW),
    allDay: false,
    calendarId: "cal-1",
    location: null,
    countsTowardCap: false,
    source: "google",
  };

  async function lateHarness() {
    return harness({
      rules: LATE_RULES,
      deps: {
        loadFixed: async () => ({ fixed: [evening], calendar: okRun(local("09:00")) }),
      },
    });
  }

  test("the 23:20 tick plans into the small hours", async () => {
    const { stores, deps } = await lateHarness();
    await runTick(deps, USER, local("23:20"));
    expect(await stores.blocks.listForDate(USER, DATE)).toMatchObject([
      { state: "planned", start: local("00:10", TOMORROW), end: local("01:00", TOMORROW) },
    ]);
  });

  test("the 00:00 tick leaves that block alone: the day has not ended", async () => {
    const { stores, deps } = await lateHarness();
    await runTick(deps, USER, local("23:20"));
    const result = await runTick(deps, USER, local("00:00", TOMORROW));

    expect(result.ok).toBe(true);
    expect(await stores.blocks.listForDate(USER, DATE)).toMatchObject([
      { state: "planned", start: local("00:10", TOMORROW) },
    ]);
    // Still planning the day that is running, so the next day has no record yet.
    expect((await stores.days.get(USER, DATE))?.plannedAt).toBe(local("00:00", TOMORROW));
    expect(await stores.days.get(USER, TOMORROW)).toBeNull();
  });

  test("the block is closed off once lights out has actually passed", async () => {
    const { stores, deps } = await lateHarness();
    await runTick(deps, USER, local("23:20"));
    await runTick(deps, USER, local("01:40", TOMORROW));

    expect(await stores.blocks.listForDate(USER, DATE)).toMatchObject([
      { state: "skipped", reason: "day ended" },
    ]);
    // And the new day is the one being planned now.
    expect((await stores.days.get(USER, TOMORROW))?.plannedAt).toBe(local("01:40", TOMORROW));
  });

  test("the morning message is not sent again in the small hours", async () => {
    const { stores, deps, telegram } = await lateHarness();
    const mornings = () => sentTexts(telegram).filter((text) => text.startsWith("Morning."));

    await runTick(deps, USER, local("09:00"));
    expect(mornings()).toHaveLength(1);

    await runTick(deps, USER, local("00:30", TOMORROW));
    expect(mornings()).toHaveLength(1);
    // The 00:30 tick touched the day that is running; tomorrow has no record
    // of a morning at all, so the one at its wake target is still to come.
    expect(await stores.days.get(USER, TOMORROW)).toBeNull();
    expect((await stores.days.get(USER, DATE))?.morningSentAt).toBe(local("09:00"));
  });

  test("an answer after midnight moves the block later in the same day", async () => {
    const { stores, deps } = await lateHarness();
    await runTick(deps, USER, local("23:20"));
    const block = (await stores.blocks.listForDate(USER, DATE))[0];
    // It is running at 00:30, so the tick asks; "later today" has to mean
    // later in THIS day, which still has an hour of window left.
    await runTick(deps, USER, local("00:30", TOMORROW));
    const ask = (await stores.asks.listOpen(USER)).find((a) => a.kind === "slip");
    expect(ask?.dedupeKey).toBe(`slip:${block.id}`);
  });
});

// ------------------------------------------------- an instant with milliseconds

// F2. Both routes build `now` with `new Date().toISOString()`, which carries
// milliseconds, and every v2 test built it on a whole minute, which is why none
// of this showed. `zonedIso` of a `.123` instant at a POSITIVE offset emitted
// "+08:60": Postgres refuses it (22009), `Date.parse` reads NaN, and the memory
// store read NaN as "no runs" rather than refusing it, so the two stores
// disagreed as well. Slips, watchdog, morning and prune all go through it.
describe("an instant that carries milliseconds", () => {
  const TOKYO = "Asia/Tokyo";
  const TOKYO_RULES: RulesDocument = {
    ...RULES,
    planner: { ...RULES.planner, timeZone: TOKYO },
  };

  function tokyo(wall: string, date = DATE): string {
    const [hour, minute] = wall.split(":").map(Number);
    return new Date(zonedWallTimeToUtcMs(date, hour, minute, TOKYO)).toISOString();
  }
  const withMillis = (instant: string) => instant.replace(".000Z", ".123Z");

  test("createEngineContext floors it, so nothing downstream sees a fraction", async () => {
    const { deps } = await harness({ rules: TOKYO_RULES });
    const ctx = await createEngineContext(deps, USER, withMillis(tokyo("09:40")));
    expect(ctx.now).toBe(tokyo("09:40"));
    expect(ctx.nowMs % 1000).toBe(0);
  });

  test("a tick east of UTC runs every step and writes readable instants", async () => {
    const { stores, deps } = await harness({ rules: TOKYO_RULES });
    await stores.blocks.replacePlanned(USER, DATE, [
      aBlock({ start: tokyo("09:00"), end: tokyo("09:50") }),
    ]);
    await stores.feeds.saveExpectation(USER, {
      feed: "calendar",
      label: "the calendar",
      everyMinutes: 60,
      graceMinutes: 10,
      minCount: 0,
      activeHours: null,
      enabledAt: tokyo("00:00", "2026-11-01"),
    });
    // Old enough that the prune step has something to delete.
    await stores.feeds.addRun(USER, okRun(tokyo("00:00", "2026-10-01")));

    const now = withMillis(tokyo("09:40"));
    expect(now).toContain(".123Z");

    const result = await runTick(deps, USER, now);

    expect(Object.entries(result.steps).filter(([, state]) => state !== "ok")).toEqual([]);
    expect(result.ok).toBe(true);

    // The slip ask's expiry is the instant zonedIso used to mangle.
    const slip = (await stores.asks.listOpen(USER)).find((ask) => ask.kind === "slip");
    expect(slip?.expiresAt).toBe(tokyo("10:10"));
    // And the prune cutoff was an instant Postgres would have taken.
    expect((await runsOf(stores, USER, "calendar")).map((run) => run.startedAt)).not.toContain(
      tokyo("00:00", "2026-10-01"),
    );
  });

  test("the memory store refuses an unreadable instant rather than finding nothing", async () => {
    const { stores } = await harness();
    // What zonedIso used to hand it. Postgres answers 22009; reading it as
    // "no runs" is how the two stores came to disagree.
    const mangled = "2026-11-09T09:40:00+08:60";
    await expect(stores.feeds.listRuns(USER, mangled)).rejects.toThrow(/not an instant/);
    await expect(stores.feeds.prune(USER, mangled)).rejects.toThrow(/not an instant/);
    await expect(stores.asks.countUnanswered(USER, "energy", mangled)).rejects.toThrow(
      /not an instant/,
    );
    await expect(stores.outbox.countInterruptsSince(USER, mangled)).rejects.toThrow(
      /not an instant/,
    );
  });
});

// --------------------------------------------------------------------- slips

describe("runTick, slips", () => {
  test("opens one slip ask for a block whose start is past the grace", async () => {
    const { stores, deps, telegram } = await harness();
    await stores.blocks.replacePlanned(USER, DATE, [aBlock()]);

    await runTick(deps, USER, plus(local("14:00"), SLIP_GRACE_MINUTES * MINUTE));

    const open = await stores.asks.listOpen(USER);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ kind: "slip", dedupeKey: `slip:${aBlock().id}` });
    expect(sentTexts(telegram)).toEqual(["Still doing Write the brief?"]);
  });

  test("waits while the slip ask is still open", async () => {
    const { stores, deps } = await harness();
    await stores.blocks.replacePlanned(USER, DATE, [aBlock()]);
    await runTick(deps, USER, local("14:15"));
    await runTick(deps, USER, local("14:25"));
    expect(await stores.asks.listOpen(USER)).toHaveLength(1);
    expect(
      (await stores.blocks.listForDate(USER, DATE)).find((block) => block.id === aBlock().id)
        ?.state,
    ).toBe("planned");
  });

  test("does not ask before the grace has passed", async () => {
    const { stores, deps } = await harness();
    await stores.blocks.replacePlanned(USER, DATE, [aBlock()]);
    await runTick(deps, USER, plus(local("14:00"), (SLIP_GRACE_MINUTES - 1) * MINUTE));
    expect(await stores.asks.listOpen(USER)).toEqual([]);
  });

  test("an ignored slip question moves the block later once and then skips it", async () => {
    const { stores, deps } = await harness();
    await stores.blocks.replacePlanned(USER, DATE, [aBlock()]);

    // 1. The block has begun and nothing was said, so the tick asks.
    await runTick(deps, USER, local("14:15"));
    const [asked] = await stores.asks.listOpen(USER);
    expect(asked.dedupeKey).toBe(`slip:${aBlock().id}`);

    // 2. Nobody answered within slipDefaultAfterMinutes, so the default
    //    applies: later today, same length, still planned.
    await runTick(deps, USER, local("14:50"));
    const moved = (await stores.blocks.listForDate(USER, DATE)).find(
      (block) => block.id === aBlock().id,
    );
    expect(moved).toMatchObject({ state: "planned", start: local("15:00"), end: local("15:50") });
    expect((await stores.asks.get(USER, asked.id))?.status).toBe("expired");

    // 3. It slipped again, and its question has already been answered for it.
    await runTick(deps, USER, local("15:15"));
    const skipped = (await stores.blocks.listForDate(USER, DATE)).find(
      (block) => block.id === aBlock().id,
    );
    expect(skipped).toMatchObject({ state: "skipped", reason: "slipped twice" });
  });

  test("two ticks at the expiry instant move the block once instead of skipping it", async () => {
    // The window this closes: tick A has expired the ask and is inside the
    // move, awaiting the calendar, while tick B reaches its slips step and
    // finds a resolved question on a block that has not moved yet.
    const { stores, deps } = await harness({
      deps: {
        loadFixed: async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          return { fixed: [], calendar: okRun(local("14:00")) };
        },
      },
    });
    await stores.blocks.replacePlanned(USER, DATE, [aBlock()]);
    await runTick(deps, USER, local("14:15"));

    await Promise.all([runTick(deps, USER, local("14:50")), runTick(deps, USER, local("14:50"))]);

    expect(
      (await stores.blocks.listForDate(USER, DATE)).find((block) => block.id === aBlock().id),
    ).toMatchObject({ state: "planned", start: local("15:00"), end: local("15:50") });
  });

  test("an effect that threw in the expire step does not become a skip in the slips step", async () => {
    // Path (a): asks.expire commits, then moveLaterToday throws inside the same
    // tick. The block has not moved, so it must not be read as a second slip.
    const { stores, deps } = await harness({
      deps: {
        loadFixed: async () => {
          throw new Error("the task list is unreadable");
        },
      },
    });
    await stores.blocks.replacePlanned(USER, DATE, [aBlock()]);
    await stores.asks.insert(USER, {
      id: "cccccccc-cccc-4ccc-8ccc-000000000011",
      userId: USER,
      kind: "slip",
      topic: `task:${TASK_A}`,
      text: "Still doing Write the brief?",
      options: [
        {
          id: "later",
          label: "Later today",
          effect: { type: "block.reschedule", blockId: aBlock().id, to: "later-today" },
        },
      ],
      defaultOptionId: "later",
      timeCritical: true,
      openedAt: local("14:15"),
      remindAt: null,
      remindedAt: null,
      expiresAt: local("14:45"),
      status: "open",
      answeredOptionId: null,
      answeredAt: null,
      assumed: false,
      dedupeKey: `slip:${aBlock().id}`,
    });

    const result = await runTick(deps, USER, local("14:50"));

    expect(result.steps.expire).toBe("error");
    expect(
      (await stores.blocks.listForDate(USER, DATE)).find((block) => block.id === aBlock().id),
    ).toMatchObject({ state: "planned", start: local("14:00") });
  });

  test("one block whose effect throws does not leave the rest of the day unasked", async () => {
    const { stores, deps } = await harness({
      deps: {
        loadFixed: async () => {
          throw new Error("the task list is unreadable");
        },
      },
    });
    await stores.blocks.replacePlanned(USER, DATE, [
      aBlock(),
      aBlock({ id: `${DATE}:focus:${TASK_B}`, taskId: TASK_B, title: "Read the paper" }),
    ]);
    // The first block's question is already resolved, and re-applying its
    // effect needs the calendar, which throws.
    await stores.asks.insert(USER, {
      id: "cccccccc-cccc-4ccc-8ccc-000000000012",
      userId: USER,
      kind: "slip",
      topic: `task:${TASK_A}`,
      text: "Still doing Write the brief?",
      options: [
        {
          id: "later",
          label: "Later today",
          effect: { type: "block.reschedule", blockId: aBlock().id, to: "later-today" },
        },
      ],
      defaultOptionId: "later",
      timeCritical: true,
      openedAt: local("14:05"),
      remindAt: null,
      remindedAt: null,
      expiresAt: local("14:10"),
      status: "expired",
      answeredOptionId: null,
      answeredAt: null,
      assumed: true,
      dedupeKey: `slip:${aBlock().id}`,
    });

    const result = await runTick(deps, USER, local("14:15"));

    expect(result.steps.slips).toBe("error");
    // The second block was still looked at, and asked about.
    const open = await stores.asks.listOpen(USER);
    expect(open.map((ask) => ask.dedupeKey)).toEqual([`slip:${DATE}:focus:${TASK_B}`]);
  });

  test("a tap that lands while a tick is running is not punished as a second slip", async () => {
    // Path (c): the tap records the answer and is inside moveLaterToday, waiting
    // on the calendar, while the tick reaches its slips step.
    const { stores, deps } = await harness({
      deps: {
        loadFixed: async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          return { fixed: [], calendar: okRun(local("14:00")) };
        },
      },
    });
    await stores.blocks.replacePlanned(USER, DATE, [aBlock()]);
    await runTick(deps, USER, local("14:15"));
    const [ask] = await stores.asks.listOpen(USER);

    const tap = handleIncoming(
      deps,
      { type: "answer", chatId: CHAT, askId: ask.id, optionId: "later", callbackId: "cb-1" },
      local("14:30"),
    );
    const tick = runTick(deps, USER, local("14:30"));
    await Promise.all([tap, tick]);

    expect(
      (await stores.blocks.listForDate(USER, DATE)).find((block) => block.id === aBlock().id),
    ).toMatchObject({ state: "planned", start: local("15:00") });
  });

  test("a resolved question whose effect never landed is applied, not punished", async () => {
    const { stores, deps } = await harness();
    await stores.blocks.replacePlanned(USER, DATE, [aBlock()]);
    await runTick(deps, USER, local("14:15"));
    const [ask] = await stores.asks.listOpen(USER);

    // The answer is recorded but its effect does not run: the shape a failed
    // step, or a crash between the two writes, leaves behind.
    await stores.asks.answer(USER, ask.id, "later", local("14:20"));

    await runTick(deps, USER, local("14:30"));

    expect(
      (await stores.blocks.listForDate(USER, DATE)).find((block) => block.id === aBlock().id),
    ).toMatchObject({ state: "planned", start: local("15:00") });
  });
});

// ------------------------------------------------------------------- morning

describe("runTick, the morning message", () => {
  test("opens the energy ask and queues one morning message", async () => {
    const { stores, deps, telegram } = await harness();
    await runTick(deps, USER, local("08:10"));

    const open = await stores.asks.listOpen(USER);
    expect(open.map((ask) => ask.kind)).toEqual(["energy"]);
    // F5. This account has no feed expectations, so there is nothing to call
    // alive. It used to say "All feeds alive.", which is the one thing a
    // watchdog must never say about nothing.
    expect(sentTexts(telegram)).toEqual([
      "Morning. Nothing fixed today.\nThen: Write the brief at 09:00.\nNothing is being watched yet. Energy today?",
    ]);
    expect(sentMessages(telegram)[0].msg.buttons.map((button) => button.optionId)).toEqual([
      "low",
      "ok",
      "good",
    ]);
    expect((await stores.days.get(USER, DATE))?.morningSentAt).toBe(local("08:10"));
  });

  test("names the first fixed thing and when to leave", async () => {
    const { deps, telegram } = await harness({
      rules: {
        ...RULES,
        planner: {
          ...RULES.planner,
          travel: [{ calendarId: "cal-1", locationIncludes: null, minutesBefore: 20, minutesAfter: 0 }],
        },
      },
      deps: {
        loadFixed: async () => ({
          fixed: [
            {
              id: "cal-1:event-1",
              title: "Shift",
              start: local("13:00"),
              end: local("17:00"),
              allDay: false,
              calendarId: "cal-1",
              location: "The shop",
              countsTowardCap: true,
              source: "google",
            },
          ],
          calendar: okRun(local("08:00")),
        }),
      },
    });
    await runTick(deps, USER, local("08:10"));
    expect(sentTexts(telegram)[0]).toContain("Morning. First thing: Shift at 13:00, leave by 12:40.");
  });

  test("two ticks at the same instant send one morning message", async () => {
    const { stores, deps, telegram } = await harness();
    const now = local("08:10");
    await Promise.all([runTick(deps, USER, now), runTick(deps, USER, now)]);
    expect(sentTexts(telegram)).toHaveLength(1);
    expect((await stores.outbox.listUnsent(USER)).filter((i) => i.kind === "morning")).toEqual([]);
  });

  test("does not run before the wake target or after noon", async () => {
    const early = await harness();
    await runTick(early.deps, USER, local("07:30"));
    expect(sentTexts(early.telegram)).toEqual([]);

    const late = await harness();
    await runTick(late.deps, USER, local("12:00"));
    expect(sentTexts(late.telegram)).toEqual([]);
    expect((await late.stores.days.get(USER, DATE))?.morningSentAt).toBeNull();
  });

  test("does not ask about energy when the day already has an answer", async () => {
    const { stores, deps, telegram } = await harness();
    await stores.days.patch(USER, DATE, { energy: "good", energyAssumed: false });
    await runTick(deps, USER, local("08:10"));
    expect(await stores.asks.listOpen(USER)).toEqual([]);
    expect(sentTexts(telegram)[0]).not.toContain("Energy today?");
  });

  test("a morning message does not spend the interrupt budget", async () => {
    const { stores, deps } = await harness();
    await runTick(deps, USER, local("08:10"));
    expect(await stores.outbox.countInterruptsSince(USER, local("00:00"))).toBe(0);
  });

  test("an energy question nobody answered defaults to ok, and says it assumed", async () => {
    const { stores, deps } = await harness();
    await runTick(deps, USER, local("08:10"));
    const [ask] = await stores.asks.listOpen(USER);

    // The energy ask expires at noon.
    await runTick(deps, USER, local("12:05"));

    expect((await stores.asks.get(USER, ask.id))?.status).toBe("expired");
    const day = await stores.days.get(USER, DATE);
    expect(day?.energy).toBe("ok");
    expect(day?.energyAssumed).toBe(true);
  });
});

// -------------------------------------------------------------------- asks

describe("runTick, how an ask reaches him", () => {
  test("a topic with two unanswered asks this week is held, not pushed", async () => {
    const { stores, deps, telegram } = await harness();
    for (const n of [1, 2]) {
      await stores.asks.insert(USER, {
        id: `cccccccc-cccc-4ccc-8ccc-00000000000${n}`,
        userId: USER,
        kind: "slip",
        topic: `task:${TASK_A}`,
        text: "Still doing it?",
        options: [{ id: "later", label: "Later today", effect: { type: "none" } }],
        defaultOptionId: "later",
        timeCritical: true,
        openedAt: local("09:00"),
        remindAt: null,
        remindedAt: null,
        expiresAt: local("09:30"),
        status: "expired",
        answeredOptionId: null,
        answeredAt: null,
        assumed: true,
        dedupeKey: `slip:old-${n}`,
      });
    }
    await stores.blocks.replacePlanned(USER, DATE, [aBlock()]);

    await runTick(deps, USER, local("14:15"));

    expect(await stores.asks.listOpen(USER)).toHaveLength(1);
    expect(sentTexts(telegram)).toEqual([]);
    expect(await stores.outbox.listUnsent(USER)).toEqual([]);
  });

  test("past the day's budget an ask is stored for the digest instead of pushed", async () => {
    const { stores, deps, telegram } = await harness({
      rules: { ...RULES, planner: { ...RULES.planner, interruptsPerDay: 1 } },
    });
    await stores.blocks.replacePlanned(USER, DATE, [
      aBlock(),
      aBlock({
        id: `${DATE}:focus:${TASK_B}`,
        taskId: TASK_B,
        title: "Read the paper",
      }),
    ]);

    await runTick(deps, USER, local("14:15"));

    const items = await stores.outbox.listUnsent(USER);
    const asks = (await stores.asks.listOpen(USER)).map((ask) => ask.id);
    expect(asks).toHaveLength(2);
    expect(sentTexts(telegram)).toHaveLength(1);
    expect(items.filter((item) => item.delivery === "digest")).toHaveLength(1);
  });
});

// ----------------------------------------------------------------- watchdog

describe("runTick, the watchdog", () => {
  function expectation(over: Partial<StoredExpectation> = {}): StoredExpectation {
    return {
      feed: "home-worker",
      label: "the home pc",
      everyMinutes: 15,
      graceMinutes: 5,
      minCount: 1,
      activeHours: null,
      enabledAt: plus(local("09:00"), -3 * DAY),
      ...over,
    };
  }

  function anAlert(over: Partial<Alert> = {}): Alert {
    return {
      id: "dddddddd-dddd-4ddd-8ddd-000000000001",
      cause: "no-run",
      feeds: ["home-worker"],
      since: local("09:00"),
      step: 0,
      lastSentAt: null,
      status: "open",
      ...over,
    };
  }

  test("a feed with no run at all opens an alert and announces it", async () => {
    const { stores, deps, telegram } = await harness();
    await stores.feeds.saveExpectation(USER, expectation());

    await runTick(deps, USER, local("13:30"));

    const open = await stores.alerts.listOpen(USER);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ cause: "no-run", feeds: ["home-worker"], step: 0 });
    expect(open[0].lastSentAt).toBe(local("13:30"));
    expect(sentTexts(telegram)).toContain("the home pc. 1 thing affected, day 1.");
  });

  test("an alert does not spend the interrupt budget", async () => {
    const { stores, deps } = await harness();
    await stores.feeds.saveExpectation(USER, expectation());
    await runTick(deps, USER, local("13:30"));
    expect(await stores.outbox.countInterruptsSince(USER, local("00:00"))).toBe(0);
  });

  test("an expectation younger than its interval plus grace is not judged", async () => {
    const { stores, deps, telegram } = await harness();
    await stores.feeds.saveExpectation(
      USER,
      expectation({ enabledAt: plus(local("13:30"), -10 * MINUTE) }),
    );
    await runTick(deps, USER, local("13:30"));
    expect(await stores.alerts.listOpen(USER)).toEqual([]);
    expect(sentTexts(telegram)).toEqual([]);
  });

  test("a probe's run counts as that feed reporting", async () => {
    const heartbeat: FeedRun = {
      feed: "home-worker",
      startedAt: plus(local("13:30"), -5 * MINUTE),
      finishedAt: plus(local("13:30"), -5 * MINUTE),
      status: "ok",
      count: 1,
      errorClass: null,
    };
    const { stores, deps } = await harness({ deps: { probes: [async () => heartbeat] } });
    await stores.feeds.saveExpectation(USER, expectation());
    await runTick(deps, USER, local("13:30"));
    expect(await stores.alerts.listOpen(USER)).toEqual([]);
  });

  test("a stale probe raises the alert", async () => {
    const heartbeat: FeedRun = {
      feed: "home-worker",
      startedAt: plus(local("13:30"), -5 * HOUR),
      finishedAt: plus(local("13:30"), -5 * HOUR),
      status: "ok",
      count: 1,
      errorClass: null,
    };
    const { stores, deps } = await harness({ deps: { probes: [async () => heartbeat] } });
    await stores.feeds.saveExpectation(USER, expectation());
    await runTick(deps, USER, local("13:30"));
    expect(await stores.alerts.listOpen(USER)).toHaveLength(1);
  });

  test("a probe that throws does not stop the watchdog", async () => {
    const { stores, deps } = await harness({
      deps: {
        probes: [
          async () => {
            throw new Error("worker_status is unreadable");
          },
        ],
      },
    });
    await stores.feeds.saveExpectation(USER, expectation());
    const result = await runTick(deps, USER, local("13:30"));
    expect(result.steps.watchdog).toBe("ok");
    expect(await stores.alerts.listOpen(USER)).toHaveLength(1);
  });

  test("a cause announced inside the quiet window reopens silently", async () => {
    const { stores, deps, telegram } = await harness();
    await stores.feeds.saveExpectation(USER, expectation());
    await stores.alerts.save(USER, {
      ...anAlert({
        id: "dddddddd-dddd-4ddd-8ddd-000000000009",
        status: "closed",
        lastSentAt: plus(local("13:30"), -(ALERT_REOPEN_QUIET_HOURS - 1) * HOUR),
      }),
    });

    await runTick(deps, USER, local("13:30"));

    const open = await stores.alerts.listOpen(USER);
    expect(open).toHaveLength(1);
    expect(open[0].lastSentAt).toBeNull();
    expect(sentTexts(telegram)).toEqual([]);
  });

  test("escalation is always announced", async () => {
    const { stores, deps, telegram } = await harness();
    await stores.feeds.saveExpectation(USER, expectation());
    await stores.alerts.save(
      USER,
      anAlert({ since: plus(local("13:30"), -3 * HOUR), lastSentAt: plus(local("13:30"), -3 * HOUR) }),
    );

    await runTick(deps, USER, local("13:30"));

    const open = await stores.alerts.listOpen(USER);
    expect(open[0].step).toBe(1);
    expect(sentTexts(telegram)).toContain("the home pc. 1 thing affected, day 1.");
  });

  test("a close is announced only when the alert had been announced", async () => {
    const good: FeedRun = {
      feed: "home-worker",
      startedAt: plus(local("13:30"), -5 * MINUTE),
      finishedAt: plus(local("13:30"), -5 * MINUTE),
      status: "ok",
      count: 1,
      errorClass: null,
    };

    const silent = await harness();
    await silent.stores.feeds.saveExpectation(USER, expectation());
    await silent.stores.feeds.addRun(USER, good);
    await silent.stores.alerts.save(USER, anAlert({ lastSentAt: null }));
    await runTick(silent.deps, USER, local("13:30"));
    expect(await silent.stores.alerts.listOpen(USER)).toEqual([]);
    expect(sentTexts(silent.telegram)).toEqual([]);

    const loud = await harness();
    await loud.stores.feeds.saveExpectation(USER, expectation());
    await loud.stores.feeds.addRun(USER, good);
    await loud.stores.alerts.save(USER, anAlert({ lastSentAt: local("09:00") }));
    await runTick(loud.deps, USER, local("13:30"));
    expect(await loud.stores.alerts.listOpen(USER)).toEqual([]);
    expect(sentTexts(loud.telegram)).toContain("I can see the home pc again.");
  });

  test("a changed feed list is stored and never announced", async () => {
    const { stores, deps, telegram } = await harness();
    await stores.feeds.saveExpectation(USER, expectation());
    await stores.alerts.save(
      USER,
      anAlert({ feeds: ["calendar"], since: local("13:25"), lastSentAt: local("13:25") }),
    );

    await runTick(deps, USER, local("13:30"));

    const open = await stores.alerts.listOpen(USER);
    expect(open[0].feeds).toEqual(["home-worker"]);
    expect(open[0].lastSentAt).toBe(local("13:25"));
    expect(sentTexts(telegram)).toEqual([]);
  });
});

// --------------------------------------------------------------------- send

describe("runTick, sending", () => {
  test("with no telegram client nothing is sent and the feed reads not-linked", async () => {
    const { stores, deps } = await harness({ telegram: null });
    const result = await runTick(deps, USER, local("08:10"));
    expect(result.ok).toBe(true);
    const [run] = await runsOf(stores, USER, TELEGRAM_FEED);
    expect(run).toMatchObject({ status: "error", errorClass: "not-linked", count: 0 });
    const queued = await stores.outbox.listUnsent(USER);
    expect(queued.every((item) => item.sentAt === null && item.claimedAt === null)).toBe(true);
  });

  test("with no linked chat nothing is sent and the feed reads not-linked", async () => {
    const { stores, deps, telegram } = await harness({ linked: false });
    await runTick(deps, USER, local("08:10"));
    expect(telegram.sent).toEqual([]);
    expect((await runsOf(stores, USER, TELEGRAM_FEED))[0].errorClass).toBe("not-linked");
  });

  test("a refused send stores a short error class and writes it on the telegram feed", async () => {
    const blocked: TelegramClient = {
      sendMessage: async () => {
        throw new TelegramError("sendMessage", 403);
      },
      answerCallback: async () => {},
      replaceButtons: async () => {},
    };
    const { stores, deps } = await harness({ telegram: blocked });
    await runTick(deps, USER, local("08:10"));

    const items = await stores.outbox.listUnsent(USER);
    expect(items[0].error).toBe("bot-blocked");
    expect(items[0].sentAt).toBeNull();
    const [run] = await runsOf(stores, USER, TELEGRAM_FEED);
    expect(run).toMatchObject({ status: "error", errorClass: "bot-blocked" });
  });

  test("a claimed item is never sent twice", async () => {
    const { stores, deps, telegram } = await harness();
    await runTick(deps, USER, local("08:10"));
    await runTick(deps, USER, local("08:20"));
    expect(sentTexts(telegram)).toHaveLength(1);
    expect((await stores.outbox.listUnsent(USER)).length).toBe(0);
  });

  test("quiet hours hold an alert until the wake target", async () => {
    const { stores, deps, telegram } = await harness();
    await stores.feeds.saveExpectation(USER, {
      feed: "home-worker",
      label: "the home pc",
      everyMinutes: 15,
      graceMinutes: 5,
      minCount: 1,
      activeHours: null,
      enabledAt: plus(local("09:00"), -3 * DAY),
    });

    // 02:00 is between lights out and the wake target.
    await runTick(deps, USER, local("02:00"));
    expect(telegram.sent).toEqual([]);
    const held = await stores.outbox.listUnsent(USER);
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({ kind: "alert", claimedAt: null });

    await runTick(deps, USER, local("08:05"));
    expect(sentTexts(telegram)).toContain("the home pc. 1 thing affected, day 1.");
  });

  test("a night-guard ask is the one thing quiet hours let through", async () => {
    const { stores, deps, telegram } = await harness();
    const { ask } = await stores.asks.insert(USER, {
      id: "eeeeeeee-eeee-4eee-8eee-000000000001",
      userId: USER,
      kind: "night-guard",
      topic: "night",
      text: "Still up?",
      options: [{ id: "bed", label: "Going to bed", effect: { type: "none" } }],
      defaultOptionId: "bed",
      timeCritical: true,
      openedAt: local("02:00"),
      remindAt: null,
      remindedAt: null,
      expiresAt: local("03:00"),
      status: "open",
      answeredOptionId: null,
      answeredAt: null,
      assumed: false,
      dedupeKey: "night-guard:1",
    });
    await stores.outbox.enqueue(USER, {
      id: "ffffffff-ffff-4fff-8fff-000000000001",
      userId: USER,
      kind: "ask",
      dedupeKey: `ask:${ask.id}`,
      delivery: "interrupt",
      message: { text: "Still up?", buttons: [] },
      askId: ask.id,
      createdAt: local("02:00"),
      claimedAt: null,
      sentAt: null,
      chatMessageId: null,
      error: null,
    });

    await runTick(deps, USER, local("02:05"));
    expect(sentTexts(telegram)).toEqual(["Still up?"]);
  });

  test("the backlog from before the chat was linked is retired, not flushed", async () => {
    const { stores, deps, telegram } = await harness({ linked: false });
    // Three mornings nobody could be told about.
    await runTick(deps, USER, local("08:10", "2026-11-07"));
    await runTick(deps, USER, local("08:10", "2026-11-08"));
    await runTick(deps, USER, local("08:10", DATE));
    expect(telegram.sent).toEqual([]);
    expect(await stores.outbox.listUnsent(USER)).toHaveLength(3);

    await stores.channels.setPairing(USER, HASH, plus(local("08:30"), DAY));
    await stores.channels.redeemPairing(HASH, CHAT, local("08:30"));

    await runTick(deps, USER, local("09:00"));

    // Today's, and only today's.
    expect(sentTexts(telegram)).toHaveLength(1);
    expect(sentTexts(telegram)[0]).toContain("Morning.");
    const left = await stores.outbox.listUnsent(USER);
    expect(left).toHaveLength(2);
    expect(left.every((item) => item.error === "stale" && item.claimedAt !== null)).toBe(true);
    // Retiring a message is not a channel failure.
    expect((await runsOf(stores, USER, TELEGRAM_FEED))[0]).toMatchObject({
      status: "ok",
      count: 1,
    });
  });

  test("an alert message whose alert has closed is retired, not sent", async () => {
    const { stores, deps, telegram } = await harness();
    const alertId = "dddddddd-dddd-4ddd-8ddd-000000000021";
    await stores.alerts.save(USER, {
      id: alertId,
      cause: "no-run",
      feeds: ["home-worker"],
      since: local("13:00"),
      step: 0,
      lastSentAt: null,
      status: "closed",
    });
    await stores.outbox.enqueue(USER, {
      id: "ffffffff-ffff-4fff-8fff-000000000021",
      userId: USER,
      kind: "alert",
      dedupeKey: `alert:${alertId}:open:0`,
      delivery: "interrupt",
      message: { text: "the home pc. 1 thing affected, day 1.", buttons: [] },
      askId: null,
      createdAt: local("13:20"),
      claimedAt: null,
      sentAt: null,
      chatMessageId: null,
      error: null,
    });

    await runTick(deps, USER, local("13:30"));

    expect(sentTexts(telegram)).toEqual([]);
    expect((await stores.outbox.listUnsent(USER))[0].error).toBe("stale");
  });

  test("an alert counts as announced when its message is sent, not when it is queued", async () => {
    const { stores, deps } = await harness();
    await stores.feeds.saveExpectation(USER, {
      feed: "home-worker",
      label: "the home pc",
      everyMinutes: 15,
      graceMinutes: 5,
      minCount: 1,
      activeHours: null,
      enabledAt: plus(local("09:00"), -3 * DAY),
    });

    // Queued in the quiet hours, so nothing went out.
    await runTick(deps, USER, local("02:00"));
    expect((await stores.alerts.listOpen(USER))[0].lastSentAt).toBeNull();

    await runTick(deps, USER, local("08:05"));
    expect((await stores.alerts.listOpen(USER))[0].lastSentAt).toBe(local("08:05"));
  });

  test("an ask that could not be delivered gives its budget unit back", async () => {
    const blocked: TelegramClient = {
      sendMessage: async () => {
        throw new TelegramError("sendMessage", 403);
      },
      answerCallback: async () => {},
      replaceButtons: async () => {},
    };
    const { stores, deps } = await harness({
      rules: { ...RULES, planner: { ...RULES.planner, interruptsPerDay: 1 } },
      telegram: blocked,
    });
    await stores.blocks.replacePlanned(USER, DATE, [aBlock()]);
    await runTick(deps, USER, local("14:15"));
    expect((await stores.outbox.listUnsent(USER))[0].error).toBe("bot-blocked");

    await stores.blocks.replacePlanned(USER, DATE, [
      aBlock(),
      aBlock({ id: `${DATE}:focus:${TASK_B}`, taskId: TASK_B, title: "Read the paper" }),
    ]);
    await runTick(deps, USER, local("14:30"));

    // The day's one interrupt was never delivered, so the second question is
    // still allowed to interrupt rather than falling to the digest.
    const queued = await stores.outbox.listUnsent(USER);
    expect(queued.filter((item) => item.kind === "ask" && item.delivery === "interrupt")).toHaveLength(
      2,
    );
  });

  test("a morning that missed its window is not sent in the afternoon", async () => {
    const { stores, deps, telegram } = await harness({ linked: false });
    await runTick(deps, USER, local("11:50"));
    await stores.channels.setPairing(USER, HASH, plus(local("12:00"), DAY));
    await stores.channels.redeemPairing(HASH, CHAT, local("12:00"));

    await runTick(deps, USER, local("12:30"));

    // The block the 11:50 plan placed has begun by now, so a slip question is
    // live and may go out. The morning is what must not.
    expect(sentTexts(telegram).some((text) => text.startsWith("Morning."))).toBe(false);
    expect(
      (await stores.outbox.listUnsent(USER)).find((item) => item.kind === "morning")?.error,
    ).toBe("stale");
  });

  test("a question that is no longer open is never pushed", async () => {
    const { stores, deps, telegram } = await harness({ linked: false });
    await stores.blocks.replacePlanned(USER, DATE, [aBlock()]);
    await runTick(deps, USER, local("14:15"));
    const [ask] = await stores.asks.listOpen(USER);
    await stores.asks.answer(USER, ask.id, "did", local("14:20"));

    await stores.channels.setPairing(USER, HASH, plus(local("14:30"), DAY));
    await stores.channels.redeemPairing(HASH, CHAT, local("14:30"));
    await runTick(deps, USER, local("14:40"));

    expect(sentTexts(telegram)).toEqual([]);
    const retired = (await stores.outbox.listUnsent(USER)).find((item) => item.kind === "ask");
    expect(retired?.error).toBe("stale");
  });

  test("a digest item is never pushed", async () => {
    const { stores, deps, telegram } = await harness();
    await stores.outbox.enqueue(USER, {
      id: "ffffffff-ffff-4fff-8fff-000000000002",
      userId: USER,
      kind: "note",
      dedupeKey: "note:1",
      delivery: "digest",
      message: { text: "Later.", buttons: [] },
      askId: null,
      createdAt: local("09:00"),
      claimedAt: null,
      sentAt: null,
      chatMessageId: null,
      error: null,
    });
    await runTick(deps, USER, local("09:30"));
    expect(sentTexts(telegram)).not.toContain("Later.");
  });
});

// -------------------------------------------------------------------- prune

describe("runTick, pruning", () => {
  test("drops this account's feed runs past the retention window", async () => {
    const { stores, deps } = await harness();
    await stores.feeds.addRun(USER, {
      ...okRun(plus(local("09:30"), -(FEED_RUN_RETENTION_DAYS + 1) * DAY)),
      feed: "old",
    });
    await stores.feeds.addRun(USER, { ...okRun(plus(local("09:30"), -1 * DAY)), feed: "recent" });

    await runTick(deps, USER, local("09:30"));

    const since = plus(local("09:30"), -60 * DAY);
    const feeds = (await stores.feeds.listRuns(USER, since)).map((run) => run.feed);
    expect(feeds).not.toContain("old");
    expect(feeds).toContain("recent");
  });
});

// ------------------------------------------------------------------- status

describe("tickStatus", () => {
  test("reads the newest tick across the enabled accounts, with no per account data", async () => {
    const { stores, deps } = await harness();
    await stores.users.save(OTHER, { rules: RULES, enabled: true });
    await runTick(deps, USER, local("09:30"));

    const status = await tickStatus(stores, local("09:40"));
    expect(status).toEqual({ ok: true, lastTickAt: local("09:30"), staleMinutes: 10 });
  });

  test("is not ok when the newest tick is older than thirty minutes", async () => {
    const { stores, deps } = await harness();
    await runTick(deps, USER, local("09:30"));
    const status = await tickStatus(stores, local("10:05"));
    expect(status.ok).toBe(false);
    expect(status.staleMinutes).toBe(35);
  });

  test("is not ok when nothing has ticked at all", async () => {
    const stores = createMemoryStores();
    await stores.users.save(USER, { rules: RULES, enabled: true });
    expect(await tickStatus(stores, local("09:30"))).toEqual({
      ok: false,
      lastTickAt: null,
      staleMinutes: null,
    });
  });
});
