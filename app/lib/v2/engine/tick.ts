// The ten minute tick: one function, run once per account, that resolves what
// the day did to the plan and then plans it again.
//
// THREE PROPERTIES HOLD THIS FILE TOGETHER, because it runs unattended with a
// service-role client for other people's accounts.
//
// 1. Every store call carries the user id being ticked. There is no ambient
//    account here: `userId` is an argument and it is threaded through every
//    read and write (AGENTS.md, "Multi-tenant MCP invariant").
// 2. One failure is one step's failure. A step that throws is recorded as
//    `error`, the rest still run, and the tick's own feed run carries the first
//    failing step as its error class, so the watchdog can see a tick that is
//    half working. One account's failure never reaches another: the cron route
//    runs each account in its own try.
// 3. It is idempotent. The cron can fire twice and Telegram retries webhooks,
//    so every message carries a dedupe key, every send is one conditional
//    claim, and every state change is a conditional update. Running this twice
//    at the same instant does what running it once does.
//
// No clock is read and no id is generated in here: `now` and `newId` arrive as
// arguments. That is what makes every test a plain function call.

import {
  zonedDateKey,
  zonedIso,
} from "@/app/lib/snapshots/zoned-time";
import { energyAsk, slipAsk } from "@/app/lib/v2/asks/builders";
import { expireDue, openAsk } from "@/app/lib/v2/asks/lifecycle";
import { decideDelivery } from "@/app/lib/v2/asks/policy";
import { alertMessage, askMessage, feedLine, morningMessage } from "@/app/lib/v2/channel/messages";
import { TelegramError, type TelegramClient } from "@/app/lib/v2/channel/telegram";
import { weekStartKey } from "@/app/lib/v2/plan/cap";
import {
  MINUTE_MS,
  carveIntervals,
  compareText,
  freeIntervals,
  leaveByFor,
  maybeInstantMs,
  minutesToMs,
  shiftDateKey,
  wallMinutes,
  weekdayOf,
} from "@/app/lib/v2/plan/day";
import { planDay } from "@/app/lib/v2/plan/planner";
import { parseRules } from "@/app/lib/v2/rules";
import { clockLabel, sinceLabel } from "@/app/lib/v2/view/format";
import { planAlerts } from "@/app/lib/v2/watch/alerts";
import { daysSince, evaluateFeeds } from "@/app/lib/v2/watch/expectations";
import type { Probe } from "@/app/lib/v2/engine/probes";
import type { EngineUser, OutboxItem, Stores } from "@/app/lib/v2/store/types";
import type {
  Alert,
  AlertAction,
  Ask,
  AskEffect,
  Block,
  Candidate,
  DateKey,
  Delivery,
  FeedRun,
  FeedStatus,
  FixedEvent,
  Instant,
  OutgoingMessage,
  PlanOutput,
  PlannerRules,
  WeekStats,
} from "@/app/lib/v2/types";

/** A planned block that began this long ago, with nothing said, has slipped. */
export const SLIP_GRACE_MINUTES = 10;
/** A cause announced this recently reopens silently, so a flapping feed cannot nag. */
export const ALERT_REOPEN_QUIET_HOURS = 6;
export const FEED_RUN_RETENTION_DAYS = 14;

/** The tick's own feed: what the watchdog watches the watchdog with. */
export const ENGINE_TICK_FEED = "engine-tick";
/** The channel's feed. An expectation on it wants minCount 0: a quiet day sends nothing. */
export const TELEGRAM_FEED = "telegram";
/** The feed the production loadFixed reports the calendar under. */
export const CALENDAR_FEED = "calendar";

/** How far back the watchdog reads runs. */
const WATCHDOG_WINDOW_HOURS = 48;
/** Past this, the status route says the clock is not running. */
const TICK_STALE_MINUTES = 30;

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const NOON_MINUTES = 12 * 60;
/** The AskOption contract in types.ts. A longer id is a forged callback. */
export const OPTION_ID_MAX = 12;

const REASON = {
  dayEnded: "day ended",
  slippedTwice: "slipped twice",
  noRoomLater: "no room later today",
  movedToTomorrow: "moved to tomorrow",
  dropped: "dropped",
} as const;

const NOT_LINKED = "not-linked";

