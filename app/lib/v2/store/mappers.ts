// Row to domain and back. Pure: no client, no clock, no ids.
//
// This is the only file that knows a column name, which is why it is also the
// only place a stored row is validated. Both stores read through it - the
// Supabase one because PostgREST hands back whatever the table holds, and the
// memory one because engine tests have to see the same shapes production does.
// A row that does not fit comes back as a RowShapeError naming the table and
// the column, rather than as an undefined that surfaces three frames later.
//
// Instants are normalised on read. A timestamptz arrives from PostgREST as
// "+00:00", sometimes with microseconds, while a caller may have written one
// carrying any offset, so string comparison of two instants is always a bug.
// Normalising here is what makes `a === b` safe above this line.
//
// Local days are NOT normalised: a `date` column is a date key in the user's
// own zone, and widening one into an instant is how a day silently becomes the
// day before.

import { z } from "zod";

import { safeTimeZone } from "@/app/_components/date-utils";

import type {
  Alert,
  Ask,
  AskOption,
  Block,
  FeedRun,
  OutgoingMessage,
  PlanOutput,
} from "../types";
import type {
  ChannelLink,
  DayPatch,
  DayRecord,
  EngineUser,
  OutboxItem,
  RulesDocument,
  StoredExpectation,
} from "./types";

/** A stored row that does not fit its contract, named down to the column. */
export class RowShapeError extends Error {
  constructor(
    readonly table: string,
    readonly column: string,
    readonly detail: string,
  ) {
    super(`v2 store: ${table}.${column} ${detail}`);
    this.name = "RowShapeError";
  }
}

// Inferred from the schema's OUTPUT, so a field with a `.default()` is
// required on the way out even though it was optional on the way in.
function parse<S extends z.ZodTypeAny>(schema: S, table: string, row: unknown): z.infer<S> {
  const result = schema.safeParse(row);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const column = issue.path.length > 0 ? issue.path.join(".") : "<row>";
  throw new RowShapeError(table, column, issue.message);
}

// ---------------------------------------------------------------- scalars

const instant = z
  .string()
  .refine((value) => Number.isFinite(Date.parse(value)), { message: "is not an instant" })
  .transform((value) => new Date(Date.parse(value)).toISOString());

const nullableInstant = instant.nullable();

const dateKey = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { message: "is not a date key" });

// The columns that are `uuid` in 0066 are checked as uuids here, so the memory
// store refuses exactly what Postgres would refuse with a 22P02. Ids inside a
// jsonb payload are NOT checked this way: the database does not check them
// either, and a store that is stricter than the table it stands for is as
// misleading as one that is looser.
const uuid = z.string().uuid({ message: "is not a uuid" });

const wallTime = z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/, {
  message: "is not a wall time",
});

const energy = z.enum(["low", "ok", "good"]);
const planMode = z.enum(["normal", "short-night", "rough-day", "travel"]);
const blockKind = z.enum(["floor", "focus", "session", "touch", "income", "gym", "small"]);
const blockState = z.enum(["planned", "started", "done", "skipped"]);
const askStatus = z.enum(["open", "answered", "expired", "cancelled"]);
const outboxKind = z.enum(["morning", "ask", "alert", "note"]);
const outboxDelivery = z.enum(["interrupt", "digest"]);
const runStatus = z.enum(["ok", "error"]);
const alertStatus = z.enum(["open", "closed"]);

// ---------------------------------------------------------------- jsonb

const askEffect = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("block.done"),
    blockId: z.string().min(1),
    fraction: z.union([z.literal(1), z.literal(0.5)]),
  }),
  z.object({
    type: z.literal("block.reschedule"),
    blockId: z.string().min(1),
    to: z.enum(["later-today", "tomorrow"]),
  }),
  z.object({ type: z.literal("block.drop"), blockId: z.string().min(1) }),
  z.object({ type: z.literal("energy.set"), date: dateKey, energy }),
  z.object({ type: z.literal("none") }),
]);

