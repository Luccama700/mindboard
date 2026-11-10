// Where the engine's two inputs come from: what is already on the day (fixed
// events) and what it may place (candidates).
//
// The top half is pure and is what the tests pin. The bottom half is the only
// place in the engine that talks to Google or to Postgres, and it is reached
// through `TickDeps`, so `runTick` itself imports neither and every engine test
// runs on fakes.
//
// THE TICK HAS NO COOKIE SESSION. It runs from a cron post and a webhook, for
// several accounts, so every read here goes through the service client with an
// explicit user_id filter, exactly as the MCP snapshot does
// (app/lib/snapshots/planning-read.ts). That filter is the whole tenant
// boundary: the service client bypasses RLS.

import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import { zonedDateKey, zonedIso, zonedWallTimeToUtcMs } from "@/app/lib/snapshots/zoned-time";
import { createTelegramClient } from "@/app/lib/v2/channel/telegram";
import { CALENDAR_FEED, type TickDeps } from "@/app/lib/v2/engine/tick";
import { createProbes } from "@/app/lib/v2/engine/probes";
import { shiftDateKey } from "@/app/lib/v2/plan/day";
import { createSupabaseStores } from "@/app/lib/v2/store/supabase";
import type { EngineUser, Stores } from "@/app/lib/v2/store/types";
import type { Candidate, DateKey, FeedRun, FixedEvent, Instant } from "@/app/lib/v2/types";
import { GoogleCalendarConnectionError, listEvents } from "@/utils/google/calendar";
import { createServiceClient } from "@/utils/supabase/service";

/** The task statuses that are still open. The same two the MCP snapshot reads. */
export const OPEN_TASK_STATUSES = ["todo", "doing"] as const;

/** What a task's row has to carry for the engine. A subset of `tasks`. */
export interface EngineTaskRow {
  id: string;
  title: string | null;
  group_id: string | null;
  due_date: string | null;
  /** A Postgres `time`, so "14:30" or "14:30:00". */
  due_time: string | null;
  status: string;
  estimated_minutes: number | null;
  duration_min: number | null;
}

/** What a calendar event has to carry. A subset of utils/google/calendar's. */
export interface EngineCalendarEvent {
  id: string;
  summary: string;
  start: string;
  end: string;
  allDay: boolean;
  calendarId: string;
  location?: string | null;
}

const TASK_COLUMNS =
  "id, title, group_id, due_date, due_time, status, estimated_minutes, duration_min";

/** A title is the user's own text; this is only for a row that has none. */
const UNTITLED = "untitled";
/** A task with no due time closes at the end of its local day. */
const END_OF_DAY = { hour: 23, minute: 59 };
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const WALL_TIME = /^(\d{1,2}):(\d{2})/;

function isOpen(status: string): boolean {
  return (OPEN_TASK_STATUSES as readonly string[]).includes(status);
}