export interface TickDeps {
  stores: Stores;
  /** null when no bot token is configured: every step still runs, nothing is sent. */
  telegram: TelegramClient | null;
  loadFixed(
    userId: string,
    date: DateKey,
    user: EngineUser,
  ): Promise<{ fixed: FixedEvent[]; calendar: FeedRun }>;
  loadCandidates(userId: string, user: EngineUser, now: Instant): Promise<Candidate[]>;
  newId(): string;
  /**
   * Feeds that leave no run of their own, so the engine goes and looks (see
   * ./probes). Absent means none, which is what every pure test passes.
   */
  probes?: Probe[];
}

export type StepState = "ok" | "error";

export interface TickResult {
  ok: boolean;
  steps: Record<string, StepState>;
}

/**
 * Everything one account's tick resolved before it did anything, plus the day's
 * fixed events behind a one-shot memo: two steps need them and the calendar is
 * a network call, so it happens at most once per tick and its feed run is
 * written exactly once.
 */
export interface EngineContext {
  deps: TickDeps;
  stores: Stores;
  userId: string;
  user: EngineUser;
  rules: PlannerRules;
  now: Instant;
  nowMs: number;
  today: DateKey;
  fixedToday(): Promise<FixedEvent[]>;
}

interface TickState {
  plan: PlanOutput | null;
  statuses: Promise<FeedStatus[]> | null;
}

/**
 * One line per failure: the account, the step, and the error's CLASS. Never a
 * message, because a provider or PostgREST message can carry a row value, and
 * never a token. The durable signal is the feed run's error class.
 */
function logFailure(userId: string, step: string, error: unknown): void {
  const kind = error instanceof Error ? error.name : typeof error;
  console.warn(`v2 tick: ${step} failed for ${userId} (${kind})`);
}

export async function createEngineContext(
  deps: TickDeps,
  userId: string,
  now: Instant,
): Promise<EngineContext> {
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) throw new Error(`not an instant: ${now}`);
  const user = await deps.stores.users.get(userId);
  if (user === null) throw new Error("this account has no rules row");
  // The one spelling in which the store's zone and the planner's cannot
  // disagree (store/types.ts). It throws on a zone or a wall time this runtime
  // will not take, which fails THIS account's tick and no other.
  const rules = parseRules({ ...user.rules.planner, timeZone: user.timeZone });
  const today = zonedDateKey(nowMs, rules.timeZone);

  let pending: Promise<FixedEvent[]> | null = null;
  return {
    deps,
    stores: deps.stores,
    userId,
    user,
    rules,
    now,
    nowMs,
    today,
    fixedToday() {
      pending ??= deps.loadFixed(userId, today, user).then(async ({ fixed, calendar }) => {
        try {
          await deps.stores.feeds.addRun(userId, calendar);
        } catch (error) {
          // Recording the calendar's health must not cost the plan.
          logFailure(userId, "calendar-run", error);
        }
        return fixed;
      });
      return pending;
    },
  };
}

function isoAt(ctx: EngineContext, ms: number): Instant {
  return zonedIso(ms, ctx.rules.timeZone);
}

/** Local midnight today, which is the day's interrupt budget window. */
function dayStart(ctx: EngineContext): Instant {
  return isoAt(ctx, minutesToMs(ctx.today, 0, ctx.rules.timeZone));
}

/** Monday 00:00 of this week in the user's zone, which is the backoff window. */
function weekStart(ctx: EngineContext): Instant {
  const monday = weekStartKey(ctx.today);
  return isoAt(ctx, minutesToMs(monday, 0, ctx.rules.timeZone));
}

// ---------------------------------------------------------------- week stats

function lengthHours(block: Block): number {
  const startMs = maybeInstantMs(block.start);
  const endMs = maybeInstantMs(block.end);
  if (startMs === null || endMs === null || endMs <= startMs) return 0;
  return (endMs - startMs) / HOUR_MS;
}

/**
 * What the week looks like from the blocks the engine owns on its OTHER days.
 * Planned counts the same as done: the point is not to book past a weekly limit.
 *
 * KNOWN LIMIT, deliberately not hidden: `capHoursElsewhere` sees income BLOCKS
 * only. Paid work that exists solely as a shift on a Google calendar of another
 * day is invisible here, because `loadFixed` loads one date and TickDeps has no
 * seam for a week of fixed events. The weekly cap is therefore a floor, not the
 * true figure, until something loads the week's calendar.
 */
