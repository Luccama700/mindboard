// Task 2, the planner: one test per numbered behaviour in the brief, plus the
// whole-day invariants. 2026-03-10 is a Tuesday (weekday 2) and the default
// rules put the window at 09:00 to 23:00 with a 10 minute buffer, so every
// clock in here is readable against that.

import { describe, expect, test } from "vitest";

import { zonedClock, zonedDateKey } from "@/app/lib/snapshots/zoned-time";
import { parseRules } from "@/app/lib/v2/rules";
import { dayWindow } from "@/app/lib/v2/plan/day";
import { planDay } from "@/app/lib/v2/plan/planner";
import type {
  Block,
  Candidate,
  FixedEvent,
  PlanInput,
  PlanOutput,
  WeekStats,
} from "@/app/lib/v2/types";

const DATE = "2026-03-10";
const NOW = "2026-03-10T09:00:00+00:00";

const utc = (clock: string, date = DATE) => `${date}T${clock}:00+00:00`;
const clockOf = (iso: string, zone = "UTC") =>
  zonedClock(Date.parse(iso), zone);
const shape = (b: Block) => `${b.kind} ${clockOf(b.start)}-${clockOf(b.end)}`;
const shapes = (out: PlanOutput) => out.blocks.map(shape);
const ids = (out: PlanOutput) => out.blocks.map((b) => b.id);

function candidate(over: Partial<Candidate> & { id: string }): Candidate {
  return {
    title: over.title ?? `Task ${over.id}`,
    lane: over.lane ?? null,
    kind: over.kind ?? "step",
    due: over.due ?? null,
    hard: over.hard ?? false,
    minutes: over.minutes ?? null,
    energyCost: over.energyCost ?? null,
    expiresAt: over.expiresAt ?? null,
    pinned: over.pinned ?? false,
    earlyTouchDone: over.earlyTouchDone ?? false,
    id: over.id,
  };
}

function event(
  over: Partial<FixedEvent> & { start: string; end: string },
): FixedEvent {
  return {
    id: over.id ?? "fixed-1",
    title: over.title ?? "Class",
    allDay: over.allDay ?? false,
    calendarId: over.calendarId ?? null,
    location: over.location ?? null,
    countsTowardCap: over.countsTowardCap ?? false,
    source: over.source ?? "google",
    start: over.start,
    end: over.end,
  };
}

const week = (over: Partial<WeekStats> = {}): WeekStats => ({
  capHoursElsewhere: over.capHoursElsewhere ?? 0,
  incomeHoursElsewhere: over.incomeHoursElsewhere ?? 0,
  gymSessionsDone: over.gymSessionsDone ?? 0,
});

function input(over: Partial<PlanInput> = {}): PlanInput {
  return {
    date: DATE,
    now: NOW,
    rules: parseRules({}),
    energy: "ok",
    mode: "normal",
    fixed: [],
    candidates: [],
    week: week(),
    existing: [],
    ...over,
  };
}

// Every block the plan owns must sit inside one free interval: no two blocks
// overlap, and no block touches a fixed event's buffered span.
function assertNoOverlap(out: PlanOutput, fixed: FixedEvent[], buffer = 10) {
  const owned = out.blocks
    .filter((b) => b.state !== "skipped")
    .map((b) => ({ start: Date.parse(b.start), end: Date.parse(b.end) }))
    .sort((a, b) => a.start - b.start);
  for (let i = 1; i < owned.length; i++) {
    expect(owned[i].start).toBeGreaterThanOrEqual(owned[i - 1].end);
  }
  for (const e of fixed) {
    if (e.allDay) continue;
    const lo = Date.parse(e.start) - buffer * 60_000;
    const hi = Date.parse(e.end) + buffer * 60_000;
    for (const b of owned) {
      expect(b.start >= hi || b.end <= lo).toBe(true);
    }
  }
}

describe("behaviour 1: the window", () => {
  test("behaviour 1: the window runs from the later of now, the wake target and noFocusBefore to lights out", () => {
    const one = [candidate({ id: "a" })];

    // Before the window: the first block waits for noFocusBefore.
    expect(
      shapes(planDay(input({ now: utc("07:15"), candidates: one }))),
    ).toEqual(["focus 09:00-09:50"]);

    // Inside the window: the first block starts at now.
    expect(
      shapes(planDay(input({ now: utc("10:30"), candidates: one }))),
    ).toEqual(["focus 10:30-11:20"]);

    // A wake target later than noFocusBefore wins.
    const lateWake = parseRules({
      wakeByWeekday: [
        "11:30",
        "10:30",
        "11:00",
        "10:30",
        "09:30",
        "10:30",
        "11:30",
      ],
    });
    expect(
      shapes(planDay(input({ rules: lateWake, candidates: one }))),
    ).toEqual(["focus 11:00-11:50"]);

    // Nothing crosses lights out: a standard block no longer fits, and once
    // even the floor does not fit the candidate is dropped.
    expect(
      shapes(planDay(input({ now: utc("22:30"), candidates: one }))),
    ).toEqual(["floor 22:30-22:55"]);
    const tooLate = planDay(input({ now: utc("22:50"), candidates: one }));
    expect(tooLate.blocks).toEqual([]);
    expect(tooLate.dropped).toEqual([{ candidateId: "a", reason: "no-room" }]);
  });

  test("lights out after midnight keeps the evening usable", () => {
    const out = planDay(
      input({
        now: utc("23:30"),
        rules: parseRules({ lightsOut: "01:00" }),
        candidates: [candidate({ id: "a" })],
      }),
    );
    expect(shapes(out)).toEqual(["focus 23:30-00:20"]);
    expect(out.blocks[0].date).toBe(DATE);
  });
});

