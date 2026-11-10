// @vitest-environment node
// Task 7, the shapes the engine reads the world in: task rows to candidates
// (behaviour 8), calendar events and time-blocked tasks to fixed events
// (behaviour 9), the week stats the tick hands the planner, and the one change
// to utils/google/calendar.ts (behaviour 12).
//
// The calendar cases need the REAL calendar module with a stubbed service
// client, because the thing under test is what it throws when Google refuses a
// token refresh. The cookie client is mocked to throw: the tick has no session,
// so a path that reaches for one is a defect, not a fallback.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const stubs = vi.hoisted(() => ({
  tokenRow: null as Record<string, unknown> | null,
  rows: {} as Record<string, unknown[]>,
}));

vi.mock("@/utils/supabase/server", () => ({
  createClient: async () => {
    throw new Error("the tick has no cookie session");
  },
}));

// A thenable PostgREST stub: a builder that answers with whatever this test
// scripted for that table, so the adapters below run their real query chains.
vi.mock("@/utils/supabase/service", () => {
  const client = {
    from(table: string) {
      const chain = {
        select: () => chain,
        update: () => chain,
        eq: () => chain,
        in: () => chain,
        maybeSingle: async () => ({
          data: table === "google_tokens" ? stubs.tokenRow : null,
          error: null,
        }),
        then: (resolve: (answer: { data: unknown; error: unknown }) => unknown) =>
          resolve({ data: stubs.rows[table] ?? [], error: null }),
      };
      return chain;
    },
  };
  return { createServiceClient: () => client };
});

import type { SupabaseClient } from "@supabase/supabase-js";

import { GoogleCalendarConnectionError, listEvents } from "@/utils/google/calendar";
import { createServiceClient } from "@/utils/supabase/service";
import {
  createLoadFixed,
  tasksToCandidates,
  toFixedEvents,
  type EngineCalendarEvent,
  type EngineTaskRow,
} from "@/app/lib/v2/engine/sources";
import { HOME_WORKER_FEED, homeWorkerProbe } from "@/app/lib/v2/engine/probes";
import { weekStatsFromBlocks } from "@/app/lib/v2/engine/tick";
import { parseRules } from "@/app/lib/v2/rules";
import type { EngineUser } from "@/app/lib/v2/store/types";
import type { Block } from "@/app/lib/v2/types";

const USER = "11111111-1111-4111-8111-111111111111";
const TASK_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const TASK_B = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const ZONE = "America/Phoenix";

const user: EngineUser = {
  userId: USER,
  timeZone: ZONE,
  rules: {
    planner: { timeZone: ZONE },
    lanes: [
      { key: "lane-a", label: "Lane A", color: "#b5ff3c", groupIds: ["g1"], hardDates: true },
      { key: "lane-b", label: "Lane B", color: "#6d8fe8", groupIds: ["g2"], hardDates: false },
    ],
    feedLabels: {},
  },
};

function row(over: Partial<EngineTaskRow> = {}): EngineTaskRow {
  return {
    id: TASK_A,
    title: "Write the brief",
    group_id: "g1",
    due_date: null,
    due_time: null,
    status: "todo",
    estimated_minutes: 50,
    duration_min: null,
    ...over,
  };
}