export function weekStatsFromBlocks(
  date: DateKey,
  blocks: Block[],
  rules: PlannerRules,
): WeekStats {
  const incomeLane = rules.incomeTarget?.lane ?? null;
  let capHoursElsewhere = 0;
  let incomeHoursElsewhere = 0;
  let gymSessionsDone = 0;
  for (const block of blocks) {
    if (block.date === date || block.state === "skipped") continue;
    const hours = lengthHours(block);
    if (block.kind === "income") capHoursElsewhere += hours;
    if (incomeLane !== null && block.lane === incomeLane) incomeHoursElsewhere += hours;
    if (block.kind === "gym") gymSessionsDone += 1;
  }
  return { capHoursElsewhere, incomeHoursElsewhere, gymSessionsDone };
}

async function weekBlocks(ctx: EngineContext): Promise<Block[]> {
  const monday = weekStartKey(ctx.today);
  const dates = Array.from({ length: 7 }, (_, index) => shiftDateKey(monday, index)).filter(
    (date) => date !== ctx.today,
  );
  const lists = await Promise.all(
    dates.map((date) => ctx.stores.blocks.listForDate(ctx.userId, date)),
  );
  return lists.flat();
}

// ------------------------------------------------------------------- effects

/**
 * Applies what answering (or defaulting) an ask decided. No effect touches the
 * task row: the engine owns blocks and days, and a task's own state is the
 * app's.
 *
 * `assumed` says whether this is an answer or a default that was applied
 * because nobody answered. It only reaches `energy.set`, where the spec is
 * explicit that an unanswered day is "ok, reported as assumed": the value
 * stored is the one the option carries either way.
 */
export async function applyEffect(
  ctx: EngineContext,
  effect: AskEffect,
  assumed = false,
): Promise<void> {
  switch (effect.type) {
    case "block.done":
      await ctx.stores.blocks.setState(ctx.userId, effect.blockId, "done");
      return;
    case "block.drop":
      await ctx.stores.blocks.setState(ctx.userId, effect.blockId, "skipped", {
        reason: REASON.dropped,
      });
      return;
    case "block.reschedule":
      if (effect.to === "tomorrow") {
        await ctx.stores.blocks.setState(ctx.userId, effect.blockId, "skipped", {
          reason: REASON.movedToTomorrow,
        });
        return;
      }
      await moveLaterToday(ctx, effect.blockId);
      return;
    case "energy.set":
      await ctx.stores.days.patch(ctx.userId, effect.date, {
        energy: effect.energy,
        energyAssumed: assumed,
      });
      return;
    case "none":
      return;
  }
}

/**
 * The first free interval that holds the block's length and starts after both
 * `now` and its own end plus the buffer. It stays `planned`, which is what makes
 * the next plan keep the new time (planner behaviour 9).
 *
 * A block of an earlier day is not moved here: the close-out step owns those,
 * and "later today" cannot mean a day that has ended.
 */
async function moveLaterToday(ctx: EngineContext, blockId: string): Promise<void> {
  const blocks = await ctx.stores.blocks.listForDate(ctx.userId, ctx.today);
  const block = blocks.find((candidate) => candidate.id === blockId);
  if (block === undefined || block.state !== "planned") return;
  const startMs = maybeInstantMs(block.start);
  const endMs = maybeInstantMs(block.end);
  if (startMs === null || endMs === null) return;

  const lengthMs = Math.max(endMs - startMs, MINUTE_MS);
  const buffer = ctx.rules.bufferMinutes * MINUTE_MS;
  const busy = blocks
    .filter((other) => other.id !== blockId && other.state !== "skipped")
    .map((other) => ({
      startMs: (maybeInstantMs(other.start) ?? 0) - buffer,
      endMs: (maybeInstantMs(other.end) ?? 0) + buffer,
    }));
  const free = carveIntervals(
    freeIntervals(ctx.today, await ctx.fixedToday(), ctx.rules, {
      fromMs: Math.max(ctx.nowMs, endMs + buffer),
      allowProtected: false,
    }),
    busy,
  );
  const slot = free.find((interval) => interval.endMs - interval.startMs >= lengthMs);
  if (slot === undefined) {
    await ctx.stores.blocks.setState(ctx.userId, blockId, "skipped", {
      reason: REASON.noRoomLater,
      from: "planned",
    });
    return;
  }
  await ctx.stores.blocks.setTime(
    ctx.userId,
    blockId,
    isoAt(ctx, slot.startMs),
    isoAt(ctx, slot.startMs + lengthMs),
  );
}

// ---------------------------------------------------------------------- plan