describe("behaviour 2: busy time", () => {
  test("behaviour 2: every timed fixed event is busy with travel and buffer, all-day events are not", () => {
    const fixed = [
      event({ start: utc("09:00"), end: utc("12:00") }),
      event({
        id: "holiday",
        allDay: true,
        start: utc("00:00"),
        end: utc("00:00", "2026-03-11"),
      }),
    ];
    const out = planDay(input({ fixed, candidates: [candidate({ id: "a" })] }));
    expect(shapes(out)).toEqual(["focus 12:10-13:00"]);
    assertNoOverlap(out, fixed);
  });

  test("travel widens the event by the first matching rule", () => {
    const rules = parseRules({
      travel: [
        {
          calendarId: null,
          locationIncludes: "campus",
          minutesBefore: 30,
          minutesAfter: 30,
        },
      ],
    });
    const fixed = [
      event({ start: utc("09:00"), end: utc("12:00"), location: "Campus" }),
    ];
    const out = planDay(
      input({ rules, fixed, candidates: [candidate({ id: "a" })] }),
    );
    expect(shapes(out)).toEqual(["focus 12:40-13:30"]);
    expect(out.leaveBy).toEqual([
      { fixedId: "fixed-1", at: "2026-03-10T08:30:00+00:00" },
    ]);
  });

  test("a protected window is busy for everything except an item closing today when unlessDueToday", () => {
    const base = {
      lightsOut: "21:00",
      deadlineDay: {
        sessionMinutes: 60,
        earliestStart: "17:00",
        latestEnd: "21:00",
      },
    };
    const closesToday = [
      candidate({
        id: "paper",
        hard: true,
        due: utc("23:59"),
        minutes: 60,
      }),
    ];

    const open = parseRules({
      ...base,
      protectedWindows: [
        { weekday: 2, from: "18:00", to: "21:00", unlessDueToday: true },
      ],
    });
    expect(
      shapes(planDay(input({ rules: open, candidates: closesToday }))),
    ).toEqual(["session 20:00-21:00"]);

    const shut = parseRules({
      ...base,
      protectedWindows: [
        { weekday: 2, from: "18:00", to: "21:00", unlessDueToday: false },
      ],
    });
    expect(
      shapes(planDay(input({ rules: shut, candidates: closesToday }))),
    ).toEqual(["session 17:00-18:00"]);

    // A plain step never gets the window, whichever flag it carries.
    expect(
      shapes(planDay(input({ rules: open, candidates: [candidate({ id: "a" })] }))),
    ).toEqual(["focus 09:00-09:50"]);
  });
});

describe("behaviour 3: blocks already under way", () => {
  test("behaviour 3: started and done blocks stay put and are busy, and a skipped task is not replanned", () => {
    const started: Block = {
      id: `${DATE}:focus:a`,
      date: DATE,
      start: utc("09:00"),
      end: utc("10:00"),
      kind: "focus",
      lane: null,
      taskId: "a",
      title: "Task a",
      state: "started",
      reason: "lane-next",
    };
    const skipped: Block = {
      id: `${DATE}:focus:c`,
      date: DATE,
      start: utc("11:00"),
      end: utc("11:50"),
      kind: "focus",
      lane: null,
      taskId: "c",
      title: "Task c",
      state: "skipped",
      reason: "lane-next",
    };
    const out = planDay(
      input({
        energy: "good",
        candidates: [
          candidate({ id: "a" }),
          candidate({ id: "b" }),
          candidate({ id: "c" }),
        ],
        existing: [started, skipped],
      }),
    );

    expect(out.blocks.find((b) => b.id === started.id)).toEqual(started);
    expect(out.blocks.filter((b) => b.state === "planned").map((b) => b.taskId)).toEqual(["b"]);
    expect(shape(out.blocks.find((b) => b.taskId === "b") as Block)).toBe(
      "focus 10:10-11:00",
    );
    expect(out.dropped.map((d) => d.candidateId)).not.toContain("c");
    expect(out.removed).toEqual([]);
  });
});