// `id` is capped at 12 characters by the contract in types.ts, because it has
// to survive a round trip through a Telegram callback payload.
const askOption: z.ZodType<AskOption> = z.object({
  id: z.string().min(1).max(12),
  label: z.string().min(1),
  effect: askEffect,
});

const outgoingMessage: z.ZodType<OutgoingMessage> = z.object({
  text: z.string(),
  buttons: z.array(
    z.object({ label: z.string(), askId: z.string().min(1), optionId: z.string().min(1) }),
  ),
});

const droppedList: z.ZodType<PlanOutput["dropped"]> = z.array(
  z.object({ candidateId: z.string().min(1), reason: z.string() }),
);

const leaveByList = z.array(z.object({ fixedId: z.string().min(1), at: instant }));

// ---------------------------------------------------------------- v2_rules

export interface RulesRow {
  user_id: string;
  enabled: boolean;
  rules: RulesDocument;
}

const rulesDocumentSchema = z.object({
  // Opaque on purpose: parseRules (app/lib/v2/rules.ts) is the only thing that
  // interprets this, and an unknown key has to survive an older read.
  planner: z.record(z.unknown()).default({}),
  lanes: z
    .array(
      z.object({
        key: z.string().min(1),
        label: z.string(),
        color: z.string(),
        groupIds: z.array(z.string()),
        // Absent means false: a document written before the field existed says
        // nothing about deadlines, and the safe reading of silence is that a
        // date in that lane is an intention, not a deadline. A non-boolean is
        // still a malformed document.
        hardDates: z.boolean().default(false),
      }),
    )
    .default([]),
  feedLabels: z.record(z.string()).default({}),
});

/**
 * The one door a stored rules document comes through. The planner half is kept
 * exactly as stored; only the envelope around it is checked.
 */
export function parseRulesDocument(input: unknown): RulesDocument {
  const parsed = parse(rulesDocumentSchema, "v2_rules", input);
  return {
    planner: parsed.planner as RulesDocument["planner"],
    lanes: parsed.lanes,
    feedLabels: parsed.feedLabels,
  };
}

export function toRulesRow(userId: string, rules: RulesDocument, enabled: boolean): RulesRow {
  return { user_id: userId, enabled, rules };
}

export function fromRulesRow(row: unknown): EngineUser {
  const parsed = parse(
    z.object({ user_id: uuid, enabled: z.boolean(), rules: z.unknown() }),
    "v2_rules",
    row,
  );
  const rules = parseRulesDocument(parsed.rules ?? {});
  return {
    userId: parsed.user_id,
    // A zone this runtime does not know falls back to UTC rather than throwing:
    // a typo in one field must not stop the engine reading the account.
    timeZone: safeTimeZone(rules.planner.timeZone) ?? "UTC",
    rules,
  };
}

// ---------------------------------------------------------------- v2_days

export interface DayRow {
  user_id: string;
  date: string;
  energy: string | null;
  energy_assumed: boolean;
  mode: string;
  planned_at: string | null;
  morning_sent_at: string | null;
  dropped: PlanOutput["dropped"];
  leave_by: PlanOutput["leaveBy"];
}

const dayRowSchema = z.object({
  user_id: uuid,
  date: dateKey,
  energy: energy.nullable(),
  energy_assumed: z.boolean(),
  mode: planMode,
  planned_at: nullableInstant,
  morning_sent_at: nullableInstant,
  dropped: droppedList,
  leave_by: leaveByList,
});

export function toDayRow(userId: string, day: DayRecord): DayRow {
  return {
    user_id: userId,
    date: day.date,
    energy: day.energy,
    energy_assumed: day.energyAssumed,
    mode: day.mode,
    planned_at: day.plannedAt,
    morning_sent_at: day.morningSentAt,
    dropped: day.dropped,
    leave_by: day.leaveBy,
  };
}