/** Plans today and stores it. Shared by the tick's plan step and every answer. */
export async function planToday(ctx: EngineContext): Promise<PlanOutput> {
  const [day, existing, fixed, candidates, week] = await Promise.all([
    ctx.stores.days.get(ctx.userId, ctx.today),
    ctx.stores.blocks.listForDate(ctx.userId, ctx.today),
    ctx.fixedToday(),
    ctx.deps.loadCandidates(ctx.userId, ctx.user, ctx.now),
    weekBlocks(ctx).then((blocks) => weekStatsFromBlocks(ctx.today, blocks, ctx.rules)),
  ]);

  const out = planDay({
    date: ctx.today,
    now: ctx.now,
    rules: ctx.rules,
    energy: day?.energy ?? null,
    mode: day?.mode ?? "normal",
    fixed,
    candidates,
    week,
    existing,
  });

  // Only the planned rows are the plan's to write. A started, done or skipped
  // row records what he did and is never rewritten by a plan.
  await ctx.stores.blocks.replacePlanned(
    ctx.userId,
    ctx.today,
    out.blocks.filter((block) => block.state === "planned"),
  );
  // `energyAssumed` is deliberately NOT written here. The planner derives it
  // from `energy === null`, which the day row already says; the stored flag
  // means something narrower - the energy on the row was a default nobody
  // answered - and only `energy.set` knows that.
  await ctx.stores.days.patch(ctx.userId, ctx.today, {
    plannedAt: ctx.now,
    dropped: out.dropped,
    leaveBy: out.leaveBy,
  });
  return out;
}

// ---------------------------------------------------------------- deliveries

/**
 * Decides how an ask reaches him and stores it accordingly. `interrupt` is
 * queued for sending and spends the day's budget (the outbox counts items of
 * kind "ask"); `digest` is queued and shown on Today; `hold` queues nothing at
 * all, so the ask row itself is the record.
 */
async function deliverAsk(ctx: EngineContext, ask: Ask): Promise<Delivery> {
  const [day, interruptsSentToday, unansweredOnTopicThisWeek] = await Promise.all([
    ctx.stores.days.get(ctx.userId, ctx.today),
    ctx.stores.outbox.countInterruptsSince(ctx.userId, dayStart(ctx)),
    ctx.stores.asks.countUnanswered(ctx.userId, ask.topic, weekStart(ctx)),
  ]);

  const delivery = decideDelivery(ask, {
    now: ctx.now,
    rules: ctx.rules,
    interruptsSentToday,
    unansweredOnTopicThisWeek,
    // Nothing stores the week's answer rate yet, and "not known" is the value
    // the policy has for that; it halves no budget on a guess.
    weeklyAnswerRate: null,
    roughDay: (day?.mode ?? "normal") === "rough-day",
  });
  if (delivery === "hold") return delivery;

  await ctx.stores.outbox.enqueue(ctx.userId, {
    id: ctx.deps.newId(),
    userId: ctx.userId,
    kind: "ask",
    dedupeKey: `ask:${ask.id}`,
    delivery,
    message: askMessage(ask),
    askId: ask.id,
    createdAt: ctx.now,
    claimedAt: null,
    sentAt: null,
    chatMessageId: null,
    error: null,
  });
  return delivery;
}

/**
 * Quiet hours, asked of the one module that owns them. A probe ask goes to
 * `decideDelivery` with every other input neutral, so a "hold" can only be the
 * quiet-hours rule (asks/policy.ts checks it first) and, for kind
 * `night-guard`, cannot happen at all.
 */
function mayInterrupt(ctx: EngineContext, askKind: string | null): boolean {
  const probe: Ask = {
    id: "probe",
    userId: ctx.userId,
    kind: askKind ?? "probe",
    topic: "probe",
    text: "",
    options: [],
    defaultOptionId: "",
    timeCritical: true,
    openedAt: ctx.now,
    remindAt: null,
    remindedAt: null,
    expiresAt: ctx.now,
    status: "open",
    answeredOptionId: null,
    answeredAt: null,
    assumed: false,
    dedupeKey: "probe",
  };
  const delivery = decideDelivery(probe, {
    now: ctx.now,
    rules: ctx.rules,
    interruptsSentToday: 0,
    unansweredOnTopicThisWeek: 0,
    weeklyAnswerRate: null,
    roughDay: false,
  });
  return delivery !== "hold";
}

// -------------------------------------------------------------------- steps

