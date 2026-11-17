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
import { CALENDAR_FEED, TASK_FIXED_PREFIX, type TickDeps } from "@/app/lib/v2/engine/tick";
import { createProbes } from "@/app/lib/v2/engine/probes";
import { laneOfGroup, titleOf } from "@/app/lib/v2/engine/task-rules";
import { dayBounds, shiftDateKey } from "@/app/lib/v2/plan/day";
import { parseRules } from "@/app/lib/v2/rules";
import { createSupabaseStores } from "@/app/lib/v2/store/supabase";
import type { EngineUser, Stores } from "@/app/lib/v2/store/types";
import type {
  Candidate,
  DateKey,
  FeedRun,
  FixedEvent,
  Instant,
  PlannerRules,
} from "@/app/lib/v2/types";
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
  /** Set when this task was pushed to Google, which then holds the same block. */
  gcal_event_id?: string | null;
  gcal_calendar_id?: string | null;
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

// One literal, not a concatenation: the Supabase client parses this string as a
// type, and a built-up string makes every row `GenericStringError`.
const TASK_COLUMNS =
  "id, title, group_id, due_date, due_time, status, estimated_minutes, duration_min, gcal_event_id, gcal_calendar_id";

// NOT `google_calendar_id`, which is what `groups` calls its link (0003) and
// what this file asked for until the schema contract test was written. On
// `income_sources` the column is `calendar_id` (0007_finance_recurring.sql).
/** The calendars an income source is linked to (0007_finance_recurring.sql). */
const INCOME_SOURCE_COLUMNS = "calendar_id";
/** The engine's own touch blocks: which tasks have already been opened once. */
const TOUCH_BLOCK_COLUMNS = "task_id";
/** The engine's own income blocks, for the week's capped hours. */
const INCOME_BLOCK_COLUMNS = "starts_at, ends_at";

/** One query's table and the columns it names, as the query itself passes them. */
export interface QueryShape {
  readonly table: string;
  /** The select list, exactly as the query passes it. */
  readonly select: string;
  /** Columns used as a filter or an order that the select list does not name. */
  readonly where: readonly string[];
}

/**
 * Every table and column this file sends to Postgres, in one place.
 *
 * `__tests__/v2-schema-contract.test.ts` applies every migration to an
 * in-memory Postgres, drives these adapters with a recording client, and
 * asserts that what they actually send exists on the table AND is exactly what
 * is declared here. Nothing else could have caught the first spelling of the
 * income calendars column, because no test ran these queries against a schema.
 *
 * The table name and the `user_id` filter stay string literals in the query:
 * `__tests__/tenant-scope-invariant.test.ts` reads this source for
 * `.from("<table>")` and the `.eq("user_id", ...)` that scopes it, and a chain
 * written behind a constant would be invisible to it.
 */
export const SOURCE_QUERIES = [
  { table: "income_sources", select: INCOME_SOURCE_COLUMNS, where: ["user_id"] },
  // `tasks` is read twice, for the day's time-blocked tasks and for the
  // candidates, with the same columns both times.
  { table: "tasks", select: TASK_COLUMNS, where: ["user_id", "status"] },
  {
    table: "v2_blocks",
    select: TOUCH_BLOCK_COLUMNS,
    where: ["user_id", "kind", "state", "date"],
  },
  {
    table: "v2_blocks",
    select: INCOME_BLOCK_COLUMNS,
    where: ["user_id", "kind", "state", "date"],
  },
] as const satisfies readonly QueryShape[];

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
 * This account's planner rules, in the one spelling where the store's zone and
 * the planner's cannot disagree (store/types.ts). The reads here need the whole
 * rules row rather than just the zone, because a planning day runs to lights
 * out and that is where lights out lives.
 *
 * It cannot throw in production: `createEngineContext` parses the same input
 * before anything that calls these adapters exists.
 */
function rulesOf(user: EngineUser): PlannerRules {
  return parseRules({ ...user.rules.planner, timeZone: user.timeZone });
}