export function fromDayRow(row: unknown): DayRecord {
  const parsed = parse(dayRowSchema, "v2_days", row);
  return {
    userId: parsed.user_id,
    date: parsed.date,
    energy: parsed.energy,
    energyAssumed: parsed.energy_assumed,
    mode: parsed.mode,
    plannedAt: parsed.planned_at,
    morningSentAt: parsed.morning_sent_at,
    dropped: parsed.dropped,
    leaveBy: parsed.leave_by,
  };
}

/** The columns a patch names, and only those, so the rest are left alone. */
export function dayPatchToRow(patch: DayPatch): Partial<DayRow> {
  const row: Partial<DayRow> = {};
  if ("energy" in patch) row.energy = patch.energy ?? null;
  if ("energyAssumed" in patch) row.energy_assumed = patch.energyAssumed;
  if ("mode" in patch) row.mode = patch.mode;
  if ("plannedAt" in patch) row.planned_at = patch.plannedAt ?? null;
  if ("morningSentAt" in patch) row.morning_sent_at = patch.morningSentAt ?? null;
  if ("dropped" in patch) row.dropped = patch.dropped;
  if ("leaveBy" in patch) row.leave_by = patch.leaveBy;
  return row;
}

/** A fresh day, before anything has been planned or answered. */
export function emptyDayRow(userId: string, date: string): DayRow {
  return {
    user_id: userId,
    date,
    energy: null,
    energy_assumed: false,
    mode: "normal",
    planned_at: null,
    morning_sent_at: null,
    dropped: [],
    leave_by: [],
  };
}

// ---------------------------------------------------------------- v2_blocks

export interface BlockRow {
  user_id: string;
  id: string;
  date: string;
  starts_at: string;
  ends_at: string;
  kind: string;
  lane: string | null;
  task_id: string | null;
  title: string;
  state: string;
  reason: string;
}

const blockRowSchema = z
  .object({
    id: z.string().min(1),
    date: dateKey,
    starts_at: instant,
    ends_at: instant,
    kind: blockKind,
    lane: z.string().min(1).nullable(),
    task_id: uuid.nullable(),
    title: z.string(),
    state: blockState,
    reason: z.string(),
  })
  // 0066's v2_blocks_window check constraint. Without this the memory store
  // would accept a block that ends before it starts and the engine tests would
  // pass on behaviour production answers with a 23514.
  .refine((row) => Date.parse(row.ends_at) >= Date.parse(row.starts_at), {
    message: "ends before it starts",
    path: ["ends_at"],
  });

export function toBlockRow(userId: string, block: Block): BlockRow {
  return {
    user_id: userId,
    id: block.id,
    date: block.date,
    starts_at: block.start,
    ends_at: block.end,
    kind: block.kind,
    lane: block.lane,
    task_id: block.taskId,
    title: block.title,
    state: block.state,
    reason: block.reason,
  };
}

/**
 * The rows of one plan, checked the way the day's own write checks them.
 *
 * Both stores build their plan through this, so the two cannot drift on what a
 * bad plan is - which is the whole risk in having two implementations. It
 * refuses, before anything is written:
 *
 * - a block dated somewhere other than the day being planned, because a plan is
 *   a plan for one day and a stray row would land where no later replan of that
 *   day would ever find it;
 * - the same id twice, because Postgres answers that with "ON CONFLICT DO
 *   UPDATE command cannot affect row a second time" and fails the WHOLE call,
 *   so a planner bug that emitted one id twice would break every replan;
 * - anything `fromBlockRow` refuses, which is every check `v2_blocks` states.
 */
export function toPlanRows(userId: string, date: string, blocks: Block[]): BlockRow[] {
  const seen = new Set<string>();
  return blocks.map((block) => {
    if (block.date !== date) {
      throw new RowShapeError("v2_blocks", "date", `is ${block.date}, not ${date}`);
    }
    if (seen.has(block.id)) {
      throw new RowShapeError("v2_blocks", "id", `appears twice in one plan: ${block.id}`);
    }
    seen.add(block.id);
    const row = toBlockRow(userId, block);
    fromBlockRow(row);
    return row;
  });
}