async function expireAsks(ctx: EngineContext): Promise<void> {
  const open = await ctx.stores.asks.listOpen(ctx.userId);
  for (const due of expireDue(open, ctx.now)) {
    const expired = await ctx.stores.asks.expire(ctx.userId, due.ask.id, ctx.now);
    if (expired === null) continue; // another tick, or an answer, got there first
    if (!due.ask.options.some((option) => option.id === due.ask.defaultOptionId)) {
      // expireDue never throws for this, so it would otherwise be silent.
      console.warn(`v2 ask ${due.ask.id} (${due.ask.kind}) has no default option`);
    }
    // Nobody answered, so whatever the default decided was assumed.
    await applyEffect(ctx, due.effect, true);
  }
}

async function closeOut(ctx: EngineContext): Promise<void> {
  for (const block of await ctx.stores.blocks.listForDate(ctx.userId, ctx.today)) {
    if (block.state !== "started") continue;
    const endMs = maybeInstantMs(block.end);
    if (endMs === null || endMs > ctx.nowMs) continue;
    await ctx.stores.blocks.setState(ctx.userId, block.id, "done", { from: "started" });
  }
  // What an earlier day left open. Its plan is over either way.
  for (const block of await ctx.stores.blocks.listOpenBefore(ctx.userId, ctx.today)) {
    if (block.state === "planned") {
      await ctx.stores.blocks.setState(ctx.userId, block.id, "skipped", {
        reason: REASON.dayEnded,
        from: "planned",
      });
    } else if (block.state === "started") {
      await ctx.stores.blocks.setState(ctx.userId, block.id, "done", { from: "started" });
    }
  }
}

/**
 * The planner will not move a `planned` block that has already begun, so the
 * tick resolves it: ask once, wait while the question is open, and skip the
 * block when the question has already been answered for it (it was moved later
 * once and slipped again).
 *
 * `asks.insert` is both halves of "is there already an ask for this block?" and
 * "open one", in one statement, which is what makes a doubled tick harmless.
 */
async function resolveSlips(ctx: EngineContext): Promise<void> {
  const cutoff = ctx.nowMs - SLIP_GRACE_MINUTES * MINUTE_MS;
  const blocks = await ctx.stores.blocks.listForDate(ctx.userId, ctx.today);
  const open = await ctx.stores.asks.listOpen(ctx.userId);

  for (const block of blocks) {
    if (block.state !== "planned") continue;
    const startMs = maybeInstantMs(block.start);
    if (startMs === null || startMs > cutoff) continue;

    const draft = slipAsk(block, ctx.userId, ctx.rules, ctx.now);
    const { ask: candidate } = openAsk(draft, open, ctx.deps.newId);
    // Build the message from the ask the STORE returned: it can be one that
    // already existed, with a different id than the one just made.
    const { ask, created } = await ctx.stores.asks.insert(ctx.userId, candidate);
    if (created) {
      await deliverAsk(ctx, ask);
      continue;
    }
    if (ask.status === "open") continue;
    await ctx.stores.blocks.setState(ctx.userId, block.id, "skipped", {
      reason: REASON.slippedTwice,
      from: "planned",
    });
  }
}

function byStart(a: { start: Instant; id: string }, b: { start: Instant; id: string }): number {
  const left = maybeInstantMs(a.start) ?? 0;
  const right = maybeInstantMs(b.start) ?? 0;
  if (left !== right) return left < right ? -1 : 1;
  return compareText(a.id, b.id);
}

async function firstFixedLine(
  ctx: EngineContext,
): Promise<{ title: string; time: string; leaveBy: string | null } | null> {
  const fixed = (await ctx.fixedToday()).filter(
    (event) => !event.allDay && maybeInstantMs(event.start) !== null,
  );
  const first = [...fixed].sort(byStart)[0];
  if (first === undefined) return null;
  const leave = leaveByFor(fixed, ctx.rules).find((entry) => entry.fixedId === first.id) ?? null;
  return {
    title: first.title,
    time: clockLabel(first.start, ctx.rules.timeZone),
    leaveBy: leave === null ? null : clockLabel(leave.at, ctx.rules.timeZone),
  };
}

async function topBlockLine(
  ctx: EngineContext,
  state: TickState,
): Promise<{ title: string; time: string } | null> {
  const blocks =
    state.plan?.blocks ?? (await ctx.stores.blocks.listForDate(ctx.userId, ctx.today));
  const live = blocks.filter((block) => block.state === "planned" || block.state === "started");
  const first = [...live].sort(byStart)[0];
  if (first === undefined) return null;
  return { title: first.title, time: clockLabel(first.start, ctx.rules.timeZone) };
}