describe("behaviour 4: demand, in order", () => {
  test("behaviour 4: demand follows the list order", () => {
    const rules = parseRules({
      hardWindowHours: 24,
      capacity: { good: { blocks: 6 } },
      incomeTarget: { lane: "lane-income", weeklyHours: 10, blockMinutes: 120 },
      gym: { perWeek: 2, minutes: 60, notBefore: "16:00" },
    });
    const out = planDay(
      input({
        rules,
        energy: "good",
        candidates: [
          candidate({ id: "today", hard: true, due: utc("22:00"), minutes: 60, lane: "lane-degree" }),
          candidate({ id: "soon", hard: true, due: utc("08:00", "2026-03-11"), earlyTouchDone: true, lane: "lane-degree" }),
          candidate({ id: "early", hard: true, due: utc("12:00", "2026-03-13"), lane: "lane-arena" }),
          candidate({ id: "step", lane: "lane-family" }),
          candidate({ id: "quest", kind: "side", expiresAt: utc("09:00", "2026-03-12") }),
        ],
      }),
    );
    expect(
      out.blocks.map((b) => [b.kind, b.taskId, b.reason]),
    ).toEqual([
      ["focus", "soon", "hard-window"],
      ["touch", "early", "early-touch"],
      ["income", null, "income-target"],
      ["focus", "step", "lane-next"],
      ["focus", "quest", "side-quest"],
      ["gym", null, "gym"],
      ["session", "today", "closes-today"],
    ]);
    expect(out.dropped).toEqual([]);
  });

  test("behaviour 4.1: an item closing today gets one session, placed as late as it fits", () => {
    const out = planDay(
      input({
        candidates: [candidate({ id: "paper", hard: true, due: utc("23:59") })],
      }),
    );
    expect(shapes(out)).toEqual(["session 20:00-23:00"]);
    expect(ids(out)).toEqual([`${DATE}:session:paper`]);

    // A shorter estimate shortens the session.
    expect(
      shapes(
        planDay(
          input({
            candidates: [
              candidate({ id: "paper", hard: true, due: utc("23:59"), minutes: 60 }),
            ],
          }),
        ),
      ),
    ).toEqual(["session 22:00-23:00"]);

    // It ends before the closing instant minus the buffer.
    expect(
      shapes(
        planDay(
          input({
            candidates: [
              candidate({ id: "paper", hard: true, due: utc("21:00"), minutes: 60 }),
            ],
          }),
        ),
      ),
    ).toEqual(["session 19:50-20:50"]);
  });

  test("behaviour 4.1: a session that cannot fit its window takes the latest interval before closing", () => {
    const out = planDay(
      input({ candidates: [candidate({ id: "paper", hard: true, due: utc("19:00") })] }),
    );
    expect(shapes(out)).toEqual(["session 15:50-18:50"]);
  });

  test("behaviour 4.2: a hard-window item gets a touch until the early touch is done, then a focus", () => {
    const due = utc("10:00", "2026-03-12");
    expect(
      shapes(planDay(input({ candidates: [candidate({ id: "x", hard: true, due })] }))),
    ).toEqual(["touch 09:00-09:25"]);

    expect(
      shapes(
        planDay(
          input({
            candidates: [
              candidate({ id: "x", hard: true, due, earlyTouchDone: true }),
            ],
          }),
        ),
      ),
    ).toEqual(["focus 09:00-09:50"]);

    expect(
      shapes(
        planDay(
          input({
            candidates: [
              candidate({ id: "x", hard: true, due, earlyTouchDone: true, minutes: 30 }),
            ],
          }),
        ),
      ),
    ).toEqual(["focus 09:00-09:30"]);
  });

  test("behaviour 4.2: hard-window items come earliest closing first and ignore the lane limit", () => {
    const out = planDay(
      input({
        candidates: [
          candidate({ id: "late", hard: true, due: utc("18:00", "2026-03-12"), lane: "lane-degree" }),
          candidate({ id: "early", hard: true, due: utc("09:00", "2026-03-11"), lane: "lane-degree" }),
        ],
      }),
    );
    expect(out.blocks.map((b) => [b.taskId, shape(b)])).toEqual([
      ["early", "touch 09:00-09:25"],
      ["late", "touch 09:35-10:00"],
    ]);
    expect(out.dropped).toEqual([]);
  });

  test("behaviour 4.3: a hard item outside the window but closing within the early-touch days gets a touch", () => {
    const rules = parseRules({ hardWindowHours: 24 });
    expect(
      shapes(
        planDay(
          input({
            rules,
            candidates: [
              candidate({ id: "x", hard: true, due: utc("18:00", "2026-03-12") }),
            ],
          }),
        ),
      ),
    ).toEqual(["touch 09:00-09:25"]);

    // Further out than daysBefore: an ordinary lane step.
    expect(
      shapes(
        planDay(
          input({
            rules,
            candidates: [
              candidate({ id: "x", hard: true, due: utc("18:00", "2026-03-20") }),
            ],
          }),
        ),
      ),
    ).toEqual(["focus 09:00-09:50"]);

    // Already touched: an ordinary lane step.
    expect(
      shapes(
        planDay(
          input({
            rules,
            candidates: [
              candidate({
                id: "x",
                hard: true,
                due: utc("18:00", "2026-03-12"),
                earlyTouchDone: true,
              }),
            ],
          }),
        ),
      ),
    ).toEqual(["focus 09:00-09:50"]);
  });

  test("behaviour 4.4: income fills the weekly target, shrinks to what is left and never goes under standard", () => {
    const rules = parseRules({
      incomeTarget: { lane: "lane-income", weeklyHours: 10, blockMinutes: 120 },
    });
    const run = (hours: number) =>
      shapes(planDay(input({ rules, week: week({ incomeHoursElsewhere: hours }) })));

    expect(run(0)).toEqual(["income 09:00-11:00"]);
    expect(run(9)).toEqual(["income 09:00-10:00"]);
    expect(run(9.5)).toEqual(["income 09:00-09:50"]);
    expect(run(10)).toEqual([]);

    const out = planDay(input({ rules }));
    expect(out.blocks[0].lane).toBe("lane-income");
    expect(out.blocks[0].taskId).toBeNull();
    expect(out.blocks[0].id).toBe(`${DATE}:income:income`);
  });

  test("behaviour 4.4: income is skipped when the cap has less room than the block", () => {
    const rules = parseRules({
      weeklyHourCap: 24,
      incomeTarget: { lane: "lane-income", weeklyHours: 10, blockMinutes: 120 },
    });
    const tight = planDay(input({ rules, week: week({ capHoursElsewhere: 23 }) }));
    expect(tight.blocks).toEqual([]);
    expect(tight.dropped).toEqual([{ candidateId: "income", reason: "cap" }]);

    const roomy = planDay(input({ rules, week: week({ capHoursElsewhere: 20 }) }));
    expect(shapes(roomy)).toEqual(["income 09:00-11:00"]);

    const exempt = parseRules({
      weeklyHourCap: 24,
      capExemptRanges: [{ from: "2026-03-09", to: "2026-03-15" }],
      incomeTarget: { lane: "lane-income", weeklyHours: 10, blockMinutes: 120 },
    });
    expect(
      shapes(planDay(input({ rules: exempt, week: week({ capHoursElsewhere: 23 }) }))),
    ).toEqual(["income 09:00-11:00"]);
  });

  test("behaviour 4.5: one focus block per lane for steps, earliest closing first", () => {
    const out = planDay(
      input({
        energy: "good",
        candidates: [
          candidate({ id: "a1", lane: "lane-a", due: utc("00:00", "2026-04-01") }),
          candidate({ id: "a2", lane: "lane-a", due: utc("00:00", "2026-03-20") }),
          candidate({ id: "b1", lane: "lane-b" }),
        ],
      }),
    );
    expect(out.blocks.map((b) => b.taskId)).toEqual(["a2", "b1"]);
    expect(out.dropped).toEqual([{ candidateId: "a1", reason: "lane-limit" }]);

    const two = parseRules({ maxBlocksPerLanePerDay: 2 });
    const wider = planDay(
      input({
        rules: two,
        energy: "good",
        candidates: [
          candidate({ id: "a1", lane: "lane-a" }),
          candidate({ id: "a2", lane: "lane-a" }),
        ],
      }),
    );
    expect(wider.blocks.map((b) => b.taskId)).toEqual(["a1", "a2"]);
  });

  test("behaviour 4.5: a low day prefers the lowest energy cost", () => {
    const rules = parseRules({
      capacity: { low: { blocks: 1 }, ok: { blocks: 1 } },
    });
    const candidates = [
      candidate({ id: "a-heavy", energyCost: 5 }),
      candidate({ id: "b-light", energyCost: 1 }),
    ];
    expect(
      planDay(input({ rules, energy: "ok", candidates }))
        .blocks.filter((b) => b.kind === "focus")
        .map((b) => b.taskId),
    ).toEqual(["a-heavy"]);
    expect(
      planDay(input({ rules, energy: "low", candidates }))
        .blocks.filter((b) => b.kind === "focus")
        .map((b) => b.taskId),
    ).toEqual(["b-light"]);
  });

  test("behaviour 4.6: side quests go by expiry and a short one is a small block on the small capacity", () => {
    const out = planDay(
      input({
        energy: "low",
        candidates: [
          candidate({ id: "step" }),
          candidate({ id: "s2", kind: "side", minutes: 10, expiresAt: utc("09:00", "2026-03-20") }),
          candidate({ id: "s1", kind: "side", minutes: 10, expiresAt: utc("09:00", "2026-03-12") }),
        ],
      }),
    );
    // The floor outranks the small block, so it takes the start of the window
    // and the side quest follows it.
    expect(out.blocks.map((b) => [b.kind, b.taskId, shape(b)])).toEqual([
      ["floor", "step", "floor 09:00-09:25"],
      ["small", "s1", "small 09:35-09:45"],
    ]);
    expect(out.dropped).toEqual([
      { candidateId: "s2", reason: "capacity" },
    ]);

    // On an ok day there is no small capacity at all.
    const okDay = planDay(
      input({
        candidates: [
          candidate({ id: "s1", kind: "side", minutes: 10 }),
        ],
      }),
    );
    expect(okDay.blocks.map((b) => b.kind)).toEqual(["floor"]);
    expect(okDay.dropped).toEqual([]);
  });

  test("behaviour 4.6: a pinned side quest comes after the ones that expire", () => {
    const out = planDay(
      input({
        energy: "good",
        candidates: [
          candidate({ id: "pinned", kind: "side", pinned: true }),
          candidate({ id: "expiring", kind: "side", expiresAt: utc("09:00", "2026-03-12") }),
        ],
      }),
    );
    expect(out.blocks.map((b) => b.taskId)).toEqual(["expiring", "pinned"]);
  });

  test("behaviour 4.7: the gym lands after notBefore when capacity allows it", () => {
    const rules = parseRules({ gym: { perWeek: 2, minutes: 60, notBefore: "16:00" } });
    const good = planDay(input({ rules, energy: "good" }));
    expect(shapes(good)).toEqual(["gym 16:00-17:00"]);
    expect(good.blocks[0].id).toBe(`${DATE}:gym:gym`);

    expect(planDay(input({ rules, energy: "ok" })).blocks).toEqual([]);
    expect(
      planDay(input({ rules, energy: "good", week: week({ gymSessionsDone: 2 }) })).blocks,
    ).toEqual([]);
    expect(planDay(input({ energy: "good" })).blocks).toEqual([]);
  });

  test("behaviour 4.7: the gym does not spend the block capacity", () => {
    const rules = parseRules({ gym: { perWeek: 2, minutes: 60, notBefore: "16:00" } });
    const out = planDay(
      input({
        rules,
        energy: "good",
        candidates: [
          candidate({ id: "a", lane: "lane-a" }),
          candidate({ id: "b", lane: "lane-b" }),
          candidate({ id: "c", lane: "lane-c" }),
        ],
      }),
    );
    expect(out.blocks.map((b) => b.kind)).toEqual([
      "focus",
      "focus",
      "focus",
      "gym",
    ]);
    expect(out.dropped).toEqual([]);
  });
});