export function fromBlockRow(row: unknown): Block {
  const parsed = parse(blockRowSchema, "v2_blocks", row);
  return {
    id: parsed.id,
    date: parsed.date,
    start: parsed.starts_at,
    end: parsed.ends_at,
    kind: parsed.kind,
    lane: parsed.lane,
    taskId: parsed.task_id,
    title: parsed.title,
    state: parsed.state,
    reason: parsed.reason,
  };
}

// ---------------------------------------------------------------- v2_asks

export interface AskRow {
  user_id: string;
  id: string;
  kind: string;
  topic: string;
  text: string;
  options: AskOption[];
  default_option_id: string;
  time_critical: boolean;
  opened_at: string;
  remind_at: string | null;
  reminded_at: string | null;
  expires_at: string;
  status: string;
  answered_option_id: string | null;
  answered_at: string | null;
  assumed: boolean;
  dedupe_key: string;
}

const askRowSchema = z.object({
  user_id: uuid,
  id: uuid,
  kind: z.string().min(1),
  topic: z.string().min(1),
  text: z.string(),
  options: z.array(askOption).min(1),
  default_option_id: z.string().min(1),
  time_critical: z.boolean(),
  opened_at: instant,
  remind_at: nullableInstant,
  reminded_at: nullableInstant,
  expires_at: instant,
  status: askStatus,
  answered_option_id: z.string().min(1).nullable(),
  answered_at: nullableInstant,
  assumed: z.boolean(),
  dedupe_key: z.string().min(1),
});

export function toAskRow(userId: string, ask: Ask): AskRow {
  return {
    user_id: userId,
    id: ask.id,
    kind: ask.kind,
    topic: ask.topic,
    text: ask.text,
    options: ask.options,
    default_option_id: ask.defaultOptionId,
    time_critical: ask.timeCritical,
    opened_at: ask.openedAt,
    remind_at: ask.remindAt,
    reminded_at: ask.remindedAt,
    expires_at: ask.expiresAt,
    status: ask.status,
    answered_option_id: ask.answeredOptionId,
    answered_at: ask.answeredAt,
    assumed: ask.assumed,
    dedupe_key: ask.dedupeKey,
  };
}

export function fromAskRow(row: unknown): Ask {
  const parsed = parse(askRowSchema, "v2_asks", row);
  return {
    id: parsed.id,
    userId: parsed.user_id,
    kind: parsed.kind,
    topic: parsed.topic,
    text: parsed.text,
    options: parsed.options,
    defaultOptionId: parsed.default_option_id,
    timeCritical: parsed.time_critical,
    openedAt: parsed.opened_at,
    remindAt: parsed.remind_at,
    remindedAt: parsed.reminded_at,
    expiresAt: parsed.expires_at,
    status: parsed.status,
    answeredOptionId: parsed.answered_option_id,
    answeredAt: parsed.answered_at,
    assumed: parsed.assumed,
    dedupeKey: parsed.dedupe_key,
  };
}

// ---------------------------------------------------------------- v2_outbox

export interface OutboxRow {
  user_id: string;
  id: string;
  kind: string;
  dedupe_key: string;
  delivery: string;
  message: OutgoingMessage;
  ask_id: string | null;
  created_at: string;
  claimed_at: string | null;
  sent_at: string | null;
  chat_message_id: string | null;
  error: string | null;
}

const outboxRowSchema = z.object({
  user_id: uuid,
  id: uuid,
  kind: outboxKind,
  dedupe_key: z.string().min(1),
  delivery: outboxDelivery,
  message: outgoingMessage,
  ask_id: uuid.nullable(),
  created_at: instant,
  claimed_at: nullableInstant,
  sent_at: nullableInstant,
  chat_message_id: z.string().min(1).nullable(),
  error: z.string().min(1).nullable(),
});

