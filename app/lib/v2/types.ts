// Shared contracts for the v2 engine (planner, asks, watchdog, channel).
// Pure types only: no imports, no logic, no defaults. Every module under
// app/lib/v2 codes against these names, so change them here first.
//
// Nothing in this file may describe a particular person. Lanes, wake times,
// caps and travel rules are DATA (a per-user PlannerRules row), never code.

/** "YYYY-MM-DD" in the user's time zone. */
export type DateKey = string;

/** ISO 8601 instant with an explicit offset or "Z". */
export type Instant = string;

/**
 * "HH:MM", 24-hour, in the user's time zone.
 * A lights-out time earlier than "06:00" belongs to the NEXT calendar day
 * (lights out at "01:00" ends the planning day that started the morning before).
 */
export type WallTime = string;

/** Per-user lane id such as "lane-a". Never hard-coded in engine code. */
export type LaneKey = string;

export type Energy = "low" | "ok" | "good";

export type PlanMode = "normal" | "short-night" | "rough-day" | "travel";

// ---------------------------------------------------------------- rules

export interface CapacityRule {
  /** Standard blocks on top of the floor block. */
  blocks: number;
  /** Small tasks (10 minutes or less) on top of the floor block. */
  small: number;
  gym: boolean;
  social: boolean;
}

export interface PlannerRules {
  /** IANA zone. Every local time in the engine is derived from this. */
  timeZone: string;
  /** Wake target per weekday, index 0 = Sunday. */
  wakeByWeekday: [WallTime, WallTime, WallTime, WallTime, WallTime, WallTime, WallTime];
  lightsOut: WallTime;
  /** Nothing the planner owns starts before this. Fixed events are unaffected. */
  noFocusBefore: WallTime;
  blockMinutes: { floor: number; standard: number; long: number };
  /** Minimum gap kept between any two things on the day. */
  bufferMinutes: number;
  capacity: Record<Energy, CapacityRule>;
  /** Items closing within this many hours of `now` are "hard window" items. */
  hardWindowHours: number;
  /** Per-lane daily limit. Hard-window items are exempt. */
  maxBlocksPerLanePerDay: number;
  /** Weekly ceiling on hours that count toward the cap. null = no cap. */
  weeklyHourCap: number | null;
  /** Inclusive date ranges in which the cap does not apply. */
  capExemptRanges: Array<{ from: DateKey; to: DateKey }>;
  /** A lane whose weekly hours the planner tries to reach with long blocks. */
  incomeTarget: { lane: LaneKey; weeklyHours: number; blockMinutes: number } | null;
  /** Windows the planner leaves empty. weekday 0 = Sunday. */
  protectedWindows: Array<{
    weekday: number;
    from: WallTime;
    to: WallTime;
    /** When true, an item that closes today may still use the window. */
    unlessDueToday: boolean;
  }>;
  /** Travel time added around matching fixed events. First match wins. */
  travel: Array<{
    calendarId: string | null;
    locationIncludes: string | null;
    minutesBefore: number;
    minutesAfter: number;
  }>;
  /** The reserved working session on the day a hard item closes. */
  deadlineDay: { sessionMinutes: number; earliestStart: WallTime; latestEnd: WallTime };
  /** One short "open it and read it" block this many days before a hard item closes. */
  earlyTouch: { daysBefore: number; minutes: number };
  gym: { perWeek: number; minutes: number; notBefore: WallTime } | null;
  /** A block that ended with no word gets its default applied after this long. */
  slipDefaultAfterMinutes: number;
  /** Interrupting messages allowed per day. Everything else waits for a digest. */
  interruptsPerDay: number;
}

// ---------------------------------------------------------------- planner

/** Something already on the day that the planner must plan around. */
export interface FixedEvent {
  id: string;
  title: string;
  start: Instant;
  end: Instant;
  allDay: boolean;
  calendarId: string | null;
  location: string | null;
  /** True for paid work (shifts, lessons). Counts toward the weekly cap. */
  countsTowardCap: boolean;
  source: "google" | "task" | "routine";
}

/** Something the planner may place. */
export interface Candidate {
  /** Task id. */
  id: string;
  title: string;
  lane: LaneKey | null;
  kind: "step" | "side";
  /** The instant it closes, if it has one. */
  due: Instant | null;
  /** A hard deadline, or a soft window that has been promoted to one. */
  hard: boolean;
  /** Estimate in minutes. null = one standard block. 10 or less = a small task. */
  minutes: number | null;
  energyCost: 1 | 2 | 3 | 4 | 5 | null;
  /** Side quests leave the list at this instant unless pinned. */
  expiresAt: Instant | null;
  pinned: boolean;
  earlyTouchDone: boolean;
}

export type BlockKind = "floor" | "focus" | "session" | "touch" | "income" | "gym" | "small";

export type BlockState = "planned" | "started" | "done" | "skipped";

/** A block the planner owns. */
export interface Block {
  /** Stable for the same (date, kind, taskId): replans keep ids. */
  id: string;
  date: DateKey;
  start: Instant;
  end: Instant;
  kind: BlockKind;
  lane: LaneKey | null;
  taskId: string | null;
  title: string;
  state: BlockState;
  /** One short machine reason, e.g. "hard-window", "income-target", "lane-next". */
  reason: string;
}