describe("behaviour 5: capacity", () => {
  test("behaviour 5: the first two steps are never dropped for capacity but each spends a unit", () => {
    const out = planDay(
      input({
        candidates: [
          candidate({ id: "today", hard: true, due: utc("23:59"), minutes: 60 }),
          candidate({ id: "soon", hard: true, due: utc("10:00", "2026-03-12") }),
          candidate({ id: "step" }),
          candidate({ id: "quest", kind: "side" }),
        ],
      }),
    );
    expect(out.blocks.map((b) => b.taskId)).toEqual(["soon", "today"]);
    expect(out.dropped).toEqual([
      { candidateId: "step", reason: "capacity" },
      { candidateId: "quest", reason: "capacity" },
    ]);
  });

  test("a done block already spends its capacity unit", () => {
    const done: Block = {
      id: `${DATE}:focus:a`,
      date: DATE,
      start: utc("08:00"),
      end: utc("08:50"),
      kind: "focus",
      lane: "lane-a",
      taskId: "a",
      title: "Task a",
      state: "done",
      reason: "lane-next",
    };
    const out = planDay(
      input({
        candidates: [
          candidate({ id: "a", lane: "lane-a" }),
          candidate({ id: "b", lane: "lane-b" }),
          candidate({ id: "c", lane: "lane-c" }),
        ],
        existing: [done],
      }),
    );
    expect(out.blocks.filter((b) => b.state === "planned").map((b) => b.taskId)).toEqual(["b"]);
    expect(out.dropped).toEqual([{ candidateId: "c", reason: "capacity" }]);
  });

  test("no energy answer is treated as ok and reported as assumed", () => {
    const out = planDay(input({ energy: null }));
    expect(out.energyUsed).toBe("ok");
    expect(out.energyAssumed).toBe(true);
    expect(planDay(input({ energy: "low" })).energyAssumed).toBe(false);
  });
});

describe("behaviour 6: the floor", () => {
  test("behaviour 6: there is always a floor-length block on the top candidate, and none without candidates", () => {
    // Nothing above produced one: a floor block is added.
    const low = planDay(input({ energy: "low", candidates: [candidate({ id: "a" })] }));
    expect(low.blocks.map((b) => [b.kind, b.taskId, shape(b)])).toEqual([
      ["floor", "a", "floor 09:00-09:25"],
    ]);
    expect(low.blocks[0].id).toBe(`${DATE}:floor:a`);
    expect(low.dropped).toEqual([]);

    // Something above produced one: no extra block.
    const ok = planDay(input({ candidates: [candidate({ id: "a" })] }));
    expect(ok.blocks.map((b) => b.kind)).toEqual(["focus"]);

    // No candidates: no floor block.
    expect(planDay(input({})).blocks).toEqual([]);
  });

  test("a candidate whose own estimate is under the floor is not booked twice", () => {
    const out = planDay(
      input({
        candidates: [
          candidate({ id: "pay", hard: true, due: utc("23:59"), minutes: 5 }),
        ],
      }),
    );
    expect(out.blocks.map((b) => [b.kind, shape(b)])).toEqual([
      ["session", "session 22:55-23:00"],
    ]);
    expect(out.dropped).toEqual([]);
  });

  test("behaviour 6: the floor outranks every optional block when one gap is left", () => {
    // One free gap, 12:10 to 12:40. The top candidate's own 50 minute block
    // does not fit it, and a 10 minute side quest would leave too little for
    // the floor, so the gap belongs to the floor.
    const fixed = [
      event({ id: "class", start: utc("08:00"), end: utc("12:00") }),
      event({ id: "shift", start: utc("12:50"), end: utc("23:30") }),
    ];
    const out = planDay(
      input({
        rules: parseRules({ capacity: { good: { small: 1 } } }),
        energy: "good",
        fixed,
        candidates: [
          candidate({ id: "a-top", lane: "lane-a" }),
          candidate({ id: "q", kind: "side", minutes: 10 }),
        ],
      }),
    );
    expect(out.blocks.map((b) => [b.kind, b.taskId, shape(b)])).toEqual([
      ["floor", "a-top", "floor 12:10-12:35"],
    ]);
    expect(out.dropped).toEqual([{ candidateId: "q", reason: "no-room" }]);
    assertNoOverlap(out, fixed);
  });

  test("the hold is given back when the top candidate gets a real block", () => {
    // The same two candidates on an empty day: the top one takes the start of
    // the window itself, so holding a span for the floor costs nothing.
    const out = planDay(
      input({
        rules: parseRules({ capacity: { good: { small: 1 } } }),
        energy: "good",
        candidates: [
          candidate({ id: "a-top", lane: "lane-a" }),
          candidate({ id: "q", kind: "side", minutes: 10 }),
        ],
      }),
    );
    expect(out.blocks.map((b) => [b.kind, b.taskId, shape(b)])).toEqual([
      ["focus", "a-top", "focus 09:00-09:50"],
      ["small", "q", "small 10:00-10:10"],
    ]);
    expect(out.dropped).toEqual([]);
  });

  test("the floor goes to the top candidate, not to whoever fits", () => {
    const out = planDay(
      input({
        energy: "low",
        candidates: [
          candidate({ id: "soon", hard: true, due: utc("10:00", "2026-03-12") }),
          candidate({ id: "step" }),
        ],
      }),
    );
    // The hard-window touch is mandatory but only 25 minutes, which is the
    // floor, so the floor is already met for the top candidate.
    expect(out.blocks.map((b) => [b.kind, b.taskId])).toEqual([
      ["touch", "soon"],
    ]);
    expect(out.dropped).toEqual([{ candidateId: "step", reason: "capacity" }]);
  });
});