describe("tasksToCandidates", () => {
  test("keeps open tasks only", () => {
    const rows = [
      row({ id: TASK_A, status: "todo" }),
      row({ id: TASK_B, status: "done" }),
    ];
    expect(tasksToCandidates(rows, user, new Set()).map((c) => c.id)).toEqual([TASK_A]);
  });

  test("resolves the lane from the task's group and the kind from the lane", () => {
    const [step, side] = tasksToCandidates(
      [row({ id: TASK_A, group_id: "g1" }), row({ id: TASK_B, group_id: "g9" })],
      user,
      new Set(),
    );
    expect(step.lane).toBe("lane-a");
    expect(step.kind).toBe("step");
    expect(side.lane).toBeNull();
    expect(side.kind).toBe("side");
  });

  test("a task with no group at all is a side quest with no lane", () => {
    const [only] = tasksToCandidates([row({ group_id: null })], user, new Set());
    expect(only.lane).toBeNull();
    expect(only.kind).toBe("side");
  });

  test("due is the due date at the due time, in the user's zone", () => {
    const [only] = tasksToCandidates(
      [row({ due_date: "2026-11-10", due_time: "14:30" })],
      user,
      new Set(),
    );
    expect(only.due).toBe("2026-11-10T14:30:00-07:00");
  });

  test("due is 23:59 local when the task has a date and no time", () => {
    const [only] = tasksToCandidates([row({ due_date: "2026-11-10" })], user, new Set());
    expect(only.due).toBe("2026-11-10T23:59:00-07:00");
  });

  test("an undated task has no due instant", () => {
    const [only] = tasksToCandidates([row()], user, new Set());
    expect(only.due).toBeNull();
  });

  test("hard is true only for a dated task in a lane whose hardDates is true", () => {
    const [laneA, laneB, undated] = tasksToCandidates(
      [
        row({ id: TASK_A, group_id: "g1", due_date: "2026-11-10" }),
        row({ id: TASK_B, group_id: "g2", due_date: "2026-11-10" }),
        row({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3", group_id: "g1" }),
      ],
      user,
      new Set(),
    );
    expect(laneA.hard).toBe(true);
    expect(laneB.hard).toBe(false);
    expect(undated.hard).toBe(false);
  });

  test("minutes is estimated_minutes, and null stays null", () => {
    const [sized, unsized] = tasksToCandidates(
      [
        row({ id: TASK_A, estimated_minutes: 20 }),
        row({ id: TASK_B, estimated_minutes: null }),
      ],
      user,
      new Set(),
    );
    expect(sized.minutes).toBe(20);
    expect(unsized.minutes).toBeNull();
  });

  test("earlyTouchDone is true for the ids that already had their touch", () => {
    const [touched, fresh] = tasksToCandidates(
      [row({ id: TASK_A }), row({ id: TASK_B })],
      user,
      new Set([TASK_A]),
    );
    expect(touched.earlyTouchDone).toBe(true);
    expect(fresh.earlyTouchDone).toBe(false);
  });
});

describe("toFixedEvents", () => {
  function event(over: Partial<EngineCalendarEvent> = {}): EngineCalendarEvent {
    return {
      id: "cal-1:event-1",
      summary: "Shift",
      start: "2026-11-09T16:00:00.000Z",
      end: "2026-11-09T20:00:00.000Z",
      allDay: false,
      calendarId: "cal-1",
      location: "The shop",
      ...over,
    };
  }

  test("a timed event becomes a google fixed event, capped when its calendar is", () => {
    const [capped, free] = toFixedEvents(
      [event(), event({ id: "cal-2:event-2", calendarId: "cal-2" })],
      [],
      new Set(["cal-1"]),
      ZONE,
    );
    expect(capped).toMatchObject({
      id: "cal-1:event-1",
      title: "Shift",
      source: "google",
      allDay: false,
      countsTowardCap: true,
      calendarId: "cal-1",
      location: "The shop",
    });
    expect(free.countsTowardCap).toBe(false);
  });

  test("an all day event keeps allDay true and spans the local day", () => {
    const [only] = toFixedEvents(
      [event({ allDay: true, start: "2026-11-09", end: "2026-11-10" })],
      [],
      new Set(),
      ZONE,
    );
    expect(only.allDay).toBe(true);
    expect(only.start).toBe("2026-11-09T00:00:00-07:00");
    expect(only.end).toBe("2026-11-10T00:00:00-07:00");
  });

  test("a task with both a due time and a duration becomes a task fixed event", () => {
    const [only] = toFixedEvents(
      [],
      [row({ due_date: "2026-11-09", due_time: "13:00", duration_min: 90 })],
      new Set(),
      ZONE,
    );
    expect(only).toMatchObject({
      title: "Write the brief",
      source: "task",
      allDay: false,
      countsTowardCap: false,
      calendarId: null,
      start: "2026-11-09T13:00:00-07:00",
      end: "2026-11-09T14:30:00-07:00",
    });
  });

  test("a task with a due time but no duration is not a fixed event", () => {
    expect(
      toFixedEvents([], [row({ due_date: "2026-11-09", due_time: "13:00" })], new Set(), ZONE),
    ).toEqual([]);
  });

  test("a task with a duration but no due time is not a fixed event", () => {
    expect(
      toFixedEvents([], [row({ due_date: "2026-11-09", duration_min: 60 })], new Set(), ZONE),
    ).toEqual([]);
  });

  test("a closed task never becomes a fixed event", () => {
    expect(
      toFixedEvents(
        [],
        [row({ status: "done", due_date: "2026-11-09", due_time: "13:00", duration_min: 60 })],
        new Set(),
        ZONE,
      ),
    ).toEqual([]);
  });
});

describe("weekStatsFromBlocks", () => {
  const rules = parseRules({
    timeZone: ZONE,
    incomeTarget: { lane: "lane-income", weeklyHours: 10, blockMinutes: 120 },
    gym: { perWeek: 2, minutes: 60, notBefore: "16:00" },
  });

  function block(over: Partial<Block> = {}): Block {
    return {
      id: "2026-11-10:income:income",
      date: "2026-11-10",
      start: "2026-11-10T17:00:00.000Z",
      end: "2026-11-10T19:00:00.000Z",
      kind: "income",
      lane: "lane-income",
      taskId: null,
      title: "Income work",
      state: "planned",
      reason: "income-target",
      ...over,
    };
  }

  test("counts income hours and capped hours from the week's other income blocks", () => {
    const stats = weekStatsFromBlocks("2026-11-09", [block()], rules);
    expect(stats.incomeHoursElsewhere).toBe(2);
    expect(stats.capHoursElsewhere).toBe(2);
    expect(stats.gymSessionsDone).toBe(0);
  });

  test("a skipped block counts for nothing", () => {
    const stats = weekStatsFromBlocks("2026-11-09", [block({ state: "skipped" })], rules);
    expect(stats.incomeHoursElsewhere).toBe(0);
    expect(stats.capHoursElsewhere).toBe(0);
  });

  test("counts gym sessions that are still planned, so the week keeps its limit", () => {
    const stats = weekStatsFromBlocks("2026-11-09", [
      block({ id: "2026-11-10:gym:gym", kind: "gym", lane: null, title: "Gym" }),
      block({
        id: "2026-11-11:gym:gym",
        date: "2026-11-11",
        start: "2026-11-11T17:00:00.000Z",
        end: "2026-11-11T18:00:00.000Z",
        kind: "gym",
        lane: null,
        state: "done",
        title: "Gym",
      }),
    ], rules);
    expect(stats.gymSessionsDone).toBe(2);
  });

  test("a block of the day being planned is never its own week's elsewhere", () => {
    const stats = weekStatsFromBlocks("2026-11-10", [block()], rules);
    expect(stats.incomeHoursElsewhere).toBe(0);
  });
});

describe("GoogleCalendarConnectionError", () => {
  const WINDOW = { timeMin: "2026-11-09T00:00:00.000Z", timeMax: "2026-11-10T00:00:00.000Z" };
  const warned: string[] = [];

  beforeEach(() => {
    warned.length = 0;
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key-for-tests";
    process.env.GOOGLE_CLIENT_ID = "client-id";
    process.env.GOOGLE_CLIENT_SECRET = "client-secret";
    stubs.tokenRow = {
      access_token: "ACCESS-TOKEN-VALUE",
      refresh_token: "REFRESH-TOKEN-VALUE",
      // Already expired, so the refresh path runs.
      expires_at: new Date(Date.now() - 120_000).toISOString(),
      scopes: "https://www.googleapis.com/auth/calendar.readonly",
    };
    vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warned.push(args.map((arg) => String(arg)).join(" "));
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function refuseRefresh(body: unknown, status = 400) {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify(body), {
            status,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
  }

  test("carries Google's error code and logs one line with it and no token", async () => {
    refuseRefresh({ error: "invalid_grant", error_description: "Token has been expired" });
    const error = await listEvents(USER, WINDOW).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(GoogleCalendarConnectionError);
    expect((error as GoogleCalendarConnectionError).code).toBe("invalid_grant");

    const logged = warned.join("\n");
    expect(logged).toContain("invalid_grant");
    expect(logged).not.toContain("REFRESH-TOKEN-VALUE");
    expect(logged).not.toContain("ACCESS-TOKEN-VALUE");
    expect(logged).not.toContain("client-secret");
  });

  test("reads unknown when the body carries no error code", async () => {
    refuseRefresh({ hint: "nothing useful" });
    const error = await listEvents(USER, WINDOW).then(
      () => null,
      (e: unknown) => e,
    );
    expect((error as GoogleCalendarConnectionError).code).toBe("unknown");
  });

  test("never logs provider free text, only a code shaped like Google's", async () => {
    refuseRefresh({ error: "the user 'someone@example.com' revoked access" });
    const error = await listEvents(USER, WINDOW).then(
      () => null,
      (e: unknown) => e,
    );
    expect((error as GoogleCalendarConnectionError).code).toBe("unknown");
    const logged = warned.join("\n");
    expect(logged).not.toContain("example.com");
  });

  test("existing callers keep working: the message and a default code are unchanged", () => {
    const plain = new GoogleCalendarConnectionError();
    expect(plain.message).toContain("google calendar connection failed");
    expect(plain.code).toBe("unknown");
    expect(new GoogleCalendarConnectionError("custom message").message).toBe("custom message");
  });

  test("the production loadFixed reports a refused calendar and still returns what it has", async () => {
    // No google_tokens row, which the calendar module reads as a broken
    // connection: the one failure the tick must survive (behaviour 4).
    stubs.tokenRow = null;
    stubs.rows.tasks = [row({ due_date: "2026-11-09", due_time: "13:00", duration_min: 90 })];
    stubs.rows.income_sources = [{ google_calendar_id: "cal-1" }];

    const loadFixed = createLoadFixed(createServiceClient() as unknown as SupabaseClient);
    const { fixed, calendar } = await loadFixed(USER, "2026-11-09", user);

    expect(calendar).toMatchObject({
      feed: "calendar",
      status: "error",
      errorClass: "calendar-auth",
      count: 0,
    });
    expect(fixed.map((event) => event.source)).toEqual(["task"]);
    expect(fixed[0].start).toBe("2026-11-09T13:00:00-07:00");
  });

  test("the production loadFixed asks Google for the user's own local day", async () => {
    stubs.tokenRow = {
      access_token: "ACCESS-TOKEN-VALUE",
      refresh_token: "REFRESH-TOKEN-VALUE",
      expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
      scopes: "https://www.googleapis.com/auth/calendar.readonly",
    };
    stubs.rows.tasks = [];
    stubs.rows.income_sources = [{ google_calendar_id: "cal-1" }];

    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const url = String(input);
        urls.push(url);
        const body = url.includes("calendarList")
          ? {
              items: [
                { id: "cal-1", summary: "Work", accessRole: "owner", backgroundColor: "#fff" },
              ],
            }
          : {
              items: [
                {
                  id: "event-1",
                  summary: "Shift",
                  start: { dateTime: "2026-11-09T13:00:00-07:00" },
                  end: { dateTime: "2026-11-09T17:00:00-07:00" },
                },
              ],
            };
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    const loadFixed = createLoadFixed(createServiceClient() as unknown as SupabaseClient);
    const { fixed, calendar } = await loadFixed(USER, "2026-11-09", user);

    const events = urls.find((url) => url.includes("/events"));
    expect(events).toContain(`timeMin=${encodeURIComponent("2026-11-09T07:00:00.000Z")}`);
    expect(events).toContain(`timeMax=${encodeURIComponent("2026-11-10T07:00:00.000Z")}`);
    expect(calendar).toMatchObject({ status: "ok", count: 1, errorClass: null });
    // cal-1 belongs to an income source, so its hours count toward the cap.
    expect(fixed).toHaveLength(1);
    expect(fixed[0]).toMatchObject({ source: "google", countsTowardCap: true, title: "Shift" });
  });
});

describe("homeWorkerProbe", () => {
  function client(answer: { data: unknown; error: unknown }): SupabaseClient {
    return {
      from: () => ({
        select: () => ({ eq: () => ({ maybeSingle: async () => answer }) }),
      }),
    } as unknown as SupabaseClient;
  }

  const NOW = "2026-11-09T20:00:00.000Z";

  test("reads the newest heartbeat and stamps the run at the heartbeat, not at now", async () => {
    const probe = homeWorkerProbe(client({ data: { last_seen_at: "2026-11-09T19:55:00+00:00" }, error: null }));
    expect(await probe(USER, NOW)).toEqual({
      feed: HOME_WORKER_FEED,
      startedAt: "2026-11-09T19:55:00.000Z",
      finishedAt: "2026-11-09T19:55:00.000Z",
      status: "ok",
      count: 1,
      errorClass: null,
    });
  });

  test("reports nothing when there is no heartbeat, which reads as blind", async () => {
    const probe = homeWorkerProbe(client({ data: null, error: null }));
    expect(await probe(USER, NOW)).toBeNull();
  });

  test("a malformed heartbeat is not a heartbeat", async () => {
    const probe = homeWorkerProbe(client({ data: { last_seen_at: "soon" }, error: null }));
    expect(await probe(USER, NOW)).toBeNull();
  });

  test("a failed read is a failed run, with a class and no provider message", async () => {
    const probe = homeWorkerProbe(
      client({ data: null, error: { message: "permission denied for table worker_status" } }),
    );
    expect(await probe(USER, NOW)).toEqual({
      feed: HOME_WORKER_FEED,
      startedAt: NOW,
      finishedAt: NOW,
      status: "error",
      count: 0,
      errorClass: "probe-failed",
    });
  });
});
