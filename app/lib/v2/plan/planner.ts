// planDay: the whole day in one pure function. Fixed events and a ranked list
// of candidates in, blocks out, with a machine reason for everything it did and
// everything it could not do.
//
// It runs in two passes, and the order matters:
//
//   1. DEMAND. Walk the list in behaviour 4's order and turn it into requests
//      (what, how long, where it may land). Capacity and the per-lane limit are
//      decided here, so a lane's one pick is made once, not re-negotiated.
//   2. PLACEMENT. Give every request that matches a block already planned for
//      this day first refusal on its own slot, then fill the rest earliest-fit.
//
// Reserving before placing is what makes a replan calm. Placing strictly in
// priority order would let one new urgent block take 09:00 and push every block
// the user has already read down the day, which is behaviour 9's whole point:
// a planned block that is still demanded and still free keeps its time. A
// planned block whose start has already passed is not negotiable at all: it is
// held, exactly as a started or done one is.
//
// Everything in between is epoch milliseconds. Instants are only formatted at
// the edges, through the zone helpers in ./day.

import { zonedDateKey } from "@/app/lib/snapshots/zoned-time";
import { capRoomHours } from "@/app/lib/v2/plan/cap";
import {
  MINUTE_MS,
  carveIntervals,
  compareText,
  dayDiff,
  dayWindow,
  endWallTimeToMs,
  freeIntervals,
  instantMs,
  isoOf,
  leaveByFor,
  maybeInstantMs,
  wallTimeToMs,
  type MsInterval,
} from "@/app/lib/v2/plan/day";
import { rankCandidates, type RankedCandidate } from "@/app/lib/v2/plan/rank";
import type {
  Block,
  BlockKind,
  Candidate,
  Energy,
  LaneKey,
  PlanInput,
  PlanOutput,
} from "@/app/lib/v2/types";

/** Why a block is on the day. Short machine strings, never user copy. */
const REASON = {
  closesToday: "closes-today",
  hardWindow: "hard-window",
  earlyTouch: "early-touch",
  income: "income-target",
  laneNext: "lane-next",
  side: "side-quest",
  gym: "gym",
  floor: "floor",
} as const;

/** Why a candidate that was asked for is not on the day. */
const DROPPED = {
  noRoom: "no-room",
  capacity: "capacity",
  cap: "cap",
  laneLimit: "lane-limit",
  mode: "mode",
} as const;

const REMOVED = {
  notDemanded: "not-demanded",
  skipped: "skipped",
  replaced: "replaced",
} as const;

// The income and gym blocks come from the rules, not from a task, so they have
// no candidate id. They report under the same token their block id uses.
const INCOME_TOKEN = "income";
const INCOME_TITLE = "Income work";
const GYM_TITLE = "Gym";

type Budget = "blocks" | "small" | "free";

interface Request {
  blockId: string;
  /** What `dropped` calls this: the candidate id, or the block's own token. */
  dropId: string;
  taskId: string | null;
  title: string;
  lane: LaneKey | null;
  kind: BlockKind;
  minutes: number;
  reason: string;
  fit: "earliest" | "latest";
  earliestMs: number;
  latestMs: number;
  /** Set only for a session: the fallback looks before this instant. */
  relaxBeforeMs: number | null;
  budget: Budget;
  /**
   * Steps 1 and 2: never dropped for capacity, although each still spends its
   * unit, and placed before the floor claims its span. Every later step is
   * optional and yields to the floor.
   */
  mandatory: boolean;
  allowProtected: boolean;
}

function blockLengthMs(block: Block): number {
  const startMs = maybeInstantMs(block.start);
  const endMs = maybeInstantMs(block.end);
  if (startMs === null || endMs === null) return 0;
  return Math.max(0, endMs - startMs);
}

// A started or done block spends the same capacity a planned one would. The
// floor and the gym sit outside the block budget: capacity.blocks is counted
// "on top of the floor block", and the gym has its own flag.
function budgetOf(kind: BlockKind): Budget {
  if (kind === "small") return "small";
  if (kind === "floor" || kind === "gym") return "free";
  return "blocks";
}

function fitEarliest(
  pool: MsInterval[],
  lengthMs: number,
  lo: number,
  hi: number,
): MsInterval | null {
  for (const interval of pool) {
    const start = Math.max(interval.startMs, lo);
    const end = Math.min(interval.endMs, hi);
    if (end - start >= lengthMs) {
      return { startMs: start, endMs: start + lengthMs };
    }
  }
  return null;
}