describe("behaviour 7: modes", () => {
  test("behaviour 7: short-night and rough-day keep only what closes today and the floor", () => {
    const candidates = [
      candidate({ id: "today", hard: true, due: utc("23:59"), minutes: 60 }),
      candidate({ id: "soon", hard: true, due: utc("10:00", "2026-03-12") }),
      candidate({ id: "step" }),
    ];
    for (const mode of ["short-night", "rough-day"] as const) {
      const out = planDay(input({ mode, energy: "good", candidates }));
      expect(out.blocks.map((b) => [b.kind, b.taskId])).toEqual([
        ["session", "today"],
      ]);
      expect(out.dropped).toEqual([
        { candidateId: "soon", reason: "mode" },
        { candidateId: "step", reason: "mode" },
      ]);
      expect(out.mode).toBe(mode);
    }
  });

  test("behaviour 7: with nothing closing today a light mode is just the floor", () => {
    const out = planDay(
      input({
        mode: "rough-day",
        energy: "good",
        candidates: [candidate({ id: "a" }), candidate({ id: "b" })],
      }),
    );
    expect(out.blocks.map((b) => [b.kind, b.taskId])).toEqual([["floor", "a"]]);
    expect(out.dropped).toEqual([{ candidateId: "b", reason: "mode" }]);
  });

  test("behaviour 7: travel skips the cap and the gym", () => {
    const rules = parseRules({
      weeklyHourCap: 24,
      incomeTarget: { lane: "lane-income", weeklyHours: 10, blockMinutes: 120 },
      gym: { perWeek: 2, minutes: 60, notBefore: "16:00" },
    });
    const travel = planDay(
      input({
        rules,
        mode: "travel",
        energy: "good",
        week: week({ capHoursElsewhere: 23 }),
      }),
    );
    expect(shapes(travel)).toEqual(["income 09:00-11:00"]);
    expect(travel.dropped).toEqual([]);

    const normal = planDay(
      input({ rules, energy: "good", week: week({ capHoursElsewhere: 23 }) }),
    );
    expect(shapes(normal)).toEqual(["gym 16:00-17:00"]);
    expect(normal.dropped).toEqual([{ candidateId: "income", reason: "cap" }]);
  });
});

describe("behaviour 8: placement", () => {
  test("behaviour 8: earliest fit, latest for a session, first fit after notBefore for the gym", () => {
    const rules = parseRules({
      gym: { perWeek: 2, minutes: 60, notBefore: "16:00" },
      capacity: { good: { blocks: 4 } },
    });
    const out = planDay(
      input({
        rules,
        energy: "good",
        candidates: [
          candidate({ id: "today", hard: true, due: utc("23:59"), minutes: 60 }),
          candidate({ id: "a", lane: "lane-a" }),
          candidate({ id: "b", lane: "lane-b" }),
        ],
      }),
    );
    expect(out.blocks.map((b) => [b.taskId ?? b.kind, shape(b)])).toEqual([
      ["a", "focus 09:00-09:50"],
      ["b", "focus 10:00-10:50"],
      ["gym", "gym 16:00-17:00"],
      ["today", "session 22:00-23:00"],
    ]);
  });

  test("behaviour 8: a block needs one unbroken interval, and no fit is a no-room drop", () => {
    const fixed = [
      event({ id: "e1", start: utc("09:40"), end: utc("10:00") }),
      event({ id: "e2", start: utc("10:40"), end: utc("23:00") }),
    ];
    const out = planDay(
      input({
        fixed,
        candidates: [candidate({ id: "a" }), candidate({ id: "b" })],
      }),
    );
    // Only two short gaps are left: 09:00-09:30 and 10:10-10:30.
    expect(out.blocks.map((b) => [b.kind, b.taskId, shape(b)])).toEqual([
      ["floor", "a", "floor 09:00-09:25"],
    ]);
    expect(out.dropped).toEqual([{ candidateId: "b", reason: "no-room" }]);
    assertNoOverlap(out, fixed);
  });
});

