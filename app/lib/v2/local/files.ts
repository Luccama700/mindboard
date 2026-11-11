// Reading one local snapshot folder: six fixed file names, one error type, and
// a zod door per file. Nothing here composes a day (that is ./snapshot.ts) and
// nothing here touches the network or the database.
//
// THREE RULES THIS FILE EXISTS TO HOLD.
//
// 1. It only ever reads, and only inside the folder it was given. There is one
//    read in the whole file and every path it builds is the folder plus one of
//    the literal names in SNAPSHOT_FILES, so nothing a visitor sends can ever
//    become part of a path.
// 2. An export is wider and looser than the engine's contracts. A row carries
//    columns the engine has no use for, a title can be null, a status can be
//    one the engine does not know, and a column can be absent altogether. So
//    every row file is read as a list of plain objects first, scoped to the
//    account the snapshot names, and only then checked against the columns the
//    engine actually reads. An unknown column is dropped, never refused, and
//    another account's malformed row cannot fail this account's file.
// 3. No message ever carries a value out of the file. A malformed file is named
//    by its name and the path of the first issue, which is a column (and for a
//    list, its index), never its contents: the panel this ends up on is the one
//    place a snapshot's own data could leak into a page that is not behind a
//    sign in. JSON.parse is caught for the same reason, because its own
//    SyntaxError quotes the text around the problem.

import { readFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { safeTimeZone } from "@/app/_components/date-utils";
import { zonedDateKey } from "@/app/lib/snapshots/zoned-time";
import type { EngineCalendarEvent, EngineTaskRow } from "@/app/lib/v2/engine/sources";
import { parseRules } from "@/app/lib/v2/rules";
import { RowShapeError, parseRulesDocument } from "@/app/lib/v2/store/mappers";
import type { RulesDocument } from "@/app/lib/v2/store/types";
import type { DateKey, Instant, PlannerRules } from "@/app/lib/v2/types";

/** The folder's contents. Fixed names: nothing is ever derived from a request. */
export const SNAPSHOT_FILES = {
  snapshot: "snapshot.json",
  rules: "rules.json",
  tasks: "tasks.json",
  groups: "groups.json",
  income: "income_sources.json",
  /** Optional: without it the day is planned from the tasks alone. */
  calendar: "calendar-events.json",
  /**
   * Optional: without it the calendars are named after the groups they are
   * linked to, and plainly where none is.
   */
  calendars: "calendars.json",
} as const;

/**
 * The one error this module throws. `file` is the name inside the folder, and
 * the message says which file and what is wrong in plain words. Never a row
 * value, never a path on disk.
 */
export class LocalSnapshotError extends Error {
  constructor(
    readonly file: string,
    detail: string,
  ) {
    super(`${file} ${detail}`);
    this.name = "LocalSnapshotError";
  }
}

const MISSING = "is missing from the snapshot folder.";
const UNREADABLE = "could not be read.";
const NOT_JSON = "is not valid JSON.";
const NOT_UTF8 = "is not UTF-8 text. Save it as UTF-8.";
const BAD_SHAPE = "does not have the shape this screen needs";

function shapeDetail(at: string): string {
  return at.length === 0 ? `${BAD_SHAPE}.` : `${BAD_SHAPE} (at ${at}).`;
}

function isAbsent(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * The file's text, or null when it is not there at all.
 *
 * The bytes are decoded here rather than by `readFile`, because what a Windows
 * shell writes is the whole problem. `>` and `Out-File` in Windows PowerShell
 * 5.1 produce UTF-16LE with a byte order mark, which decodes as UTF-8 into
 * replacement characters and reads as "is not valid JSON" however good the JSON
 * is; the encoding is named instead, so the answer is to save the file again
 * rather than to go looking for a comma. A UTF-8 mark, which the same shell's
 * `Set-Content -Encoding utf8` writes, is stripped: JSON.parse refuses it.
 */
async function readText(dir: string, file: string): Promise<string | null> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path.join(dir, file));
  } catch (error) {
    if (isAbsent(error)) return null;
    throw new LocalSnapshotError(file, UNREADABLE);
  }
  if (startsWith(bytes, UTF16_LE_MARK) || startsWith(bytes, UTF16_BE_MARK)) {
    throw new LocalSnapshotError(file, NOT_UTF8);
  }
  const body = startsWith(bytes, UTF8_MARK) ? bytes.subarray(UTF8_MARK.length) : bytes;
  return body.toString("utf8");
}