/**
 * Once a day, between that weekday's wake target and noon. The energy ask rides
 * on this message rather than going out as an ask of its own, which is why it
 * does not go through `deliverAsk` and does not spend the interrupt budget.
 */
async function sendMorning(ctx: EngineContext, state: TickState): Promise<void> {
  const wake = wallMinutes(
    ctx.rules.wakeByWeekday[weekdayOf(ctx.today)] ?? ctx.rules.wakeByWeekday[0],
  );
  const zone = ctx.rules.timeZone;
  if (
    ctx.nowMs < minutesToMs(ctx.today, wake, zone) ||
    ctx.nowMs >= minutesToMs(ctx.today, NOON_MINUTES, zone)
  ) {
    return;
  }

  const day = await ctx.stores.days.get(ctx.userId, ctx.today);
  if (day?.morningSentAt) return;

  let ask: Ask | null = null;
  if (!day?.energy) {
    const open = await ctx.stores.asks.listOpen(ctx.userId);
    const { ask: candidate } = openAsk(
      energyAsk(ctx.today, ctx.userId, ctx.rules, ctx.now),
      open,
      ctx.deps.newId,
    );
    const stored = await ctx.stores.asks.insert(ctx.userId, candidate);
    ask = stored.ask.status === "open" ? stored.ask : null;
  }

  const message = morningMessage({
    firstFixed: await firstFixedLine(ctx),
    top: await topBlockLine(ctx, state),
    feedLine: feedLine(await feedStatuses(ctx, state), ctx.user.rules.feedLabels, (at) =>
      sinceLabel(at, ctx.now, zone),
    ),
    energyAsk: ask,
  });

  await ctx.stores.outbox.enqueue(ctx.userId, {
    id: ctx.deps.newId(),
    userId: ctx.userId,
    kind: "morning",
    dedupeKey: `morning:${ctx.today}`,
    delivery: "interrupt",
    message,
    askId: ask?.id ?? null,
    createdAt: ctx.now,
    claimedAt: null,
    sentAt: null,
    chatMessageId: null,
    error: null,
  });
  await ctx.stores.days.patch(ctx.userId, ctx.today, { morningSentAt: ctx.now });
}

/**
 * The feeds, judged once per tick: the morning line and the watchdog step both
 * want them and they cost a read plus every probe.
 */
function feedStatuses(ctx: EngineContext, state: TickState): Promise<FeedStatus[]> {
  state.statuses ??= computeFeedStatuses(ctx);
  return state.statuses;
}

async function computeFeedStatuses(ctx: EngineContext): Promise<FeedStatus[]> {
  const [stored, expectations] = await Promise.all([
    ctx.stores.feeds.listRuns(ctx.userId, isoAt(ctx, ctx.nowMs - WATCHDOG_WINDOW_HOURS * HOUR_MS)),
    ctx.stores.feeds.listExpectations(ctx.userId),
  ]);

  const probed: FeedRun[] = [];
  for (const probe of ctx.deps.probes ?? []) {
    try {
      const run = await probe(ctx.userId, ctx.now);
      if (run !== null) probed.push(run);
    } catch (error) {
      // A probe that cannot look is not a watchdog that cannot run.
      logFailure(ctx.userId, "probe", error);
    }
  }

  // evaluateFeeds calls a feed with no finished run blind at once, so an
  // expectation is only judged once it has been enabled for longer than its
  // own interval plus grace.
  const judged = expectations.filter(
    (expectation) =>
      Date.parse(expectation.enabledAt) +
        (expectation.everyMinutes + expectation.graceMinutes) * MINUTE_MS <=
      ctx.nowMs,
  );
  return evaluateFeeds(judged, [...stored, ...probed], ctx.now, ctx.rules.timeZone);
}

function labelFor(ctx: EngineContext, feed: string): string {
  return ctx.user.rules.feedLabels[feed] ?? feed;
}

/**
 * What to call the thing that is wrong. A label configured for the cause wins;
 * otherwise the affected feeds name themselves, which reads better than an
 * error class and keeps the code out of the message.
 */
function causeLabel(ctx: EngineContext, alert: Alert): string {
  const configured = ctx.user.rules.feedLabels[alert.cause];
  if (configured !== undefined) return configured;
  const named = alert.feeds.map((feed) => labelFor(ctx, feed));
  return named.length === 1 ? named[0] : `${named.length} feeds`;
}