export function toOutboxRow(userId: string, item: OutboxItem): OutboxRow {
  return {
    user_id: userId,
    id: item.id,
    kind: item.kind,
    dedupe_key: item.dedupeKey,
    delivery: item.delivery,
    message: item.message,
    ask_id: item.askId,
    created_at: item.createdAt,
    claimed_at: item.claimedAt,
    sent_at: item.sentAt,
    chat_message_id: item.chatMessageId,
    error: item.error,
  };
}

export function fromOutboxRow(row: unknown): OutboxItem {
  const parsed = parse(outboxRowSchema, "v2_outbox", row);
  return {
    id: parsed.id,
    userId: parsed.user_id,
    kind: parsed.kind,
    dedupeKey: parsed.dedupe_key,
    delivery: parsed.delivery,
    message: parsed.message,
    askId: parsed.ask_id,
    createdAt: parsed.created_at,
    claimedAt: parsed.claimed_at,
    sentAt: parsed.sent_at,
    chatMessageId: parsed.chat_message_id,
    error: parsed.error,
  };
}

// ------------------------------------------------- v2_feed_expectations

export interface ExpectationRow {
  user_id: string;
  feed: string;
  label: string;
  every_minutes: number;
  grace_minutes: number;
  min_count: number;
  active_from: string | null;
  active_to: string | null;
  enabled_at: string;
}

const expectationRowSchema = z
  .object({
    feed: z.string().min(1),
    label: z.string(),
    every_minutes: z.number().int().positive(),
    grace_minutes: z.number().int().nonnegative(),
    min_count: z.number().int().nonnegative(),
    active_from: wallTime.nullable(),
    active_to: wallTime.nullable(),
    enabled_at: instant,
  })
  // The database says the same thing with a check constraint; this is the half
  // that protects the memory store.
  .refine((row) => (row.active_from === null) === (row.active_to === null), {
    message: "needs both ends of the window or neither",
    path: ["active_from"],
  });

export function toExpectationRow(userId: string, expectation: StoredExpectation): ExpectationRow {
  return {
    user_id: userId,
    feed: expectation.feed,
    label: expectation.label,
    every_minutes: expectation.everyMinutes,
    grace_minutes: expectation.graceMinutes,
    min_count: expectation.minCount,
    active_from: expectation.activeHours?.from ?? null,
    active_to: expectation.activeHours?.to ?? null,
    enabled_at: expectation.enabledAt,
  };
}

export function fromExpectationRow(row: unknown): StoredExpectation {
  const parsed = parse(expectationRowSchema, "v2_feed_expectations", row);
  return {
    feed: parsed.feed,
    label: parsed.label,
    everyMinutes: parsed.every_minutes,
    graceMinutes: parsed.grace_minutes,
    minCount: parsed.min_count,
    activeHours:
      parsed.active_from !== null && parsed.active_to !== null
        ? { from: parsed.active_from, to: parsed.active_to }
        : null,
    enabledAt: parsed.enabled_at,
  };
}

// ---------------------------------------------------------------- v2_feed_runs

export interface FeedRunRow {
  user_id: string;
  feed: string;
  started_at: string;
  finished_at: string | null;
  status: string;
  item_count: number;
  error_class: string | null;
}

const feedRunRowSchema = z.object({
  feed: z.string().min(1),
  started_at: instant,
  finished_at: nullableInstant,
  status: runStatus,
  item_count: z.number().int().nonnegative(),
  error_class: z.string().min(1).nullable(),
});

export function toFeedRunRow(userId: string, run: FeedRun): FeedRunRow {
  return {
    user_id: userId,
    feed: run.feed,
    started_at: run.startedAt,
    finished_at: run.finishedAt,
    status: run.status,
    item_count: run.count,
    error_class: run.errorClass,
  };
}

export function fromFeedRunRow(row: unknown): FeedRun {
  const parsed = parse(feedRunRowSchema, "v2_feed_runs", row);
  return {
    feed: parsed.feed,
    startedAt: parsed.started_at,
    finishedAt: parsed.finished_at,
    status: parsed.status,
    count: parsed.item_count,
    errorClass: parsed.error_class,
  };
}