function fitLatest(
  pool: MsInterval[],
  lengthMs: number,
  lo: number,
  hi: number,
): MsInterval | null {
  for (let i = pool.length - 1; i >= 0; i--) {
    const start = Math.max(pool[i].startMs, lo);
    const end = Math.min(pool[i].endMs, hi);
    if (end - start >= lengthMs) {
      return { startMs: end - lengthMs, endMs: end };
    }
  }
  return null;
}

// Behaviour 4.1's fallback: when the reserved evening window cannot hold the
// session, take the latest free interval that still ends before closing and
// holds at least a floor block, end-aligned so the work sits against the
// deadline. earliestStart and latestEnd are given up here on purpose.
function fitBeforeClosing(
  pool: MsInterval[],
  request: Request,
  floorMs: number,
): MsInterval | null {
  if (request.relaxBeforeMs === null) return null;
  const wanted = request.minutes * MINUTE_MS;
  const least = Math.min(wanted, floorMs);
  for (let i = pool.length - 1; i >= 0; i--) {
    const end = Math.min(pool[i].endMs, request.relaxBeforeMs);
    const available = end - pool[i].startMs;
    if (available >= least) {
      const length = Math.min(wanted, available);
      return { startMs: end - length, endMs: end };
    }
  }
  return null;
}