const UTF8_MARK = [0xef, 0xbb, 0xbf];
const UTF16_LE_MARK = [0xff, 0xfe];
const UTF16_BE_MARK = [0xfe, 0xff];

function startsWith(bytes: Buffer, mark: number[]): boolean {
  return bytes.length >= mark.length && mark.every((byte, index) => bytes[index] === byte);
}

// The parse error is swallowed rather than reported: its own message quotes the
// text around the problem, which is a value out of the file.
function parseJson(file: string, text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new LocalSnapshotError(file, NOT_JSON);
  }
}

function shaped<S extends z.ZodTypeAny>(file: string, schema: S, value: unknown): z.infer<S> {
  const result = schema.safeParse(value);
  if (result.success) return result.data as z.infer<S>;
  throw new LocalSnapshotError(file, shapeDetail(result.error.issues[0].path.join(".")));
}

async function readRequired<S extends z.ZodTypeAny>(
  dir: string,
  file: string,
  schema: S,
): Promise<z.infer<S>> {
  const text = await readText(dir, file);
  if (text === null) throw new LocalSnapshotError(file, MISSING);
  return shaped(file, schema, parseJson(file, text));
}

// ---------------------------------------------------------------- scalars

const text = z
  .string()
  .nullish()
  .transform((value) => value ?? null);
/**
 * A column of minutes.
 *
 * Positive and whole, because the two things that read one build a block out of
 * it: zero or less gives a block that ends at or before it starts, which the
 * planner would then try to place. Postgres cannot hold a fraction in these
 * columns and nothing sensible holds a negative one, so a file that says
 * otherwise was edited by hand and is malformed.
 */
const minutes = z
  .number()
  .int()
  .positive()
  .nullish()
  .transform((value) => value ?? null);
const flag = z
  .boolean()
  .nullish()
  .transform((value) => value ?? false);

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A date key that names a day that exists.
 *
 * The shape is not enough. "2026-13-45" matches it and every piece of date
 * arithmetic downstream would quietly carry it forward as 2027-02-14, so the
 * day has to survive the round trip. Exported because the `date` parameter is
 * judged by the same rule.
 */