/**
 * The copy for an alert that cleared. messages.ts has no template for it, so it
 * is written here in the same voice as `feedLine`, which is the one place the
 * channel talks about feeds.
 */
function clearedMessage(ctx: EngineContext, alert: Alert): OutgoingMessage {
  const named = alert.feeds.map((feed) => labelFor(ctx, feed));
  return {
    text: named.length === 1 ? `I can see ${named[0]} again.` : `${named.length} feeds are back.`,
    buttons: [],
  };
}

async function shouldAnnounce(ctx: EngineContext, action: AlertAction): Promise<boolean> {
  if (action.type === "update") return false;
  if (action.type === "escalate") return true;
  // A close is only news to someone who heard the opening.
  if (action.type === "close") return action.alert.lastSentAt !== null;
  const last = await ctx.stores.alerts.lastAnnounced(ctx.userId, action.alert.cause);
  const lastSentAt = last?.lastSentAt ?? null;
  if (lastSentAt === null) return true;
  return ctx.nowMs - Date.parse(lastSentAt) >= ALERT_REOPEN_QUIET_HOURS * HOUR_MS;
}

async function applyAlertAction(ctx: EngineContext, action: AlertAction): Promise<void> {
  const announce = await shouldAnnounce(ctx, action);
  const alert: Alert = announce ? { ...action.alert, lastSentAt: ctx.now } : action.alert;
  // One open alert per cause is a database fact, so a tick that loses that race
  // stores nothing and announces nothing.
  const stored = await ctx.stores.alerts.save(ctx.userId, alert);
  if (!stored || !announce) return;

  await ctx.stores.outbox.enqueue(ctx.userId, {
    id: ctx.deps.newId(),
    userId: ctx.userId,
    kind: "alert",
    dedupeKey: `alert:${alert.id}:${action.type}:${alert.step}`,
    delivery: "interrupt",
    message:
      action.type === "close"
        ? clearedMessage(ctx, alert)
        : alertMessage({
            causeLabel: causeLabel(ctx, alert),
            affected: alert.feeds.length,
            days: daysSince(alert.since, ctx.now, ctx.rules.timeZone),
            fix: null,
          }),
    askId: null,
    createdAt: ctx.now,
    claimedAt: null,
    sentAt: null,
    chatMessageId: null,
    error: null,
  });
}

async function runWatchdog(ctx: EngineContext, state: TickState): Promise<void> {
  const statuses = await feedStatuses(ctx, state);
  const open = await ctx.stores.alerts.listOpen(ctx.userId);
  for (const action of planAlerts(statuses, open, ctx.now, ctx.deps.newId)) {
    await applyAlertAction(ctx, action);
  }
}

/** A short stable class, never a provider message. */
function telegramErrorClass(error: unknown): string {
  if (!(error instanceof TelegramError)) return "send-failed";
  if (error.status === null) return "no-response";
  if (error.status === 403) return "bot-blocked";
  if (error.status === 401) return "bad-token";
  if (error.status === 429) return "rate-limited";
  if (error.status >= 500) return "telegram-down";
  return `http-${error.status}`;
}

async function isNightGuard(ctx: EngineContext, item: OutboxItem): Promise<boolean> {
  if (item.askId === null) return false;
  const ask = await ctx.stores.asks.get(ctx.userId, item.askId);
  return ask !== null && mayInterrupt(ctx, ask.kind);
}

async function sendOutbox(ctx: EngineContext): Promise<void> {
  const link = await ctx.stores.channels.get(ctx.userId);
  const chatId = link?.chatId ?? null;
  const telegram = ctx.deps.telegram;

  const run = (status: FeedRun["status"], count: number, errorClass: string | null) =>
    ctx.stores.feeds.addRun(ctx.userId, {
      feed: TELEGRAM_FEED,
      startedAt: ctx.now,
      finishedAt: ctx.now,
      status,
      count,
      errorClass,
    });

  if (telegram === null || chatId === null) {
    await run("error", 0, NOT_LINKED);
    return;
  }

  const quiet = !mayInterrupt(ctx, null);
  let sent = 0;
  let errorClass: string | null = null;

  for (const item of await ctx.stores.outbox.listSendable(ctx.userId, "interrupt")) {
    if (quiet && !(await isNightGuard(ctx, item))) continue;
    // One conditional claim: two overlapping ticks send one message.
    const claimed = await ctx.stores.outbox.claim(ctx.userId, item.id, ctx.now);
    if (claimed === null) continue;
    try {
      const { messageId } = await telegram.sendMessage(chatId, claimed.message);
      await ctx.stores.outbox.markSent(ctx.userId, claimed.id, ctx.now, messageId);
      sent += 1;
    } catch (error) {
      const failure = telegramErrorClass(error);
      errorClass ??= failure;
      await ctx.stores.outbox.markFailed(ctx.userId, claimed.id, ctx.now, failure);
      logFailure(ctx.userId, "send", error);
    }
  }

  await run(errorClass === null ? "ok" : "error", sent, errorClass);
}