/** An error's class, never its message: a PostgREST message can carry a row value. */
function nameOf(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/**
 * Does this task's own slot fall on the planning day?
 *
 * Its start instant when it has a time, so a task timed for 00:30 belongs to the
 * day whose lights out is 01:30 and not to the one that starts the next
 * morning; `due_date === date` would put it on neither, because the plan that
 * could place something over it runs on the earlier day. A task with no time
 * has only its date to go on, and cannot become a fixed event anyway.
 */
function taskOnDay(
  task: EngineTaskRow,
  date: DateKey,
  bounds: { startMs: number; endMs: number },
  timeZone: string,
): boolean {
  if (task.due_date === null) return false;
  const time = wallParts(task.due_time);
  if (time === null) return task.due_date === date;
  const startMs = zonedWallTimeToUtcMs(task.due_date, time.hour, time.minute, timeZone);
  return startMs >= bounds.startMs && startMs < bounds.endMs;
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
    const lane = laneOfGroup(row.group_id, user.rules.lanes);
    const time = wallParts(row.due_time) ?? END_OF_DAY;
    const due = row.due_date === null ? null : localIso(row.due_date, time.hour, time.minute, zone);
    out.push({
      id: row.id,
      title: titleOf(row.title),
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

  // A task that was pushed to Google is the SAME thing as the event it created.
  // It goes on the day once, with the event's time (Google is where it was last
  // moved) and the TASK's id, so whatever reads these knows which task it is and
  // does not plan a second block for work that already has a slot. Keyed the way
  // the task row points at it.
  const taskByEvent = new Map<string, EngineTaskRow>();
  for (const task of timedTasks) {
    if (!isOpen(task.status)) continue;
    if (task.gcal_event_id == null || task.gcal_calendar_id == null) continue;
    taskByEvent.set(`${task.gcal_calendar_id}:${task.gcal_event_id}`, task);
  }
  // The tasks whose Google copy actually made it onto the day. Marked AFTER the
  // push, never before: an event with an unreadable start or end is dropped, and
  // marking the task first meant it was skipped by the loop below as well, so a
  // task that had been pushed to Google lost its block entirely because Google
  // answered with a date nobody could read.
  const merged = new Set<string>();

  for (const event of events) {
    const countsTowardCap = capCalendarIds.has(event.calendarId);
    const task = taskByEvent.get(event.id);
    const id = task === undefined ? event.id : `${TASK_FIXED_PREFIX}${task.id}`;
    if (event.allDay) {
      const from = dateKeyOf(event.start, timeZone);
      if (from === null) continue;
      const to = dateKeyOf(event.end, timeZone) ?? shiftDateKey(from, 1);
      out.push({
        id,
        title: event.summary,
        start: localIso(from, 0, 0, timeZone),
        end: localIso(to, 0, 0, timeZone),
        allDay: true,
        calendarId: event.calendarId,
        location: event.location ?? null,
        countsTowardCap,
        source: "google",
      });
      if (task !== undefined) merged.add(task.id);
      continue;
    }
    // A timed event already carries its own offset, so it is kept as Google
    // gave it; an unreadable pair is dropped rather than guessed at.
    if (!Number.isFinite(Date.parse(event.start)) || !Number.isFinite(Date.parse(event.end))) {
      continue;
    }
    out.push({
      id,
      title: event.summary,
      start: event.start,
      end: event.end,
      allDay: false,
      calendarId: event.calendarId,
      location: event.location ?? null,
      countsTowardCap,
      source: "google",
    });
    if (task !== undefined) merged.add(task.id);
  }

  // The timed tasks whose Google copy was NOT among the events: either they
  // were never pushed, or the event is gone, or the calendar read failed. Their
  // own time is then all there is, so they go on the day themselves.
  for (const task of timedTasks) {
    if (!isOpen(task.status)) continue;
    if (merged.has(task.id)) continue;
    const time = wallParts(task.due_time);
    const minutes = task.duration_min;
    if (task.due_date === null || time === null || minutes === null || minutes <= 0) continue;
    const startMs = zonedWallTimeToUtcMs(task.due_date, time.hour, time.minute, timeZone);
    out.push({
      id: `${TASK_FIXED_PREFIX}${task.id}`,
      title: titleOf(task.title),
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

/**
 * How long the calendar gets to answer. The cron route runs the accounts one
 * after another inside a sixty second function, so one request that never comes
 * back would spend the whole budget and starve every account behind it.
 * `listEvents` has no timeout of its own.
 */
export const CALENDAR_TIMEOUT_MS = 10_000;

class CalendarTimeoutError extends Error {
  constructor() {
    super("the calendar did not answer in time");
    this.name = "CalendarTimeoutError";
  }
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new CalendarTimeoutError()), ms);
  });
  // Promise.race attaches a handler to `work`, so a request that rejects after
  // the limit has won is already handled and raises nothing.
  return Promise.race([work, limit]).finally(() => clearTimeout(timer));
}

/** A short stable class. Google's own code when there is one, never its prose. */
function calendarErrorClass(error: unknown): string {
  if (error instanceof CalendarTimeoutError) return "calendar-timeout";
  if (error instanceof GoogleCalendarConnectionError) {
    return error.code === "unknown" ? "calendar-auth" : error.code;
  }
  return "calendar-failed";
}

/**
 * The calendars an income source is linked to: the events that count toward the
 * weekly cap. The error is NOT swallowed. A silent empty set would make today's
 * shifts uncapped, which is the quiet failure the cap exists to prevent.
 *
 * `createLoadFixed` catches it rather than letting it through (the day still
 * has to be planned) and says so with `capUnknown`, which reaches the planner as
 * a full week. `createLoadWeekCapHours` catches it as `ok: false`, which is the
 * same answer. Neither ever reports an empty set as a known one.
 */
async function capCalendarIdsFor(client: SupabaseClient, userId: string): Promise<Set<string>> {
  const { data, error } = await client
    .from("income_sources")
    .select(INCOME_SOURCE_COLUMNS)
    .eq("user_id", userId);
  if (error) throw new Error("the income calendars could not be read");
  const rows = (data ?? []) as Array<{ calendar_id: string | null }>;
  return new Set(
    rows
      .map((row) => row.calendar_id)
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
 *
 * The cap calendars are a SEPARATE read with its own failure handling, for the
 * same reason. It used to sit outside the try, so one unreadable
 * `income_sources` row took the whole plan step down with it; now it reports
 * `capUnknown` and the planner treats the week as full (the cap fails closed).
 */
export function createLoadFixed(client: SupabaseClient): TickDeps["loadFixed"] {
  return async (userId, date, user) => {
    const startedAt = new Date().toISOString();
    const zone = user.timeZone;
    const bounds = dayBounds(date, rulesOf(user));
    const timeMin = new Date(bounds.startMs).toISOString();
    const timeMax = new Date(bounds.endMs).toISOString();

    const [caps, tasks] = await Promise.all([
      capCalendarIdsFor(client, userId).then(
        (ids) => ({ ids, unknown: false }),
        (error: unknown) => {
          console.warn(`v2 income calendars could not be read for ${userId} (${nameOf(error)})`);
          return { ids: new Set<string>(), unknown: true };
        },
      ),
      openTaskRows(client, userId),
    ]);

    let events: EngineCalendarEvent[] = [];
    let errorClass: string | null = null;
    try {
      events = await withTimeout(listEvents(userId, { timeMin, timeMax }), CALENDAR_TIMEOUT_MS);
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
        tasks.filter((task) => taskOnDay(task, date, bounds, zone)),
        caps.ids,
        zone,
      ),
      calendar,
      capUnknown: caps.unknown,
    };
  };
}

/**
 * How far back a finished touch block still counts as "this has been read".
 * The query is bounded so it cannot grow with the account's whole history.
 */
const TOUCH_LOOKBACK_DAYS = 120;

/**
 * Every open task as a candidate. `earlyTouchDone` comes from the engine's own
 * blocks: a task whose touch block was started or finished has been read, and
 * the planner then asks for a working block instead of another touch.
 */
export function createLoadCandidates(client: SupabaseClient): TickDeps["loadCandidates"] {
  return async (userId, user, now) => {
    // The CALENDAR date, deliberately: this is a 120 day lower bound on a
    // `date` column, so whether `now` falls on the planning day or on the one
    // after it cannot change which touch blocks come back. Everything that
    // decides what happens to a day uses the planning date (see `planningDate`).
    const since = shiftDateKey(
      zonedDateKey(Date.parse(now), user.timeZone),
      -TOUCH_LOOKBACK_DAYS,
    );
    const [tasks, touched] = await Promise.all([
      openTaskRows(client, userId),
      client
        .from("v2_blocks")
        .select(TOUCH_BLOCK_COLUMNS)
        .eq("user_id", userId)
        .eq("kind", "touch")
        .in("state", ["started", "done"])
        .gte("date", since),
    ]);
    // Not ignored: an unreadable list would silently ask for a touch that has
    // already happened, every day.
    if (touched.error) throw new Error("the touch blocks could not be read");
    const rows = (touched.data ?? []) as Array<{ task_id: string | null }>;
    const touchedTaskIds = new Set(
      rows.map((row) => row.task_id).filter((id): id is string => id !== null),
    );
    return tasksToCandidates(tasks, user, touchedTaskIds);
  };
}

/**
 * The capped hours already on the OTHER six days of the week: one calendar read
 * over Monday to Sunday, keeping the events whose calendar an income source is
 * linked to, merged with the engine's own income blocks for those days so two
 * records of the same shift count once.
 *
 * `ok: false` says the figure is not known, and the tick then plans as if the
 * week were full. That is the point: a weekly cap models a hard limit, so the
 * one answer it must never give is a confident low number.
 */
export function createLoadWeekCapHours(
  client: SupabaseClient,
): TickDeps["loadWeekCapHours"] {
  return async (userId, weekStart, date, user) => {
    const zone = user.timeZone;
    const weekEnd = shiftDateKey(weekStart, 7);
    const timeMin = new Date(zonedWallTimeToUtcMs(weekStart, 0, 0, zone)).toISOString();
    const timeMax = new Date(zonedWallTimeToUtcMs(weekEnd, 0, 0, zone)).toISOString();

    try {
      const capCalendarIds = await capCalendarIdsFor(client, userId);
      // No calendar counts toward the cap, so there is nothing to read and
      // nothing that could fail: the engine's own income blocks ARE the answer.
      // Without this an account with a cap and no linked income calendar would
      // report `cap-unknown` on every tick for as long as Google was unreachable,
      // and never plan any income work again.
      const [events, blocks] = await Promise.all([
        capCalendarIds.size === 0
          ? Promise.resolve([] as EngineCalendarEvent[])
          : withTimeout(listEvents(userId, { timeMin, timeMax }), CALENDAR_TIMEOUT_MS),
        incomeBlockSpans(client, userId, weekStart, weekEnd),
      ]);

      const spans = [...blocks];
      for (const event of events) {
        if (event.allDay || !capCalendarIds.has(event.calendarId)) continue;
        const startMs = Date.parse(event.start);
        const endMs = Date.parse(event.end);
        if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) continue;
        spans.push({ startMs, endMs });
      }

      // The other six days only: today's own hours are the planner's to count
      // from the fixed events it was given. "Today" has to be the same interval
      // `loadFixed` read, or a shift lands in neither: before wake, or after
      // midnight on a day whose lights out is 01:30.
      const day = dayBounds(date, rulesOf(user));
      const elsewhere = spans.flatMap((span) => outside(span, day.startMs, day.endMs));
      return { hours: unionHours(elsewhere), ok: true };
    } catch (error) {
      const errorClass = calendarErrorClass(error);
      console.warn(`v2 week cap read failed for ${userId} (${errorClass})`);
      return { hours: 0, ok: false };
    }
  };
}

interface Span {
  startMs: number;
  endMs: number;
}

/** The parts of a span that fall outside one day. */
function outside(span: Span, dayStartMs: number, dayEndMs: number): Span[] {
  const parts: Span[] = [];
  if (span.startMs < dayStartMs) {
    parts.push({ startMs: span.startMs, endMs: Math.min(span.endMs, dayStartMs) });
  }
  if (span.endMs > dayEndMs) {
    parts.push({ startMs: Math.max(span.startMs, dayEndMs), endMs: span.endMs });
  }
  return parts.filter((part) => part.endMs > part.startMs);
}

/** Hours covered by the union of the spans: overlapping records count once. */
export function unionHours(spans: Span[]): number {
  const sorted = [...spans]
    .filter((span) => span.endMs > span.startMs)
    .sort((a, b) => a.startMs - b.startMs);
  let total = 0;
  let cursor = Number.NEGATIVE_INFINITY;
  for (const span of sorted) {
    const from = Math.max(span.startMs, cursor);
    if (span.endMs > from) {
      total += span.endMs - from;
      cursor = span.endMs;
    }
  }
  return total / 3_600_000;
}

async function incomeBlockSpans(
  client: SupabaseClient,
  userId: string,
  from: DateKey,
  to: DateKey,
): Promise<Span[]> {
  const { data, error } = await client
    .from("v2_blocks")
    .select(INCOME_BLOCK_COLUMNS)
    .eq("user_id", userId)
    .eq("kind", "income")
    .neq("state", "skipped")
    .gte("date", from)
    .lt("date", to);
  if (error) throw new Error("the week's income blocks could not be read");
  const rows = (data ?? []) as Array<{ starts_at: string; ends_at: string }>;
  return rows
    .map((row) => ({ startMs: Date.parse(row.starts_at), endMs: Date.parse(row.ends_at) }))
    .filter((span) => Number.isFinite(span.startMs) && Number.isFinite(span.endMs));
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
      loadWeekCapHours: createLoadWeekCapHours(client),
      newId: () => randomUUID(),
      probes: createProbes(client),
    },
  };
}