export function isRealDateKey(value: string): boolean {
  if (!DATE_ONLY.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  return zonedDateKey(Date.UTC(year, month - 1, day), "UTC") === value;
}

/**
 * A `date` column, as a date key.
 *
 * Checked rather than taken as given because a due date reaches the zone
 * helpers unguarded, and `Intl` throws on an unreadable one: a crash instead of
 * the panel this file exists to produce.
 */
const dayColumn = z
  .string()
  .refine(isRealDateKey)
  .nullish()
  .transform((value) => value ?? null);

/** One row, before anything is known about which account it belongs to. */
const rowList = z.array(z.record(z.unknown()));

// ---------------------------------------------------------------- snapshot.json

export interface SnapshotMeta {
  userId: string;
  /** The zone the day is planned in. It wins over the rules document's. */
  timeZone: string;
  takenAt: Instant;
  capCalendarIds: string[];
  /**
   * The days the calendar file can speak for, inclusive, or null when the
   * folder does not say.
   *
   * It is not the same question as which days have an event on them: an export
   * covering a fortnight with nothing on the Sunday says the Sunday is free,
   * and without this it would have to say it knows nothing about it. A folder
   * written before this field existed still loads, and then the range is taken
   * from the events themselves.
   */
  calendarRange: { from: DateKey; to: DateKey } | null;
}

/** A day that exists, as a required column. */
const dayKey = z.string().refine(isRealDateKey);

const snapshotSchema = z.object({
  userId: z.string().min(1),
  timeZone: z.string().refine((value) => safeTimeZone(value) !== null),
  takenAt: z.string().refine((value) => Number.isFinite(Date.parse(value))),
  capCalendarIds: z
    .array(z.string())
    .nullish()
    .transform((ids) => (ids ?? []).filter((id) => id.length > 0)),
  calendarRange: z
    .object({ from: dayKey, to: dayKey })
    .nullish()
    .transform((range) => range ?? null),
});

export async function readSnapshotMeta(dir: string): Promise<SnapshotMeta> {
  return readRequired(dir, SNAPSHOT_FILES.snapshot, snapshotSchema);
}

// ---------------------------------------------------------------- rules.json

/**
 * The rules document and its planner half, in the one spelling where the
 * snapshot's zone and the planner's cannot disagree (store/types.ts).
 *
 * Both halves can refuse: the envelope throws a RowShapeError naming a column,
 * the planner half a ZodError naming a field. Either way this file is what is
 * wrong, so both are reported as rules.json.
 */
export async function readRules(
  dir: string,
  timeZone: string,
): Promise<{ document: RulesDocument; planner: PlannerRules }> {
  const file = SNAPSHOT_FILES.rules;
  const body = await readText(dir, file);
  if (body === null) throw new LocalSnapshotError(file, MISSING);
  const raw = parseJson(file, body);

  let document: RulesDocument;
  try {
    document = parseRulesDocument(raw);
  } catch (error) {
    throw new LocalSnapshotError(
      file,
      shapeDetail(error instanceof RowShapeError ? error.column : ""),
    );
  }

  try {
    return { document, planner: parseRules({ ...document.planner, timeZone }) };
  } catch (error) {
    const at = error instanceof z.ZodError ? error.issues[0].path.join(".") : "";
    throw new LocalSnapshotError(file, shapeDetail(at.length === 0 ? "planner" : `planner.${at}`));
  }
}

// ---------------------------------------------------------------- row files

/** This account's rows, by the one column that says whose they are. */
async function readRowsFor(
  dir: string,
  file: string,
  userId: string,
): Promise<Array<Record<string, unknown>>> {
  const rows = await readRequired(dir, file, rowList);
  return rows.filter((row) => row.user_id === userId);
}

/**
 * A whole JSON file of the folder checked against a schema, or null when the
 * folder has no such file. For the parts of a snapshot a folder may leave out.
 *
 * A file that is there and cannot be read, is not JSON or does not match is the
 * same `LocalSnapshotError` every other file reports: a literal file name and a
 * fixed phrase, with the path of the field for a bad shape, never a value.
 */
export async function readOptionalFile<S extends z.ZodTypeAny>(
  dir: string,
  file: string,
  schema: S,
): Promise<z.infer<S> | null> {
  const body = await readText(dir, file);
  if (body === null) return null;
  return shaped(file, schema, parseJson(file, body));
}

/**
 * This account's rows of a file of rows, each checked against a schema, or null
 * when the folder has no such file. The rows of other accounts are dropped
 * before the schema sees them, so a row that is not this account's cannot fail
 * the read.
 */
export async function readOptionalRows<S extends z.ZodTypeAny>(
  dir: string,
  file: string,
  userId: string,
  schema: S,
): Promise<Array<z.infer<S>> | null> {
  const body = await readText(dir, file);
  if (body === null) return null;
  const rows = shaped(file, rowList, parseJson(file, body));
  return shaped(
    file,
    z.array(schema),
    rows.filter((row) => row.user_id === userId),
  );
}

const taskRowSchema = z.object({
  id: z.string().min(1),
  title: text,
  group_id: text,
  due_date: dayColumn,
  due_time: text,
  status: z
    .string()
    .nullish()
    .transform((value) =>
      value === null || value === undefined || value.trim().length === 0
        ? UNTITLED_EVENT
        : value,
    ),
  estimated_minutes: minutes,
  duration_min: minutes,
  gcal_event_id: text,
  gcal_calendar_id: text,
});

export async function readTaskRows(dir: string, userId: string): Promise<EngineTaskRow[]> {
  const file = SNAPSHOT_FILES.tasks;
  return shaped(file, z.array(taskRowSchema), await readRowsFor(dir, file, userId));
}

/** A group, as the screen's tags and the calendar's names need it. */
export interface LocalGroup {
  id: string;
  name: string | null;
  color: string | null;
  archived: boolean;
  /**
   * The Google calendar this group is linked to (`groups.google_calendar_id`,
   * migration 0003), or null. It is how a calendar in the export gets the name
   * and the colour the user chose, when the folder carries no calendar list.
   */
  google_calendar_id: string | null;
}

const groupRowSchema = z.object({
  id: z.string().min(1),
  name: text,
  color: text,
  archived: flag,
  google_calendar_id: text,
});

export async function readGroupRows(dir: string, userId: string): Promise<LocalGroup[]> {
  const file = SNAPSHOT_FILES.groups;
  return shaped(file, z.array(groupRowSchema), await readRowsFor(dir, file, userId));
}

const incomeRowSchema = z.object({ calendar_id: text });

/** The calendars this account's income sources are linked to. */
export async function readIncomeCalendarIds(dir: string, userId: string): Promise<string[]> {
  const file = SNAPSHOT_FILES.income;
  const rows = shaped(file, z.array(incomeRowSchema), await readRowsFor(dir, file, userId));
  return rows
    .map((row) => row.calendar_id)
    .filter((id): id is string => id !== null && id.length > 0);
}

// ------------------------------------------------------- calendar-events.json

/**
 * What an event with no name is called.
 *
 * The same words the live reader uses (`utils/google/calendar.ts`, where a
 * missing `summary` becomes "untitled event"), copied by value rather than
 * imported: that module is server only and pulls the Google client and the
 * token store in with it, and this loader reaches neither.
 */
const UNTITLED_EVENT = "untitled event";

const eventSchema = z.object({
  id: z.string().min(1),
  summary: z
    .string()
    .nullish()
    // A blank one counts as missing: an empty heading says less than a word.
    .transform((value) =>
      value === null || value === undefined || value.trim().length === 0
        ? UNTITLED_EVENT
        : value,
    ),
  start: z.string(),
  end: z.string(),
  allDay: flag,
  calendarId: z
    .string()
    .nullish()
    .transform((value) =>
      value === null || value === undefined || value.trim().length === 0
        ? UNTITLED_EVENT
        : value,
    ),
  location: text,
  // Absent means no: an export written before the calendar window existed says
  // nothing about series, and an occurrence wrongly marked as one would wear a
  // repeating mark it has not earned.
  recurring: flag,
});

/** An event of a snapshot: the engine's shape, plus what the window needs. */
export interface LocalCalendarEvent extends EngineCalendarEvent {
  /** One occurrence of a repeating series. */
  recurring: boolean;
}

/**
 * The week's events, or null when the file is not there. Null is not an empty
 * calendar: the notice says the calendar is not included, so a day with nothing
 * on it cannot be mistaken for a day that is free.
 *
 * THIS FILE CARRIES NO ACCOUNT. Every other row file has a `user_id` and is
 * scoped to the snapshot's owner here, at the door. A calendar event has no
 * such column (the shape is the engine's `EngineCalendarEvent`), so this reader
 * cannot filter one out and does not pretend to: whoever writes the folder must
 * put only the owner's own calendars in it. An event from somebody else's
 * calendar would be shown on the day like any other.
 */
export async function readCalendarEvents(
  dir: string,
): Promise<LocalCalendarEvent[] | null> {
  const file = SNAPSHOT_FILES.calendar;
  const body = await readText(dir, file);
  if (body === null) return null;
  return shaped(file, z.array(eventSchema), parseJson(file, body));
}

// ------------------------------------------------------------ calendars.json

/** What a calendar with no name of its own is called. */
const UNNAMED_CALENDAR = "Calendar";

const HEX_COLOUR = /^#[0-9A-Fa-f]{6}$/;

/** One calendar of the export, as the folder lists it. */
export interface LocalCalendar {
  id: string;
  label: string;
  color: string | null;
  writable: boolean;
}

const calendarSchema = z.object({
  id: z.string().min(1),
  // A calendar with no name is still a calendar, so it is named plainly rather
  // than refused: losing the whole list would leave every event on the week
  // unnamed, which is a worse answer than one plain row.
  label: z
    .string()
    .nullish()
    .transform((value) =>
      value === null || value === undefined || value.trim().length === 0
        ? UNNAMED_CALENDAR
        : value,
    ),
  // A colour reaches the screen as a colour, so it has to be one: anything else
  // was edited by hand and the file is malformed. The value is never repeated.
  color: z
    .string()
    .refine((value) => HEX_COLOUR.test(value))
    .nullish()
    .transform((value) => value ?? null),
  writable: flag,
});

/**
 * The calendars the folder lists, or null when it does not list any.
 *
 * Null is not an empty list: without this file the calendars are named after the
 * groups they are linked to and plainly where none is, which is the best a
 * folder written before this file existed can do.
 *
 * LIKE THE EVENTS, THIS CARRIES NO ACCOUNT. Every row file with a `user_id` is
 * scoped to the snapshot's owner at the door; a calendar entry has no such
 * column, so whoever builds the folder must put only the owner's own calendars
 * in it.
 */
export async function readCalendars(dir: string): Promise<LocalCalendar[] | null> {
  const file = SNAPSHOT_FILES.calendars;
  const body = await readText(dir, file);
  if (body === null) return null;
  return shaped(file, z.array(calendarSchema), parseJson(file, body));
}