export function planDay(input: PlanInput): PlanOutput {
  const { date, rules, fixed, week, mode } = input;
  const zone = rules.timeZone;
  const energyUsed: Energy = input.energy ?? "ok";
  const energyAssumed = input.energy === null;
  const capacity = rules.capacity[energyUsed];

  // Round now up to a whole minute: a block start is formatted without
  // milliseconds, so a plan fed its own output would otherwise read the start
  // back a fraction earlier and report a move that never happened.
  const nowMs = Math.ceil(instantMs(input.now) / MINUTE_MS) * MINUTE_MS;

  const buffer = rules.bufferMinutes * MINUTE_MS;
  const floorMs = rules.blockMinutes.floor * MINUTE_MS;
  const standard = rules.blockMinutes.standard;
  const lightMode = mode === "short-night" || mode === "rough-day";

  // ------------------------------------------------------------ what is there
  // Held blocks are the ones the planner may not touch: started, done, and any
  // planned block that has already begun. A block whose moment has come is the
  // caller's to resolve (it asks, and sets a state or a new time); moving it
  // under the user while it is running, or after it was missed, is not the
  // planner's call. It stays verbatim, is busy until its end, and its task is
  // not planned a second time today.
  const own = input.existing.filter((block) => block.date === date);
  const hasBegun = (block: Block) => (maybeInstantMs(block.start) ?? 0) <= nowMs;
  const held = own.filter(
    (block) =>
      block.state === "started" ||
      block.state === "done" ||
      (block.state === "planned" && hasBegun(block)),
  );
  const skippedBlocks = own.filter((block) => block.state === "skipped");
  const previous = own.filter(
    (block) => block.state === "planned" && !hasBegun(block),
  );
  const previousById = new Map(previous.map((block) => [block.id, block]));

  const skippedTaskIds = new Set(
    skippedBlocks
      .map((block) => block.taskId)
      .filter((id): id is string => id !== null),
  );
  const servedTaskIds = new Set(
    held.map((block) => block.taskId).filter((id): id is string => id !== null),
  );
  // The income and gym blocks carry no task, so "this task already has its
  // block" cannot speak for them. Their block id does: a day that already
  // holds, or has skipped, the block a demand would create does not get a
  // second one with the same id.
  const spokenFor = new Set(
    [...held, ...skippedBlocks].map((block) => block.id),
  );

  // Behaviour 3: a task with a skipped block today is not planned again today,
  // and it leaves the ranking entirely, so the floor moves to the next one.
  const eligible = input.candidates.filter(
    (candidate) => !skippedTaskIds.has(candidate.id),
  );

  // Behaviour 11. Ranking is relative to the day being planned, not to the
  // clock: the reference instant is the later of `now` and the start of the
  // planned day's window, on every day. Taking `now` whenever it is the same
  // day made a block vanish and come back across midnight — before wake, `now`
  // is EARLIER than the window start the night-before draft used, so the hard
  // window shrank at midnight and grew again at wake, and a lane's second item
  // lost and regained its block.
  // `date` and not the reference instant's own day: once lights out is after
  // midnight the two differ, and "closes today" has to mean the day being
  // planned (plan/rank.ts says why).
  const window = dayWindow(date, rules);
  const reference = isoOf(Math.max(nowMs, window.startMs), rules);
  const ranked = rankCandidates(eligible, reference, rules, date);

  let blocksLeft = capacity.blocks;
  let smallLeft = capacity.small;
  const laneUsed = new Map<LaneKey, number>();
  const takeLane = (lane: LaneKey | null) => {
    if (lane !== null) laneUsed.set(lane, (laneUsed.get(lane) ?? 0) + 1);
  };
  const laneFull = (lane: LaneKey | null) =>
    lane !== null &&
    (laneUsed.get(lane) ?? 0) >= rules.maxBlocksPerLanePerDay;

  for (const block of held) {
    const budget = budgetOf(block.kind);
    if (budget === "blocks") blocksLeft -= 1;
    if (budget === "small") smallLeft -= 1;
    // A session is exempt from the lane limit, so it does not take the slot.
    if (block.kind !== "session") takeLane(block.lane);
  }

  // ------------------------------------------------------------------ reports
  const dropped: PlanOutput["dropped"] = [];
  const drop = (candidateId: string, reason: string) => {
    if (!dropped.some((entry) => entry.candidateId === candidateId)) {
      dropped.push({ candidateId, reason });
    }
  };
  const undrop = (candidateId: string) => {
    const at = dropped.findIndex((entry) => entry.candidateId === candidateId);
    if (at >= 0) dropped.splice(at, 1);
  };

  // ------------------------------------------------------------------- demand
  const requests: Request[] = [];
  const demanded = new Set<string>();
  const openFor = (candidate: Candidate) =>
    !servedTaskIds.has(candidate.id) && !demanded.has(candidate.id);
  const inTier = (tier: RankedCandidate["tier"]) =>
    ranked.filter((entry) => entry.tier === tier && openFor(entry.candidate));

  const blockId = (kind: BlockKind, taskId: string | null) =>
    `${date}:${kind}:${taskId ?? kind}`;

  const demand = (
    request: Omit<Request, "blockId" | "dropId"> & { dropId?: string },
  ) => {
    const full: Request = {
      ...request,
      blockId: blockId(request.kind, request.taskId),
      dropId: request.dropId ?? request.taskId ?? request.kind,
    };
    if (full.taskId !== null) demanded.add(full.taskId);
    // The day already holds this exact block, so it keeps it rather than
    // getting a second one. The held copy has already taken its lane slot.
    if (spokenFor.has(full.blockId)) return;
    requests.push(full);
    if (full.kind !== "session") takeLane(full.lane);
  };

  // 1. An item that closes today gets its session, placed as late as it fits.
  for (const { candidate } of inTier("due-today")) {
    const dueMs = maybeInstantMs(candidate.due);
    if (dueMs === null) continue;
    demand({
      taskId: candidate.id,
      title: candidate.title,
      lane: candidate.lane,
      kind: "session",
      minutes: Math.min(
        rules.deadlineDay.sessionMinutes,
        candidate.minutes ?? Number.POSITIVE_INFINITY,
      ),
      reason: REASON.closesToday,
      fit: "latest",
      earliestMs: wallTimeToMs(date, rules.deadlineDay.earliestStart, zone),
      latestMs: Math.min(
        dueMs - buffer,
        endWallTimeToMs(date, rules.deadlineDay.latestEnd, zone),
      ),
      relaxBeforeMs: dueMs - buffer,
      budget: "blocks",
      mandatory: true,
      allowProtected: true,
    });
  }

  if (lightMode) {
    // Behaviour 7: a short night or a rough day keeps step 1 and the floor.
    for (const { candidate, tier } of ranked) {
      if (tier === "due-today" || servedTaskIds.has(candidate.id)) continue;
      drop(candidate.id, DROPPED.mode);
    }
  } else {
    // 2. Any other hard-window item: a touch until it has been read, then a
    //    standard block. Exempt from the per-lane limit.
    for (const { candidate } of inTier("hard-window")) {
      const touch = !candidate.earlyTouchDone;
      demand({
        taskId: candidate.id,
        title: candidate.title,
        lane: candidate.lane,
        kind: touch ? "touch" : "focus",
        minutes: touch
          ? rules.earlyTouch.minutes
          : Math.min(standard, candidate.minutes ?? Number.POSITIVE_INFINITY),
        reason: REASON.hardWindow,
        fit: "earliest",
        earliestMs: Number.NEGATIVE_INFINITY,
        latestMs: Number.POSITIVE_INFINITY,
        relaxBeforeMs: null,
        budget: "blocks",
        mandatory: true,
        allowProtected: false,
      });
    }

    // 3. A hard item outside the window but closing within the early-touch
    //    days. Counted in calendar days, because in hours the default three
    //    days is the hard window itself and the step would be unreachable.
    for (const { candidate, tier } of ranked) {
      if (tier !== "lane-step" && tier !== "side") continue;
      if (!openFor(candidate)) continue;
      if (!candidate.hard || candidate.earlyTouchDone) continue;
      const dueMs = maybeInstantMs(candidate.due);
      if (dueMs === null) continue;
      const days = dayDiff(date, zonedDateKey(dueMs, zone));
      if (days < 0 || days > rules.earlyTouch.daysBefore) continue;
      if (laneFull(candidate.lane)) {
        drop(candidate.id, DROPPED.laneLimit);
        continue;
      }
      demand({
        taskId: candidate.id,
        title: candidate.title,
        lane: candidate.lane,
        kind: "touch",
        minutes: rules.earlyTouch.minutes,
        reason: REASON.earlyTouch,
        fit: "earliest",
        earliestMs: Number.NEGATIVE_INFINITY,
        latestMs: Number.POSITIVE_INFINITY,
        relaxBeforeMs: null,
        budget: "blocks",
        mandatory: false,
        allowProtected: false,
      });
    }

    // 4. Income, while the weekly target has not been reached. It is the only
    //    demand the cap can veto, and travel lifts the cap entirely.
    const target = rules.incomeTarget;
    if (target !== null && (mode === "normal" || mode === "travel")) {
      const remaining = (target.weeklyHours - week.incomeHoursElsewhere) * 60;
      if (remaining > 0) {
        const minutes = Math.max(
          standard,
          Math.min(target.blockMinutes, remaining),
        );
        const room =
          mode === "travel"
            ? Number.POSITIVE_INFINITY
            : capRoomHours(date, fixed, week, rules) * 60;
        if (room < minutes) {
          drop(INCOME_TOKEN, DROPPED.cap);
        } else {
          demand({
            taskId: null,
            title: INCOME_TITLE,
            lane: target.lane,
            kind: "income",
            minutes,
            reason: REASON.income,
            fit: "earliest",
            earliestMs: Number.NEGATIVE_INFINITY,
            latestMs: Number.POSITIVE_INFINITY,
            relaxBeforeMs: null,
            budget: "blocks",
            mandatory: false,
            allowProtected: false,
          });
        }
      }
    }

    // 5. One focus block per lane for the remaining steps. A candidate with no
    //    lane has no lane to limit, so capacity is the only thing bounding it.
    const steps = inTier("lane-step").sort((a, b) => {
      const dueA = maybeInstantMs(a.candidate.due) ?? Number.POSITIVE_INFINITY;
      const dueB = maybeInstantMs(b.candidate.due) ?? Number.POSITIVE_INFINITY;
      if (dueA !== dueB) return dueA < dueB ? -1 : 1;
      // Behaviour 4.5: a low day prefers the cheapest work. An unknown cost is
      // not evidence of a cheap task, so it sorts last.
      if (energyUsed === "low") {
        const costA = a.candidate.energyCost ?? Number.POSITIVE_INFINITY;
        const costB = b.candidate.energyCost ?? Number.POSITIVE_INFINITY;
        if (costA !== costB) return costA < costB ? -1 : 1;
      }
      return compareText(a.candidate.id, b.candidate.id);
    });
    for (const { candidate } of steps) {
      if (laneFull(candidate.lane)) {
        drop(candidate.id, DROPPED.laneLimit);
        continue;
      }
      demand({
        taskId: candidate.id,
        title: candidate.title,
        lane: candidate.lane,
        kind: "focus",
        minutes: Math.min(
          standard,
          candidate.minutes ?? Number.POSITIVE_INFINITY,
        ),
        reason: REASON.laneNext,
        fit: "earliest",
        earliestMs: Number.NEGATIVE_INFINITY,
        latestMs: Number.POSITIVE_INFINITY,
        relaxBeforeMs: null,
        budget: "blocks",
        mandatory: false,
        allowProtected: false,
      });
    }

    // 6. Side quests, soonest to expire first, pinned ones last.
    for (const { candidate } of inTier("side")) {
      if (laneFull(candidate.lane)) {
        drop(candidate.id, DROPPED.laneLimit);
        continue;
      }
      const small = candidate.minutes !== null && candidate.minutes <= 10;
      demand({
        taskId: candidate.id,
        title: candidate.title,
        lane: candidate.lane,
        kind: small ? "small" : "focus",
        minutes: small
          ? (candidate.minutes as number)
          : Math.min(standard, candidate.minutes ?? Number.POSITIVE_INFINITY),
        reason: REASON.side,
        fit: "earliest",
        earliestMs: Number.NEGATIVE_INFINITY,
        latestMs: Number.POSITIVE_INFINITY,
        relaxBeforeMs: null,
        budget: small ? "small" : "blocks",
        mandatory: false,
        allowProtected: false,
      });
    }

    // 7. The gym, when the day's capacity allows one and the week has room.
    if (
      mode !== "travel" &&
      rules.gym !== null &&
      capacity.gym &&
      week.gymSessionsDone < rules.gym.perWeek
    ) {
      demand({
        taskId: null,
        title: GYM_TITLE,
        lane: null,
        kind: "gym",
        minutes: rules.gym.minutes,
        reason: REASON.gym,
        fit: "earliest",
        earliestMs: wallTimeToMs(date, rules.gym.notBefore, zone),
        latestMs: Number.POSITIVE_INFINITY,
        relaxBeforeMs: null,
        // Its gate is capacity[energy].gym, not the block budget, so there is
        // nothing for "mandatory" to exempt it from. Step 7 is optional.
        budget: "free",
        mandatory: false,
        allowProtected: false,
      });
    }
  }

  // ---------------------------------------------------------------- placement
  const heldBusy = held.map((block) => ({
    startMs: (maybeInstantMs(block.start) ?? 0) - buffer,
    endMs: (maybeInstantMs(block.end) ?? 0) + buffer,
  }));
  let openPool = carveIntervals(
    freeIntervals(date, fixed, rules, { fromMs: nowMs, allowProtected: true }),
    heldBusy,
  );
  let strictPool = carveIntervals(
    freeIntervals(date, fixed, rules, { fromMs: nowMs, allowProtected: false }),
    heldBusy,
  );

  const pad = (span: MsInterval): MsInterval => ({
    startMs: span.startMs - buffer,
    endMs: span.endMs + buffer,
  });
  const overlaps = (a: MsInterval, b: MsInterval) =>
    a.startMs < b.endMs && b.startMs < a.endMs;

  const reserved = new Map<string, MsInterval>();
  const reservationFor = (request: Request): MsInterval | null => {
    const prev = previousById.get(request.blockId);
    if (prev === undefined) return null;
    const startMs = maybeInstantMs(prev.start);
    if (startMs === null) return null;
    const span = { startMs, endMs: startMs + request.minutes * MINUTE_MS };
    if (span.startMs < request.earliestMs || span.endMs > request.latestMs) {
      return null;
    }
    const pool = request.allowProtected ? openPool : strictPool;
    const free = pool.some(
      (interval) =>
        interval.startMs <= span.startMs && interval.endMs >= span.endMs,
    );
    if (!free) return null;
    for (const other of reserved.values()) {
      if (overlaps(pad(span), other)) return null;
    }
    return span;
  };

  for (const request of requests) {
    const span = reservationFor(request);
    if (span !== null) reserved.set(request.blockId, span);
  }

  const placed: Block[] = [];

  // Every span this request could take, in placement order: one per free
  // interval, earliest interval first (latest first for a session), then the
  // session's relaxed fit. The first entry is the plain earliest or latest fit,
  // so a request that has nothing to dodge is placed exactly as before.
  const fitsFor = (request: Request, pool: MsInterval[]): MsInterval[] => {
    const lengthMs = request.minutes * MINUTE_MS;
    const order = request.fit === "latest" ? [...pool].reverse() : pool;
    const out: MsInterval[] = [];
    for (const interval of order) {
      const one =
        request.fit === "latest"
          ? fitLatest([interval], lengthMs, request.earliestMs, request.latestMs)
          : fitEarliest(
              [interval],
              lengthMs,
              request.earliestMs,
              request.latestMs,
            );
      if (one !== null) out.push(one);
    }
    const relaxed = fitBeforeClosing(pool, request, floorMs);
    if (relaxed !== null) out.push(relaxed);
    return out;
  };

  // Behaviour 6's priority half. The top-ranked candidate is owed a block of at
  // least floor length, and that outranks every non-mandatory block: a 10
  // minute side quest may not take the day's last gap and leave the floor with
  // nowhere to go, which is exactly the "day with no room" the spec calls the
  // most likely to bite.
  //
  // It is enforced where the risk is, at the moment an optional block is about
  // to be committed, and NOT by setting a span aside in advance. Holding a span
  // ahead of time changes plans that were never in danger: an earlier optional
  // step (income is step 4, lane steps are step 5) gets pushed past the held
  // span, the top candidate's longer block then cannot use it, and the span is
  // released empty. It also made future blocks drift as the clock advanced.
  const top = ranked[0]?.candidate;
  const topEnough =
    top === undefined
      ? 0
      : Math.min(
          floorMs,
          (top.minutes ?? Number.POSITIVE_INFINITY) * MINUTE_MS,
        );
  const topServed = () =>
    top !== undefined &&
    [...held, ...placed].some(
      (block) => block.taskId === top.id && blockLengthMs(block) >= topEnough,
    );
  const floorBlockId = top === undefined ? null : blockId("floor", top.id);
  const requestById = new Map(
    requests.map((request) => [request.blockId, request]),
  );

  /** The slot the top candidate is holding for itself, when it would serve it. */
  const topReservation = (): MsInterval | null => {
    if (top === undefined) return null;
    for (const [id, span] of reserved) {
      if (requestById.get(id)?.taskId !== top.id) continue;
      if (span.endMs - span.startMs >= topEnough) return span;
    }
    return null;
  };

  // The guard is off unless the floor is genuinely at risk: the top candidate
  // has nothing yet and no floor block of its own is already on the day.
  const floorAtRisk = () =>
    top !== undefined &&
    floorBlockId !== null &&
    !spokenFor.has(floorBlockId) &&
    !topServed();

  /** Would a floor block still fit somewhere once this span is taken? */
  const leavesFloorRoom = (span: MsInterval) =>
    carveIntervals(strictPool, [pad(span)]).some(
      (interval) => interval.endMs - interval.startMs >= floorMs,
    );

  const commitOrDrop = (request: Request, pending: MsInterval[]) => {
    if (!request.mandatory) {
      if (request.budget === "blocks" && blocksLeft <= 0) {
        reserved.delete(request.blockId);
        drop(request.dropId, DROPPED.capacity);
        return;
      }
      if (request.budget === "small" && smallLeft <= 0) {
        reserved.delete(request.blockId);
        drop(request.dropId, DROPPED.capacity);
        return;
      }
    }

    const pool = request.allowProtected ? openPool : strictPool;
    let span = reserved.get(request.blockId) ?? null;
    if (span === null) {
      // Behaviour 6's priority half. An optional block that is not the top
      // candidate's own may not take what the top candidate still needs; it
      // moves to its next fit, and is dropped when none leaves room. What it
      // needs is the slot it is already holding if it has one, otherwise room
      // for a floor block anywhere in its pool. The check is skipped entirely
      // when the floor is not at risk, so a normal day is placed exactly as it
      // would be without it.
      const guarded =
        !request.mandatory &&
        request.taskId !== (top?.id ?? null) &&
        floorAtRisk();
      // A slot the top candidate holds is off limits in BOTH rounds, so the
      // second one cannot land on it and delete the reservation. Deciding this
      // once, before anything is placed, also keeps a replan identical to a
      // fresh plan of the same day.
      const sacred = guarded ? topReservation() : null;
      const offLimits = sacred === null ? [] : [pad(sacred)];

      // First try around the slots other blocks are holding; only if nothing
      // fits does this request take space one of them was keeping, and that
      // block then re-places and shows up in `moved`.
      for (const candidatePool of [
        carveIntervals(pool, [...pending, ...offLimits]),
        carveIntervals(pool, offLimits),
      ]) {
        for (const fit of fitsFor(request, candidatePool)) {
          // With a slot of its own already protected, the floor's room is that
          // slot: the two are alternatives, not both.
          if (guarded && sacred === null && !leavesFloorRoom(fit)) continue;
          span = fit;
          break;
        }
        if (span !== null) break;
      }
    }
    reserved.delete(request.blockId);
    if (span === null) {
      drop(request.dropId, DROPPED.noRoom);
      return;
    }

    placed.push({
      id: request.blockId,
      date,
      start: isoOf(span.startMs, rules),
      end: isoOf(span.endMs, rules),
      kind: request.kind,
      lane: request.lane,
      taskId: request.taskId,
      title: request.title,
      state: "planned",
      reason: request.reason,
    });

    const padded = pad(span);
    for (const [id, other] of [...reserved]) {
      if (overlaps(padded, other)) reserved.delete(id);
    }
    openPool = carveIntervals(openPool, [padded]);
    strictPool = carveIntervals(strictPool, [padded]);
    if (request.budget === "blocks") blocksLeft -= 1;
    if (request.budget === "small") smallLeft -= 1;
    undrop(request.dropId);
  };

  const pendingAfter = (from: number): MsInterval[] => {
    const out: MsInterval[] = [];
    for (let i = from; i < requests.length; i++) {
      const span = reserved.get(requests[i].blockId);
      if (span !== undefined) out.push(pad(span));
    }
    return out;
  };

  for (let i = 0; i < requests.length; i++) {
    commitOrDrop(requests[i], pendingAfter(i + 1));
  }

  // Behaviour 6. There is always one block of at least floor length on the
  // top-ranked candidate, whatever capacity said, and none at all when there
  // are no candidates. Whether one is needed can only be read from what
  // actually landed, so the block is cut here, in the room the guard above kept
  // open for it. A candidate that says it takes five minutes is served by its
  // own five minute block: a 25 minute floor block beside it would book the
  // same work twice.
  if (top !== undefined && floorBlockId !== null) {
    if (!topServed() && !spokenFor.has(floorBlockId)) {
      const floorRequest: Request = {
        blockId: floorBlockId,
        dropId: top.id,
        taskId: top.id,
        title: top.title,
        lane: top.lane,
        kind: "floor",
        minutes: rules.blockMinutes.floor,
        reason: REASON.floor,
        fit: "earliest",
        earliestMs: Number.NEGATIVE_INFINITY,
        latestMs: Number.POSITIVE_INFINITY,
        relaxBeforeMs: null,
        budget: "free",
        mandatory: true,
        allowProtected: false,
      };
      const kept = reservationFor(floorRequest);
      if (kept !== null) reserved.set(floorRequest.blockId, kept);
      commitOrDrop(floorRequest, []);
    }
  }

  // ------------------------------------------------------------------ outputs
  const blocks = [...held, ...skippedBlocks, ...placed].sort((a, b) => {
    const startA = maybeInstantMs(a.start) ?? 0;
    const startB = maybeInstantMs(b.start) ?? 0;
    if (startA !== startB) return startA < startB ? -1 : 1;
    return compareText(a.id, b.id);
  });

  const moved: PlanOutput["moved"] = [];
  for (const block of placed) {
    const prev = previousById.get(block.id);
    if (prev === undefined) continue;
    if (maybeInstantMs(prev.start) === maybeInstantMs(block.start)) continue;
    moved.push({ blockId: block.id, from: prev.start, to: block.start });
  }

  const placedIds = new Set(placed.map((block) => block.id));
  const removed: PlanOutput["removed"] = [];
  for (const prev of previous) {
    if (placedIds.has(prev.id)) continue;
    const token = prev.taskId ?? prev.kind;
    // A task that is still on the day under another block id was not dropped:
    // its block changed shape (a focus that became a floor block, say), so
    // "not-demanded" would read as if the work had gone away.
    const replaced =
      prev.taskId !== null &&
      placed.some((block) => block.taskId === prev.taskId);
    const reason =
      prev.taskId !== null && skippedTaskIds.has(prev.taskId)
        ? REMOVED.skipped
        : replaced
          ? REMOVED.replaced
          : (dropped.find((entry) => entry.candidateId === token)?.reason ??
            REMOVED.notDemanded);
    removed.push({ blockId: prev.id, reason });
  }

  return {
    date,
    blocks,
    dropped,
    moved,
    removed,
    leaveBy: leaveByFor(fixed, rules),
    energyUsed,
    energyAssumed,
    mode,
  };
}