// ---------------------------------------------------------------- v2_alerts

export interface AlertRow {
  user_id: string;
  id: string;
  cause: string;
  feeds: string[];
  since: string;
  step: number;
  last_sent_at: string | null;
  status: string;
}

const alertRowSchema = z.object({
  id: uuid,
  cause: z.string().min(1),
  feeds: z.array(z.string().min(1)),
  since: instant,
  step: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  last_sent_at: nullableInstant,
  status: alertStatus,
});

export function toAlertRow(userId: string, alert: Alert): AlertRow {
  return {
    user_id: userId,
    id: alert.id,
    cause: alert.cause,
    feeds: alert.feeds,
    since: alert.since,
    step: alert.step,
    last_sent_at: alert.lastSentAt,
    status: alert.status,
  };
}

export function fromAlertRow(row: unknown): Alert {
  const parsed = parse(alertRowSchema, "v2_alerts", row);
  return {
    id: parsed.id,
    cause: parsed.cause,
    feeds: parsed.feeds,
    since: parsed.since,
    step: parsed.step,
    lastSentAt: parsed.last_sent_at,
    status: parsed.status,
  };
}

// ---------------------------------------------------------------- v2_channels

export interface ChannelRow {
  user_id: string;
  chat_id: string | null;
  linked_at: string | null;
  pairing_hash?: string | null;
  pairing_expires_at?: string | null;
}

const channelRowSchema = z.object({
  user_id: uuid,
  chat_id: z.string().min(1).nullable(),
  linked_at: nullableInstant,
});

export function toChannelRow(userId: string, link: ChannelLink): ChannelRow {
  return { user_id: userId, chat_id: link.chatId, linked_at: link.linkedAt };
}

/** The link half of the row only: a pairing hash never becomes a domain value. */
export function fromChannelRow(row: unknown): ChannelLink {
  const parsed = parse(channelRowSchema, "v2_channels", row);
  return { userId: parsed.user_id, chatId: parsed.chat_id, linkedAt: parsed.linked_at };
}

// ------------------------------------------------- single column arguments
//
// A conditional update writes one or two columns and never builds a whole row,
// so there is nothing for a row schema to check. Postgres would take an empty
// error class or a 13 character option id quite happily, the write would land,
// and then EVERY later read of that account would throw a RowShapeError on a
// row the store itself wrote. These are what the callers check first, in both
// implementations, so the two stores refuse the same arguments.

function assertColumn<S extends z.ZodTypeAny>(
  schema: S,
  table: string,
  column: string,
  value: unknown,
): z.infer<S> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new RowShapeError(table, column, result.error.issues[0].message);
}

/** At most 12 characters, by the AskOption contract in types.ts. */
export function assertOptionId(optionId: string): string {
  return assertColumn(z.string().min(1).max(12), "v2_asks", "answered_option_id", optionId);
}

/** A short stable class such as "bot-blocked", never empty, never a provider message. */
export function assertErrorClass(value: string): string {
  return assertColumn(z.string().min(1), "v2_outbox", "error", value);
}

export function assertChatMessageId(value: string | null): string | null {
  return assertColumn(z.string().min(1).nullable(), "v2_outbox", "chat_message_id", value);
}

/** 64 lowercase hex characters, matching 0066's check: a digest, never a code. */
export function assertPairingHash(value: string): string {
  return assertColumn(
    z.string().regex(/^[0-9a-f]{64}$/, { message: "is not a sha-256 hex digest" }),
    "v2_channels",
    "pairing_hash",
    value,
  );
}

/** 0066's v2_blocks_window check, for the one write that sets the times alone. */
export function assertWindow(start: string, end: string): void {
  assertColumn(instant, "v2_blocks", "starts_at", start);
  const parsedEnd = assertColumn(instant, "v2_blocks", "ends_at", end);
  if (Date.parse(parsedEnd) < Date.parse(start)) {
    throw new RowShapeError("v2_blocks", "ends_at", "ends before it starts");
  }
}