export interface WeekStats {
  /** Hours counting toward the cap on the OTHER days of this week (worked or planned). */
  capHoursElsewhere: number;
  /** Hours on the income-target lane on the other days of this week. */
  incomeHoursElsewhere: number;
  gymSessionsDone: number;
}

export interface PlanInput {
  date: DateKey;
  now: Instant;
  rules: PlannerRules;
  /** null = no answer yet. The planner then uses "ok" and reports it as assumed. */
  energy: Energy | null;
  mode: PlanMode;
  fixed: FixedEvent[];
  candidates: Candidate[];
  week: WeekStats;
  /** Blocks from the previous plan for this date. Empty on the first plan. */
  existing: Block[];
}

export interface PlanOutput {
  date: DateKey;
  blocks: Block[];
  /** Candidates that were eligible today and did not fit, with a machine reason. */
  dropped: Array<{ candidateId: string; reason: string }>;
  /** Blocks whose time changed compared with `existing`. */
  moved: Array<{ blockId: string; from: Instant; to: Instant }>;
  /** Blocks from `existing` that are no longer in the plan. */
  removed: Array<{ blockId: string; reason: string }>;
  /** When to leave for fixed events that carry travel time. */
  leaveBy: Array<{ fixedId: string; at: Instant }>;
  energyUsed: Energy;
  energyAssumed: boolean;
  mode: PlanMode;
}

// ---------------------------------------------------------------- asks

/** What answering (or defaulting) an ask does. The caller executes it. */
export type AskEffect =
  | { type: "block.done"; blockId: string; fraction: 1 | 0.5 }
  | { type: "block.reschedule"; blockId: string; to: "later-today" | "tomorrow" }
  | { type: "block.drop"; blockId: string }
  | { type: "energy.set"; date: DateKey; energy: Energy }
  | { type: "none" };

export interface AskOption {
  /** Short and URL-safe, at most 12 characters. */
  id: string;
  /** Button text, one to three words. */
  label: string;
  effect: AskEffect;
}

export type AskStatus = "open" | "answered" | "expired" | "cancelled";

export interface Ask {
  id: string;
  userId: string;
  /** Machine kind, e.g. "slip", "energy". */
  kind: string;
  /** What it is about, for backoff. e.g. "block:<id>" or "energy:<date>". */
  topic: string;
  text: string;
  options: AskOption[];
  /** Applied when the ask expires unanswered. */
  defaultOptionId: string;
  /** True when it must reach him now or not at all (a block starting, a deadline today). */
  timeCritical: boolean;
  openedAt: Instant;
  /** One reminder at most. null = none. */
  remindAt: Instant | null;
  remindedAt: Instant | null;
  expiresAt: Instant;
  status: AskStatus;
  answeredOptionId: string | null;
  answeredAt: Instant | null;
  /** True when the default was applied because nobody answered. */
  assumed: boolean;
  /** Two asks with the same key are the same ask. */
  dedupeKey: string;
}

export type Delivery = "interrupt" | "digest" | "hold";

// ---------------------------------------------------------------- watchdog

/** What "alive" means for one feed. */
export interface Expectation {
  feed: string;
  /** A good run is expected at least this often. */
  everyMinutes: number;
  graceMinutes: number;
  /** A run that finished "ok" with fewer items than this is a failure. */
  minCount: number;
  /** Only checked inside these local hours. null = always. */
  activeHours: { from: WallTime; to: WallTime } | null;
}

export interface FeedRun {
  feed: string;
  startedAt: Instant;
  finishedAt: Instant | null;
  status: "ok" | "error";
  /** How many items the run produced. */
  count: number;
  /** Short stable code such as "auth-expired". Free text never goes here. */
  errorClass: string | null;
}

export interface FeedStatus {
  feed: string;
  state: "alive" | "late" | "failing" | "blind";
  lastGoodAt: Instant | null;
  /** The error class behind a "failing" state, or "no-run" / "empty-run". */
  cause: string | null;
}

export interface Alert {
  id: string;
  /** Feeds failing for the same cause share one alert. */
  cause: string;
  feeds: string[];
  since: Instant;
  /** 0 = first channel, 1 = second, 2 = third. */
  step: 0 | 1 | 2;
  lastSentAt: Instant | null;
  status: "open" | "closed";
}

/**
 * What the watchdog decided for one alert. `open`, `escalate` and `close` are
 * sent to the user. `update` is silent: the alert's feed list changed, so the
 * row is stored again and nothing is sent.
 */
export type AlertAction =
  | { type: "open"; alert: Alert }
  | { type: "update"; alert: Alert }
  | { type: "escalate"; alert: Alert }
  | { type: "close"; alert: Alert };

// ---------------------------------------------------------------- channel

export interface OutgoingMessage {
  text: string;
  /** One row of buttons at most. Each answers an ask. */
  buttons: Array<{ label: string; askId: string; optionId: string }>;
}

export type Incoming =
  | { type: "answer"; chatId: string; askId: string; optionId: string; callbackId: string }
  | { type: "text"; chatId: string; text: string }
  | { type: "start"; chatId: string; pairingCode: string | null };