describe("behaviour 9: stability", () => {
  const candidates = [
    candidate({ id: "a", lane: "lane-a" }),
    candidate({ id: "b", lane: "lane-b" }),
  ];
  // Plan from before the window opens, so both blocks are still ahead of now
  // and the reservation path is what keeps them, not the held-block rule.
  const early = { now: utc("08:00"), energy: "good" } as const;

  test("behaviour 9: a planned block that is still demanded and still free keeps its time", () => {
    const first = planDay(input({ ...early, candidates }));
    expect(shapes(first)).toEqual(["focus 09:00-09:50", "focus 10:00-10:50"]);

    const again = planDay(
      input({ ...early, candidates, existing: first.blocks }),
    );
    expect(shapes(again)).toEqual(shapes(first));
    expect(again.moved).toEqual([]);
    expect(again.removed).toEqual([]);

    // A new, higher-ranked block does not cascade the kept ones.
    const withHard = planDay(
      input({
        ...early,
        candidates: [
          ...candidates,
          candidate({ id: "soon", hard: true, due: utc("10:00", "2026-03-12") }),
        ],
        existing: first.blocks,
      }),
    );
    expect(withHard.blocks.map((b) => [b.taskId, shape(b)])).toEqual([
      ["a", "focus 09:00-09:50"],
      ["b", "focus 10:00-10:50"],
      ["soon", "touch 11:00-11:25"],
    ]);
    expect(withHard.moved).toEqual([]);
  });

  // A planned block whose moment has come belongs to the caller: it asks about
  // it and sets a state or a new time. The planner leaves it exactly as it is.
  const plannedBlock = (over: Partial<Block> & { start: string; end: string }): Block => ({
    id: over.id ?? `${DATE}:focus:a`,
    date: over.date ?? DATE,
    kind: over.kind ?? "focus",
    lane: over.lane ?? "lane-a",
    taskId: over.taskId ?? "a",
    title: over.title ?? "Task a",
    state: over.state ?? "planned",
    reason: over.reason ?? "lane-next",
    start: over.start,
    end: over.end,
  });

  test("a planned block that has already begun is not moved", () => {
    const begun = plannedBlock({ start: utc("08:30"), end: utc("09:20") });
    const out = planDay(
      input({ energy: "good", candidates, existing: [begun] }),
    );

    expect(out.blocks.find((b) => b.id === begun.id)).toEqual(begun);
    expect(out.moved).toEqual([]);
    expect(out.removed).toEqual([]);
    // Its task is not planned a second time, and it is busy until its end.
    expect(out.blocks.filter((b) => b.taskId === "a")).toHaveLength(1);
    expect(out.blocks.map((b) => [b.taskId, shape(b)])).toEqual([
      ["a", "focus 08:30-09:20"],
      ["b", "focus 09:30-10:20"],
    ]);
  });

  test("a planned block whose end has passed stays and its task is not planned again", () => {
    const over = plannedBlock({ start: utc("07:00"), end: utc("07:50") });
    const out = planDay(input({ energy: "good", candidates, existing: [over] }));

    expect(out.blocks.find((b) => b.id === over.id)).toEqual(over);
    expect(out.moved).toEqual([]);
    expect(out.removed).toEqual([]);
    expect(out.blocks.filter((b) => b.taskId === "a")).toHaveLength(1);
    // It is behind now, so it holds no time: the day starts free.
    expect(out.blocks.map((b) => [b.taskId, shape(b)])).toEqual([
      ["a", "focus 07:00-07:50"],
      ["b", "focus 09:00-09:50"],
    ]);
  });

  test("a future planned block keeps a later time even when an earlier slot is free", () => {
    const moved = plannedBlock({ start: utc("14:00"), end: utc("14:50") });
    const out = planDay(
      input({
        energy: "good",
        candidates: [candidates[0]],
        existing: [moved],
      }),
    );
    expect(out.blocks.map((b) => [b.taskId, shape(b)])).toEqual([
      ["a", "focus 14:00-14:50"],
    ]);
    expect(out.moved).toEqual([]);
    expect(out.removed).toEqual([]);
  });

  test("behaviour 9: a changed start goes in moved and a dropped block goes in removed", () => {
    const first = planDay(input({ ...early, candidates }));
    const blocked = planDay(
      input({
        ...early,
        candidates,
        existing: first.blocks,
        fixed: [event({ start: utc("08:30"), end: utc("09:30") })],
      }),
    );
    expect(blocked.blocks.map((b) => [b.taskId, shape(b)])).toEqual([
      ["b", "focus 10:00-10:50"],
      ["a", "focus 11:00-11:50"],
    ]);
    expect(blocked.moved).toEqual([
      {
        blockId: `${DATE}:focus:a`,
        from: utc("09:00"),
        to: utc("11:00"),
      },
    ]);

    const gone = planDay(
      input({
        ...early,
        candidates: [candidates[0]],
        existing: first.blocks,
      }),
    );
    expect(gone.removed).toEqual([
      { blockId: `${DATE}:focus:b`, reason: "not-demanded" },
    ]);

    const skippedOut = planDay(
      input({
        ...early,
        candidates,
        existing: [
          ...first.blocks,
          {
            ...first.blocks[1],
            id: `${DATE}:small:b`,
            kind: "small",
            state: "skipped",
          },
        ],
      }),
    );
    expect(skippedOut.removed).toEqual([
      { blockId: `${DATE}:focus:b`, reason: "skipped" },
    ]);
  });
});

describe("behaviour 10: ids, order and determinism", () => {
  test("behaviour 10: ids are date, kind and task, blocks are sorted by start and the same input gives the same output", () => {
    const rules = parseRules({
      gym: { perWeek: 2, minutes: 60, notBefore: "16:00" },
      incomeTarget: { lane: "lane-income", weeklyHours: 10, blockMinutes: 120 },
      capacity: { good: { blocks: 5 } },
    });
    const run = () =>
      planDay(
        input({
          rules,
          energy: "good",
          candidates: [
            candidate({ id: "today", hard: true, due: utc("23:59"), minutes: 60 }),
            candidate({ id: "soon", hard: true, due: utc("10:00", "2026-03-12") }),
            candidate({ id: "step", lane: "lane-a" }),
            candidate({ id: "quest", kind: "side", minutes: 10 }),
          ],
        }),
      );
    const out = run();
    expect(ids(out)).toEqual([
      `${DATE}:touch:soon`,
      `${DATE}:income:income`,
      `${DATE}:focus:step`,
      `${DATE}:gym:gym`,
      `${DATE}:session:today`,
    ]);
    const starts = out.blocks.map((b) => Date.parse(b.start));
    expect(starts).toEqual([...starts].sort((x, y) => x - y));
    expect(JSON.stringify(run())).toBe(JSON.stringify(out));
  });
});

describe("behaviour 11: the day being planned, not the clock", () => {
  const TOMORROW = "2026-03-11";

  test("a plan for tomorrow gives an item closing tomorrow its session", () => {
    const paper = candidate({
      id: "paper",
      hard: true,
      due: utc("23:59", TOMORROW),
    });

    const ahead = planDay(input({ date: TOMORROW, candidates: [paper] }));
    expect(ahead.date).toBe(TOMORROW);
    expect(ahead.blocks.map((b) => [b.kind, b.reason, b.date])).toEqual([
      ["session", "closes-today", TOMORROW],
    ]);
    expect(clockOf(ahead.blocks[0].start)).toBe("20:00");
    expect(clockOf(ahead.blocks[0].end)).toBe("23:00");
    expect(Date.parse(ahead.blocks[0].start)).toBe(
      Date.parse(utc("20:00", TOMORROW)),
    );

    // Planned today, the same item is only a hard-window item.
    const today = planDay(input({ candidates: [paper] }));
    expect(today.blocks.map((b) => [b.kind, b.reason])).toEqual([
      ["touch", "hard-window"],
    ]);
  });

  test("a plan for tomorrow measures the hard window from tomorrow's start", () => {
    const rules = parseRules({ hardWindowHours: 24 });
    // 45 hours after now, but 21 hours after tomorrow's window opens.
    const exam = candidate({
      id: "exam",
      hard: true,
      due: utc("06:00", "2026-03-12"),
    });

    const ahead = planDay(input({ date: TOMORROW, rules, candidates: [exam] }));
    expect(ahead.blocks.map((b) => [b.kind, b.reason, b.date])).toEqual([
      ["touch", "hard-window", TOMORROW],
    ]);

    // From now it is outside the window, so today it is only an early touch.
    const today = planDay(input({ rules, candidates: [exam] }));
    expect(today.blocks.map((b) => [b.kind, b.reason, b.date])).toEqual([
      ["touch", "early-touch", DATE],
    ]);
  });

  test("the reference does not slip back across midnight", () => {
    // x and z share a lane, and the lane allows one block a day. x is inside
    // the hard window measured from the planned day's start, which exempts it
    // from that limit. Taking `now` instead whenever it is the same day made
    // the exemption vanish at 00:00 and come back at wake, so x's block was
    // removed and then returned to the very same slot.
    const candidates = [
      candidate({
        id: "x",
        lane: "lane-a",
        hard: true,
        due: "2026-03-14T08:30:00+00:00",
        earlyTouchDone: true,
      }),
      candidate({
        id: "z",
        lane: "lane-a",
        hard: true,
        due: utc("12:00", "2026-03-12"),
        earlyTouchDone: true,
      }),
    ];

    let existing: Block[] = [];
    const seen: string[][] = [];
    for (const now of [
      utc("23:50", "2026-03-10"),
      utc("00:10", TOMORROW),
      utc("08:50", TOMORROW),
      utc("09:30", TOMORROW),
    ]) {
      const out = planDay(
        input({ date: TOMORROW, now, candidates, existing }),
      );
      const x = out.blocks.find((b) => b.taskId === "x");
      seen.push([now, x === undefined ? "gone" : shape(x)]);
      expect(out.removed, now).toEqual([]);
      expect(out.dropped, now).toEqual([]);
      existing = out.blocks;
    }
    expect(seen).toEqual([
      [utc("23:50", "2026-03-10"), "focus 10:00-10:50"],
      [utc("00:10", TOMORROW), "focus 10:00-10:50"],
      [utc("08:50", TOMORROW), "focus 10:00-10:50"],
      [utc("09:30", TOMORROW), "focus 10:00-10:50"],
    ]);
  });
});