function wallParts(time: string | null): { hour: number; minute: number } | null {
  if (time === null) return null;
  const match = WALL_TIME.exec(time);
  if (match === null) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

/** The local day a value falls on: a date column as it stands, an instant in the zone. */
function dateKeyOf(value: string, timeZone: string): DateKey | null {
  if (DATE_ONLY.test(value)) return value;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? zonedDateKey(ms, timeZone) : null;
}

function localIso(date: DateKey, hour: number, minute: number, timeZone: string): Instant {
  const ms = zonedWallTimeToUtcMs(date, hour, minute, timeZone);
  return zonedIso(ms, timeZone);
}

/**
 * Behaviour 8. Open tasks become candidates: the lane is the one whose
 * `groupIds` holds the task's group, the kind follows the lane, and a date is a
 * real deadline only in a lane whose `hardDates` says so (a dated chore in a
 * soft lane must not reserve a deadline session).
 */
export function tasksToCandidates(
  rows: EngineTaskRow[],
  user: EngineUser,
  touchedTaskIds: Set<string>,
): Candidate[] {
  const zone = user.timeZone;
  const out: Candidate[] = [];
  for (const row of rows) {
    if (!isOpen(row.status)) continue;
    const lane =
      row.group_id === null
        ? null
        : (user.rules.lanes.find((candidate) => candidate.groupIds.includes(row.group_id as string)) ??
          null);
    const time = wallParts(row.due_time) ?? END_OF_DAY;
    const due = row.due_date === null ? null : localIso(row.due_date, time.hour, time.minute, zone);
    out.push({
      id: row.id,
      title: row.title ?? UNTITLED,
      lane: lane?.key ?? null,
      kind: lane === null ? "side" : "step",
      due,
      hard: due !== null && lane !== null && lane.hardDates,
      minutes: row.estimated_minutes,
      // Nothing stores an energy cost for a task yet, and the planner reads
      // null as "not known" rather than as cheap.
      energyCost: null,
      expiresAt: null,
      pinned: false,
      earlyTouchDone: touchedTaskIds.has(row.id),
    });
  }
  return out;
}

/**
 * Behaviour 9. Calendar events and time-blocked tasks become the things the
 * planner must plan around. An all-day event keeps `allDay: true` and spans the
 * local day; a task is fixed only when it has both a due time and a duration.
 *
 * `timeZone` is an argument because two of those conversions need one: an
 * all-day event's bounds, and a task's start from a date and a wall time.
 */
export function toFixedEvents(
  events: EngineCalendarEvent[],
  timedTasks: EngineTaskRow[],
  capCalendarIds: Set<string>,
  timeZone: string,
): FixedEvent[] {
  const out: FixedEvent[] = [];

  for (const event of events) {
    const countsTowardCap = capCalendarIds.has(event.calendarId);
    if (event.allDay) {
      const from = dateKeyOf(event.start, timeZone);
      if (from === null) continue;
      const to = dateKeyOf(event.end, timeZone) ?? shiftDateKey(from, 1);
      out.push({
        id: event.id,
        title: event.summary,
        start: localIso(from, 0, 0, timeZone),
        end: localIso(to, 0, 0, timeZone),
        allDay: true,
        calendarId: event.calendarId,
        location: event.location ?? null,
        countsTowardCap,
        source: "google",
      });
      continue;
    }
    // A timed event already carries its own offset, so it is kept as Google
    // gave it; an unreadable pair is dropped rather than guessed at.
    if (!Number.isFinite(Date.parse(event.start)) || !Number.isFinite(Date.parse(event.end))) {
      continue;
    }
    out.push({
      id: event.id,
      title: event.summary,
      start: event.start,
      end: event.end,
      allDay: false,
      calendarId: event.calendarId,
      location: event.location ?? null,
      countsTowardCap,
      source: "google",
    });
  }

  for (const task of timedTasks) {
    if (!isOpen(task.status)) continue;
    const time = wallParts(task.due_time);
    const minutes = task.duration_min;
    if (task.due_date === null || time === null || minutes === null || minutes <= 0) continue;
    const startMs = zonedWallTimeToUtcMs(task.due_date, time.hour, time.minute, timeZone);
    out.push({
      id: `task:${task.id}`,
      title: task.title ?? UNTITLED,
      start: zonedIso(startMs, timeZone),
      end: zonedIso(startMs + minutes * 60_000, timeZone),
      allDay: false,
      calendarId: null,
      location: null,
      countsTowardCap: false,
      source: "task",
    });
  }

  return out;
}

// ------------------------------------------------------------ the real reads

/** A short stable class. Google's own code when there is one, never its prose. */
function calendarErrorClass(error: unknown): string {
  if (error instanceof GoogleCalendarConnectionError) {
    return error.code === "unknown" ? "calendar-auth" : error.code;
  }
  return "calendar-failed";
}

async function capCalendarIdsFor(client: SupabaseClient, userId: string): Promise<Set<string>> {
  const { data } = await client
    .from("income_sources")
    .select("google_calendar_id")
    .eq("user_id", userId);
  const rows = (data ?? []) as Array<{ google_calendar_id: string | null }>;
  return new Set(
    rows
      .map((row) => row.google_calendar_id)
      .filter((id): id is string => typeof id === "string" && id.length > 0),
  );
}

async function openTaskRows(client: SupabaseClient, userId: string): Promise<EngineTaskRow[]> {
  const { data, error } = await client
    .from("tasks")
    .select(TASK_COLUMNS)
    .eq("user_id", userId)
    .in("status", [...OPEN_TASK_STATUSES]);
  // The provider's message can carry a row value, so it is not repeated here.
  if (error) throw new Error("the task list could not be read");
  return (data ?? []) as EngineTaskRow[];
}

/**
 * The day's fixed events, and the calendar's own feed run. A calendar failure is
 * reported, never thrown: the plan is better off running without the calendar
 * than not running at all (behaviour 4).
 */
export function createLoadFixed(client: SupabaseClient): TickDeps["loadFixed"] {
  return async (userId, date, user) => {
    const startedAt = new Date().toISOString();
    const zone = user.timeZone;
    const timeMin = new Date(zonedWallTimeToUtcMs(date, 0, 0, zone)).toISOString();
    const timeMax = new Date(
      zonedWallTimeToUtcMs(shiftDateKey(date, 1), 0, 0, zone),
    ).toISOString();

    const [capCalendarIds, tasks] = await Promise.all([
      capCalendarIdsFor(client, userId),
      openTaskRows(client, userId),
    ]);

    let events: EngineCalendarEvent[] = [];
    let errorClass: string | null = null;
    try {
      events = await listEvents(userId, { timeMin, timeMax });
    } catch (error) {
      errorClass = calendarErrorClass(error);
      console.warn(`v2 calendar read failed for ${userId} (${errorClass})`);
    }

    const calendar: FeedRun = {
      feed: CALENDAR_FEED,
      startedAt,
      finishedAt: new Date().toISOString(),
      status: errorClass === null ? "ok" : "error",
      count: events.length,
      errorClass,
    };
    return {
      fixed: toFixedEvents(
        events,
        tasks.filter((task) => task.due_date === date),
        capCalendarIds,
        zone,
      ),
      calendar,
    };
  };
}

/**
 * Every open task as a candidate. `earlyTouchDone` comes from the engine's own
 * blocks: a task whose touch block was started or finished has been read, and
 * the planner then asks for a working block instead of another touch.
 */
export function createLoadCandidates(client: SupabaseClient): TickDeps["loadCandidates"] {
  return async (userId, user) => {
    const [tasks, touched] = await Promise.all([
      openTaskRows(client, userId),
      client
        .from("v2_blocks")
        .select("task_id")
        .eq("user_id", userId)
        .eq("kind", "touch")
        .in("state", ["started", "done"]),
    ]);
    const rows = (touched.data ?? []) as Array<{ task_id: string | null }>;
    const touchedTaskIds = new Set(
      rows.map((row) => row.task_id).filter((id): id is string => id !== null),
    );
    return tasksToCandidates(tasks, user, touchedTaskIds);
  };
}

export interface EngineRuntime {
  stores: Stores;
  deps: TickDeps;
}

/**
 * The engine as the routes get it: the Supabase stores on the service client,
 * the real Telegram adapter when a token is configured, and the probes.
 *
 * It is the one seam the three routes import, so a test can stand the whole
 * engine up on the memory stores by replacing this module.
 */
export function createEngine(): EngineRuntime {
  const client = createServiceClient();
  const stores = createSupabaseStores(client);
  const token = process.env.TELEGRAM_BOT_TOKEN;
  return {
    stores,
    deps: {
      stores,
      telegram: token ? createTelegramClient(token) : null,
      loadFixed: createLoadFixed(client),
      loadCandidates: createLoadCandidates(client),
      newId: () => randomUUID(),
      probes: createProbes(client),
    },
  };
}