async function pruneRuns(ctx: EngineContext): Promise<void> {
  await ctx.stores.feeds.prune(
    ctx.userId,
    isoAt(ctx, ctx.nowMs - FEED_RUN_RETENTION_DAYS * DAY_MS),
  );
}

// ----------------------------------------------------------------- the tick

function tickSteps(
  ctx: EngineContext,
  state: TickState,
): Array<[string, () => Promise<void>]> {
  return [
    ["expire", () => expireAsks(ctx)],
    ["close-out", () => closeOut(ctx)],
    ["slips", () => resolveSlips(ctx)],
    [
      "plan",
      async () => {
        state.plan = await planToday(ctx);
      },
    ],
    ["morning", () => sendMorning(ctx, state)],
    ["watchdog", () => runWatchdog(ctx, state)],
    ["send", () => sendOutbox(ctx)],
    ["prune", () => pruneRuns(ctx)],
  ];
}

export async function runTick(
  deps: TickDeps,
  userId: string,
  now: Instant,
): Promise<TickResult> {
  const steps: Record<string, StepState> = {};
  let firstErrorClass: string | null = null;

  const record = (step: string, error: unknown): void => {
    if (error === null) {
      steps[step] = "ok";
      return;
    }
    steps[step] = "error";
    firstErrorClass ??= `${step}-failed`;
    logFailure(userId, step, error);
  };

  let ctx: EngineContext | null = null;
  try {
    ctx = await createEngineContext(deps, userId, now);
    record("load", null);
  } catch (error) {
    // Without rules there is no zone, so there is no step that could run. Every
    // other account's tick is unaffected: the cron route runs each in its own try.
    record("load", error);
  }

  if (ctx !== null) {
    const state: TickState = { plan: null, statuses: null };
    for (const [name, step] of tickSteps(ctx, state)) {
      try {
        await step();
        record(name, null);
      } catch (error) {
        record(name, error);
      }
    }
  }

  const ok = Object.values(steps).every((state) => state === "ok");
  try {
    await deps.stores.feeds.addRun(userId, {
      feed: ENGINE_TICK_FEED,
      startedAt: now,
      finishedAt: now,
      status: ok ? "ok" : "error",
      count: Object.values(steps).filter((state) => state === "ok").length,
      errorClass: ok ? null : firstErrorClass,
    });
  } catch (error) {
    logFailure(userId, ENGINE_TICK_FEED, error);
  }

  return { ok, steps };
}

// ---------------------------------------------------------------- the status

export interface TickStatus {
  ok: boolean;
  lastTickAt: Instant | null;
  staleMinutes: number | null;
}

/**
 * Is the clock running? The newest tick across the enabled accounts, and
 * nothing else: the status route is a monitoring endpoint, so it carries no per
 * account data at all.
 *
 * It reads per account rather than across the table on purpose: every query the
 * engine issues on the service client filters by user_id, and the one read that
 * crosses accounts (`users.listEnabled`) returns ids only.
 */
export async function tickStatus(stores: Stores, now: Instant): Promise<TickStatus> {
  const nowMs = Date.parse(now);
  const since = new Date(nowMs - WATCHDOG_WINDOW_HOURS * HOUR_MS).toISOString();
  let newest: number | null = null;

  for (const userId of await stores.users.listEnabled()) {
    const runs = await stores.feeds.listRuns(userId, since);
    for (const run of runs) {
      if (run.feed !== ENGINE_TICK_FEED) continue;
      const ms = Date.parse(run.startedAt);
      if (Number.isFinite(ms) && (newest === null || ms > newest)) newest = ms;
      break; // listRuns is newest first, so the first match is this account's
    }
  }

  if (newest === null) return { ok: false, lastTickAt: null, staleMinutes: null };
  const staleMinutes = Math.floor((nowMs - newest) / MINUTE_MS);
  return {
    ok: staleMinutes < TICK_STALE_MINUTES,
    lastTickAt: new Date(newest).toISOString(),
    staleMinutes,
  };
}