describe("whole-day invariants", () => {
  test("a day filled with fixed events has no overlap and explains every drop", () => {
    const fixed = [
      event({ id: "class", start: utc("08:00"), end: utc("14:00") }),
      event({ id: "shift", start: utc("14:20"), end: utc("23:30"), countsTowardCap: true }),
    ];
    const candidates = [
      candidate({ id: "today", hard: true, due: utc("23:59") }),
      candidate({ id: "soon", hard: true, due: utc("10:00", "2026-03-12") }),
      candidate({ id: "step", lane: "lane-a" }),
      candidate({ id: "quest", kind: "side" }),
    ];
    const out = planDay(input({ energy: "good", fixed, candidates }));

    expect(out.blocks).toEqual([]);
    expect(out.dropped).toEqual([
      { candidateId: "today", reason: "no-room" },
      { candidateId: "soon", reason: "no-room" },
      { candidateId: "step", reason: "no-room" },
      { candidateId: "quest", reason: "no-room" },
    ]);
    assertNoOverlap(out, fixed);

    // Every candidate is accounted for exactly once.
    const covered = [
      ...out.blocks.map((b) => b.taskId),
      ...out.dropped.map((d) => d.candidateId),
    ].filter((id): id is string => id !== null);
    expect([...covered].sort()).toEqual(
      candidates.map((c) => c.id).sort(),
    );
  });

  test("a busy day still places what it can and never overlaps", () => {
    const fixed = [
      event({ id: "class", start: utc("10:00"), end: utc("12:00") }),
      event({ id: "lesson", start: utc("13:00"), end: utc("15:00") }),
      event({ id: "shift", start: utc("18:00"), end: utc("22:00"), countsTowardCap: true }),
    ];
    const candidates = [
      candidate({ id: "soon", hard: true, due: utc("10:00", "2026-03-12") }),
      candidate({ id: "step-a", lane: "lane-a" }),
      candidate({ id: "step-b", lane: "lane-b" }),
    ];
    const out = planDay(input({ energy: "good", fixed, candidates }));
    expect(shapes(out)).toEqual([
      "touch 09:00-09:25",
      "focus 15:10-16:00",
      "focus 16:10-17:00",
    ]);
    assertNoOverlap(out, fixed);
  });

  // A hand-written expectation can only be wrong in the same way the code is.
  // This sweep asserts the properties instead, over a seeded spread of days.
  test("every generated day keeps the invariants, and replanning it changes nothing", () => {
    // Two rule sets, so the sweep reaches the early touch (which the default
    // 72 hour window hides) and days with no room at all.
    const ruleSets = [
      parseRules({
        weeklyHourCap: 24,
        incomeTarget: { lane: "lane-income", weeklyHours: 10, blockMinutes: 120 },
        gym: { perWeek: 2, minutes: 60, notBefore: "16:00" },
        protectedWindows: [
          { weekday: 2, from: "18:00", to: "20:00", unlessDueToday: true },
        ],
        travel: [
          {
            calendarId: null,
            locationIncludes: "campus",
            minutesBefore: 20,
            minutesAfter: 20,
          },
        ],
      }),
      parseRules({
        hardWindowHours: 24,
        weeklyHourCap: 24,
        capacity: { ok: { small: 2 }, good: { small: 2 } },
        incomeTarget: { lane: "lane-income", weeklyHours: 10, blockMinutes: 120 },
      }),
    ];
    const window = dayWindow(DATE, ruleSets[0]);
    const energies = [null, "low", "ok", "good"] as const;
    const modes = ["normal", "short-night", "rough-day", "travel"] as const;

    // mulberry32: a tiny deterministic generator, so a failure is reproducible.
    let state = 0x9e3779b9;
    const random = () => {
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const pick = <T>(list: readonly T[]): T =>
      list[Math.floor(random() * list.length)];
    const hhmm = (minutes: number) =>
      `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(
        minutes % 60,
      ).padStart(2, "0")}`;

    for (let round = 0; round < 120; round++) {
      const rules = ruleSets[round % ruleSets.length];
      const fixed: FixedEvent[] = [];
      for (let i = 0; i < Math.floor(random() * 6); i++) {
        const start = 8 * 60 + Math.floor(random() * 13) * 30;
        fixed.push(
          event({
            id: `fixed-${i}`,
            start: utc(hhmm(start)),
            end: utc(hhmm(Math.min(start + 30 + Math.floor(random() * 8) * 30, 1439))),
            location: random() < 0.3 ? "Campus" : null,
            countsTowardCap: random() < 0.3,
            allDay: random() < 0.1,
          }),
        );
      }
      const candidates: Candidate[] = [];
      for (let i = 0; i < Math.floor(random() * 7); i++) {
        const hard = random() < 0.5;
        candidates.push(
          candidate({
            id: `task-${i}`,
            kind: random() < 0.3 ? "side" : "step",
            lane: pick([null, "lane-a", "lane-b", "lane-income"]),
            hard,
            due: hard
              ? pick([
                  utc("22:00"),
                  utc("12:00", "2026-03-11"),
                  utc("12:00", "2026-03-13"),
                  utc("12:00", "2026-03-30"),
                ])
              : null,
            minutes: pick([null, 5, 10, 30, 90]),
            energyCost: pick([null, 1, 3, 5] as const),
            expiresAt: random() < 0.5 ? utc("09:00", "2026-03-20") : null,
            pinned: random() < 0.2,
            earlyTouchDone: random() < 0.5,
          }),
        );
      }
      const base = input({
        rules,
        fixed,
        candidates,
        energy: pick(energies),
        mode: pick(modes),
        week: week({
          capHoursElsewhere: Math.floor(random() * 26),
          incomeHoursElsewhere: Math.floor(random() * 12),
          gymSessionsDone: Math.floor(random() * 3),
        }),
      });
      const out = planDay(base);
      const where = `round ${round}`;

      assertNoOverlap(out, fixed);
      for (const block of out.blocks) {
        expect(Date.parse(block.end), where).toBeGreaterThan(
          Date.parse(block.start),
        );
        expect(Date.parse(block.start), where).toBeGreaterThanOrEqual(
          Math.max(window.startMs, Date.parse(NOW)),
        );
        expect(Date.parse(block.end), where).toBeLessThanOrEqual(window.endMs);
        expect(block.id, where).toBe(
          `${DATE}:${block.kind}:${block.taskId ?? block.kind}`,
        );
      }

      // Every candidate is either on the day or explained, never both.
      for (const c of candidates) {
        const onDay = out.blocks.some((b) => b.taskId === c.id);
        const explained = out.dropped.some((d) => d.candidateId === c.id);
        expect(onDay !== explained, `${where}: ${c.id}`).toBe(true);
      }
      for (const entry of out.dropped) {
        expect(entry.reason, where).not.toBe("");
      }

      // Replanning the same day is a no-op.
      const again = planDay({ ...base, existing: out.blocks });
      expect(again.blocks, where).toEqual(out.blocks);
      expect(again.moved, where).toEqual([]);
      expect(again.removed, where).toEqual([]);
      expect(JSON.stringify(planDay(base)), where).toBe(JSON.stringify(out));
    }
  });

  // The sweep above varies the inputs at one instant. This one varies the
  // clock: it walks `now` across two days in ten minute steps, replanning the
  // current day and tomorrow's draft off their own last output. It is what
  // catches a classification that slips backwards as time passes, which is how
  // a block came to be removed at midnight and returned at wake.
  test("replanning every ten minutes across two days never oscillates", () => {
    const rules = parseRules({
      gym: { perWeek: 2, minutes: 60, notBefore: "16:00" },
      incomeTarget: { lane: "lane-income", weeklyHours: 10, blockMinutes: 120 },
      capacity: { good: { blocks: 4, small: 1 } },
    });
    const candidates = [
      // Two hard items on one lane: the lane limit bites unless the hard
      // window exempts them, which is the classification that used to slip.
      candidate({
        id: "x",
        lane: "lane-a",
        hard: true,
        due: "2026-03-14T08:30:00+00:00",
        earlyTouchDone: true,
      }),
      candidate({
        id: "z",
        lane: "lane-a",
        hard: true,
        due: utc("12:00", "2026-03-12"),
        earlyTouchDone: true,
      }),
      candidate({
        id: "t",
        lane: "lane-c",
        hard: true,
        due: utc("20:00", "2026-03-13"),
      }),
      candidate({ id: "s", lane: "lane-b" }),
      candidate({ id: "q", kind: "side", minutes: 10 }),
    ];
    const fixed = [
      event({ id: "class-10", start: utc("10:00"), end: utc("12:00") }),
      event({
        id: "shift-11",
        start: utc("14:00", "2026-03-11"),
        end: utc("18:00", "2026-03-11"),
        countsTowardCap: true,
      }),
    ];

    const state = new Map<string, Block[]>();
    // Each date remembers every block id it has removed. Nothing about this
    // walk changes except the clock, and the reference instant only ever moves
    // forward, so a block that leaves the plan has no way back: a return is
    // oscillation, whether or not it lands on its old slot. (Asserting only
    // the old slot is too weak to catch it, because the blocks after the gap
    // shift earlier to fill it and the returning one then lands elsewhere.)
    const gone = new Map<string, Set<string>>();

    const first = Date.parse(utc("04:00"));
    const last = Date.parse(utc("04:00", "2026-03-12"));
    for (let ms = first; ms <= last; ms += 10 * 60_000) {
      const now = new Date(ms).toISOString();
      const todayKey = zonedDateKey(ms, "UTC");
      for (const date of [todayKey, zonedDateKey(ms + 86_400_000, "UTC")]) {
        const existing = state.get(date) ?? [];
        const out = planDay(
          input({ date, now, rules, energy: "good", fixed, candidates, existing }),
        );
        const where = `${now} planning ${date}`;

        const ids = out.blocks.map((b) => b.id);
        expect(new Set(ids).size, where).toBe(ids.length);
        assertNoOverlap(out, fixed);
        for (const block of out.blocks) {
          expect(Date.parse(block.end), where).toBeGreaterThan(
            Date.parse(block.start),
          );
        }

        const history = gone.get(date) ?? new Set<string>();
        for (const block of out.blocks) {
          expect(
            history.has(block.id),
            `${where}: ${block.id} came back after being removed`,
          ).toBe(false);
        }
        for (const entry of out.removed) history.add(entry.blockId);
        gone.set(date, history);
        state.set(date, out.blocks);
      }
    }

    // The walk has to have produced something, or it proves nothing.
    expect((state.get(DATE) ?? []).length).toBeGreaterThan(0);
    expect((state.get("2026-03-11") ?? []).length).toBeGreaterThan(0);
  });

  test("works in UTC, America/Phoenix and Asia/Tokyo", () => {
    const offsets = {
      UTC: "+00:00",
      "America/Phoenix": "-07:00",
      "Asia/Tokyo": "+09:00",
    };
    const seen = new Set<string>();
    for (const [zone, offset] of Object.entries(offsets)) {
      const rules = parseRules({
        timeZone: zone,
        gym: { perWeek: 2, minutes: 60, notBefore: "16:00" },
      });
      const out = planDay(
        input({
          rules,
          now: `${DATE}T09:00:00${offset}`,
          energy: "good",
          candidates: [
            candidate({
              id: "today",
              hard: true,
              due: `${DATE}T23:59:00${offset}`,
              minutes: 60,
            }),
            candidate({ id: "step", lane: "lane-a" }),
          ],
        }),
      );
      expect(
        out.blocks.map(
          (b) =>
            `${b.kind} ${zonedClock(Date.parse(b.start), zone)}-${zonedClock(
              Date.parse(b.end),
              zone,
            )}`,
        ),
      ).toEqual(["focus 09:00-09:50", "gym 16:00-17:00", "session 22:00-23:00"]);
      seen.add(out.blocks[0].start);
    }
    // The same wall clock in three zones is three different instants.
    expect(seen.size).toBe(3);
  });
});
