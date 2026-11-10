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
import type { EngineCalendarEvent, EngineTaskRow } from "@/app/lib/v2/engine/sources";
import { parseRules } from "@/app/lib/v2/rules";
import { RowShapeError, parseRulesDocument } from "@/app/lib/v2/store/mappers";
import type { RulesDocument } from "@/app/lib/v2/store/types";
import type { Instant, PlannerRules } from "@/app/lib/v2/types";

/** The folder's contents. Fixed names: nothing is ever derived from a request. */
export const SNAPSHOT_FILES = {
  snapshot: "snapshot.json",
  rules: "rules.json",
  tasks: "tasks.json",
  groups: "groups.json",
  income: "income_sources.json",
  /** Optional: without it the day is planned from the tasks alone. */
  calendar: "calendar-events.json",
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

/** The byte order mark, U+FEFF, written out so no source file carries one. */
const BYTE_ORDER_MARK = String.fromCodePoint(0xfeff);

const MISSING = "is missing from the snapshot folder.";
const UNREADABLE = "could not be read.";
const NOT_JSON = "is not valid JSON.";
const BAD_SHAPE = "does not have the shape this screen needs";

function shapeDetail(at: string): string {
  return at.length === 0 ? `${BAD_SHAPE}.` : `${BAD_SHAPE} (at ${at}).`;
}

function isAbsent(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** The file's text, or null when it is not there at all. */
async function readText(dir: string, file: string): Promise<string | null> {
  try {
    return await readFile(path.join(dir, file), "utf8");
  } catch (error) {
    if (isAbsent(error)) return null;
    throw new LocalSnapshotError(file, UNREADABLE);
  }
}

// A leading byte order mark is what a file saved from PowerShell on Windows
// normally starts with, and JSON.parse refuses it. Stripping it here is the
// difference between "is not valid JSON" and a folder that just works.
function parseJson(file: string, text: string): unknown {
  try {
    const body = text.startsWith(BYTE_ORDER_MARK) ? text.slice(1) : text;
    return JSON.parse(body) as unknown;
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
const count = z
  .number()
  .nullish()
  .transform((value) => value ?? null);
const flag = z
  .boolean()
  .nullish()
  .transform((value) => value ?? false);

/**
 * A `date` column, as a date key.
 *
 * Checked rather than taken as given because a due date reaches the zone
 * helpers unguarded, and `Intl` throws on an unreadable one: a crash instead of
 * the panel this file exists to produce.
 */
const dayColumn = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
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
}

const snapshotSchema = z.object({
  userId: z.string().min(1),
  timeZone: z.string().refine((value) => safeTimeZone(value) !== null),
  takenAt: z.string().refine((value) => Number.isFinite(Date.parse(value))),
  capCalendarIds: z
    .array(z.string())
    .nullish()
    .transform((ids) => (ids ?? []).filter((id) => id.length > 0)),
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

const taskRowSchema = z.object({
  id: z.string().min(1),
  title: text,
  group_id: text,
  due_date: dayColumn,
  due_time: text,
  status: z
    .string()
    .nullish()
    .transform((value) => value ?? ""),
  estimated_minutes: count,
  duration_min: count,
  gcal_event_id: text,
  gcal_calendar_id: text,
});

export async function readTaskRows(dir: string, userId: string): Promise<EngineTaskRow[]> {
  const file = SNAPSHOT_FILES.tasks;
  return shaped(file, z.array(taskRowSchema), await readRowsFor(dir, file, userId));
}

/** A group, as the screen's tags need it. */
export interface LocalGroup {
  id: string;
  name: string | null;
  color: string | null;
  archived: boolean;
}

const groupRowSchema = z.object({
  id: z.string().min(1),
  name: text,
  color: text,
  archived: flag,
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

const eventSchema = z.object({
  id: z.string().min(1),
  summary: z
    .string()
    .nullish()
    .transform((value) => value ?? ""),
  start: z.string(),
  end: z.string(),
  allDay: flag,
  calendarId: z
    .string()
    .nullish()
    .transform((value) => value ?? ""),
  location: text,
});

/**
 * The week's events, or null when the file is not there. Null is not an empty
 * calendar: the notice says the calendar is not included, so a day with nothing
 * on it cannot be mistaken for a day that is free.
 */
export async function readCalendarEvents(dir: string): Promise<EngineCalendarEvent[] | null> {
  const file = SNAPSHOT_FILES.calendar;
  const body = await readText(dir, file);
  if (body === null) return null;
  return shaped(file, z.array(eventSchema), parseJson(file, body));
}
