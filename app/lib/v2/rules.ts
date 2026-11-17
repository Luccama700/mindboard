// The per-user planner rules: a generic default row and the one door a stored
// row comes through.
//
// NOTHING PERSONAL LIVES HERE. Every number below is a spec default that makes
// sense for an account nobody has configured. Lanes, wake times, caps, travel
// rules and protected windows are data in a PlannerRules row, so a rule that
// describes a particular person belongs in the database, never in this file.
//
// parseRules merges over DEFAULT_RULES rather than demanding a whole row: a
// stored row only has to carry what the user changed. Nested objects merge key
// by key (blockMinutes, capacity, deadlineDay, earlyTouch); arrays and the
// nullable objects replace wholesale, because "half an income target" or "three
// of my four travel rules" are not meaningful. Unknown keys are ignored so an
// older row still parses.

import { z } from "zod";

import { zonedDateKey } from "@/app/lib/snapshots/zoned-time";
import type { PlannerRules } from "@/app/lib/v2/types";

export const DEFAULT_RULES: PlannerRules = {
  timeZone: "UTC",
  wakeByWeekday: [
    "08:00",
    "08:00",
    "08:00",
    "08:00",
    "08:00",
    "08:00",
    "08:00",
  ],
  lightsOut: "23:00",
  noFocusBefore: "09:00",
  blockMinutes: { floor: 25, standard: 50, long: 120 },
  bufferMinutes: 10,
  capacity: {
    low: { blocks: 0, small: 1, gym: false, social: false },
    ok: { blocks: 2, small: 0, gym: false, social: false },
    good: { blocks: 3, small: 0, gym: true, social: true },
  },
  hardWindowHours: 72,
  maxBlocksPerLanePerDay: 1,
  weeklyHourCap: null,
  capExemptRanges: [],
  incomeTarget: null,
  protectedWindows: [],
  travel: [],
  deadlineDay: {
    sessionMinutes: 180,
    earliestStart: "17:00",
    latestEnd: "23:00",
  },
  earlyTouch: { daysBefore: 3, minutes: 25 },
  gym: null,
  slipDefaultAfterMinutes: 30,
  interruptsPerDay: 3,
};

/** "HH:MM", 24-hour. A single-digit hour is a malformed wall time, not 09. */
const WALL_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
/** "YYYY-MM-DD", with the month and day ranges checked. */
const DATE_KEY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

// The shape is not enough: "2026-02-31" matches the pattern and would silently
// become 2026-03-03 the first time anything did arithmetic on it. A real date
// is one that survives the round trip.
function isRealDate(value: string): boolean {
  const [year, month, day] = value.split("-").map(Number);
  return zonedDateKey(Date.UTC(year, month - 1, day), "UTC") === value;
}

function isKnownZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const wallTime = z.string().regex(WALL_TIME, "expected a wall time like 09:30");
const dateKey = z
  .string()
  .regex(DATE_KEY, "expected a date key like 2026-03-08")
  .refine(isRealDate, "expected a date that exists");
const timeZone = z
  .string()
  .refine(isKnownZone, "expected an IANA time zone like America/New_York");
const minutes = z.number().int().min(0);
const positiveMinutes = z.number().int().positive();
const hours = z.number().min(0);

const capacityRule = z
  .object({
    blocks: minutes,
    small: minutes,
    gym: z.boolean(),
    social: z.boolean(),
  })
  .partial();

const rulesInput = z
  .object({
    timeZone,
    wakeByWeekday: z.array(wallTime).length(7),
    lightsOut: wallTime,
    noFocusBefore: wallTime,
    blockMinutes: z
      .object({
        floor: positiveMinutes,
        standard: positiveMinutes,
        long: positiveMinutes,
      })
      .partial(),
    bufferMinutes: minutes,
    capacity: z
      .object({ low: capacityRule, ok: capacityRule, good: capacityRule })
      .partial(),
    hardWindowHours: hours,
    maxBlocksPerLanePerDay: minutes,
    weeklyHourCap: hours.nullable(),
    capExemptRanges: z.array(z.object({ from: dateKey, to: dateKey })),
    incomeTarget: z
      .object({
        lane: z.string().min(1),
        weeklyHours: hours,
        blockMinutes: positiveMinutes,
      })
      .nullable(),
    protectedWindows: z.array(
      z.object({
        weekday: z.number().int().min(0).max(6),
        from: wallTime,
        to: wallTime,
        unlessDueToday: z.boolean(),
      }),
    ),
    travel: z.array(
      z.object({
        calendarId: z.string().nullable(),
        locationIncludes: z.string().nullable(),
        minutesBefore: minutes,
        minutesAfter: minutes,
      }),
    ),
    deadlineDay: z
      .object({
        sessionMinutes: positiveMinutes,
        earliestStart: wallTime,
        latestEnd: wallTime,
      })
      .partial(),
    earlyTouch: z.object({ daysBefore: minutes, minutes: positiveMinutes }).partial(),
    gym: z
      .object({
        perWeek: minutes,
        minutes: positiveMinutes,
        notBefore: wallTime,
      })
      .nullable(),
    slipDefaultAfterMinutes: minutes,
    interruptsPerDay: minutes,
  })
  .partial();

type RulesInput = z.infer<typeof rulesInput>;

// An explicit `undefined` must read as "not set" so it cannot clobber a
// default: zod keeps a key that was present in the input even when its value
// is undefined.
function present<T extends object>(value: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    if (inner !== undefined) out[key] = inner;
  }
  return out as T;
}

export function parseRules(input: unknown): PlannerRules {
  const parsed: RulesInput = rulesInput.parse(
    input === undefined || input === null ? {} : input,
  );
  const given = present(parsed);

  return {
    ...DEFAULT_RULES,
    ...given,
    wakeByWeekday: (given.wakeByWeekday ??
      DEFAULT_RULES.wakeByWeekday) as PlannerRules["wakeByWeekday"],
    blockMinutes: {
      ...DEFAULT_RULES.blockMinutes,
      ...present(given.blockMinutes ?? {}),
    },
    capacity: {
      low: { ...DEFAULT_RULES.capacity.low, ...present(given.capacity?.low ?? {}) },
      ok: { ...DEFAULT_RULES.capacity.ok, ...present(given.capacity?.ok ?? {}) },
      good: {
        ...DEFAULT_RULES.capacity.good,
        ...present(given.capacity?.good ?? {}),
      },
    },
    deadlineDay: {
      ...DEFAULT_RULES.deadlineDay,
      ...present(given.deadlineDay ?? {}),
    },
    earlyTouch: {
      ...DEFAULT_RULES.earlyTouch,
      ...present(given.earlyTouch ?? {}),
    },
  };
}
